import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureQueue } from '../lib/host-queue.mjs';
import { apply } from '../lib/plugin.mjs';

test('capture queue replaces stale in-flight work, persists failed evidence and handles replay', async t=>{
  const directory = await mkdtemp(join(tmpdir(),'honor-queue-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const db = join(directory,'queue.sqlite');
  let queue = new CaptureQueue(db);
  queue.put('session/1',2,[{code:'one'}],null,'test');
  const old = queue.next();
  queue.put('session/1',3,[{code:'two'}],null,'test');
  queue.put('session/1',2,[{code:'replay'}],null,'test');
  assert.equal(queue.owns(old),false);
  queue.done(old);
  let current = queue.next();
  assert.equal(current.source.code,'two');
  queue.fail(current,'try later',false);
  queue.close();
  queue = new CaptureQueue(db);
  try {
    assert.equal(queue.status().pendingRetry,1);
    assert.equal(queue.retry(),1);
    current = queue.next();
    assert.equal(current.source.code,'two');
    queue.done(current);
    assert.equal(queue.status().queued,0);
    queue.put('session/1',3,[{code:'duplicated'}],null,'test');
    assert.equal(queue.next(),undefined);
  } finally { queue.close(); }
});

test('host waits for diff publication, picks active model, captures new code and returns teaching material',async t=>{
  const directory = await mkdtemp(join(tmpdir(),'honor-hook-'));
  const previousDb = process.env.HUMAN_HONOR_DB;
  process.env.HUMAN_HONOR_DB = join(directory,'honor.sqlite');
  t.after(async()=>{
    if (previousDb === undefined) delete process.env.HUMAN_HONOR_DB;
    else process.env.HUMAN_HONOR_DB = previousDb;
    await rm(directory,{recursive:true,force:true});
  });
  const hooks = new Map(), tools = new Map(), errors = [];
  const session = {id:'hook-test',header:{cwd:directory}};
  const exec = {signal:new AbortController().signal,agent:{session}};
  const source = 'value = sorted(items)';
  const card = {key:'sort-copy',title:'如何生成排序副本？',rule:'sorted 返回新列表。',conditions:'Python 列表',topic:'Python',evidence:source};
  let published=false, clean, modelCalls=0;
  const ctx = {
    logger:{warn:message=>errors.push(message)}, inject:()=>{},
    on:(name,fn)=>hooks.set(name,fn), effect:factory=>{clean=factory();},
    tools:{register:tool=>tools.set(tool.name,tool)},
    workspaceChanges:{
      summary:()=>published ? {cwd:directory,turn:1,files:[{path:'source.py'}]} : undefined,
      diff:async()=>({kind:'text',hunks:[{newStart:3,lines:['+'+source]}]}),
    },
    llm:{async prepareCall(route){
      assert.deepEqual(route,{provider:'mock',model:'lesson-mock'});
      return {config:route,async *stream(opts){
        modelCalls++;
        assert.equal(opts.sessionId,session.id);
        assert.ok(opts.messages[0].content[0].text.includes(source));
        yield {type:'block-end',block:{type:'text',text:JSON.stringify({cards:[card]})}};
        yield {type:'finish',reason:{kind:'stop'}};
      }};
    }},
  };
  apply(ctx);
  t.after(()=>clean());
  const event = hooks.get('session/event');
  event(session,{type:'request/header',data:{header:{config:{provider:'mock',model:'lesson-mock'}}}});
  event(session,{type:'workspace/changes',seq:9});
  published = true;
  let result;
  for (let i=0;i<100;i++) {
    result = await tools.get('honor_list').execute({},exec);
    if (result.total) break;
    await delay(40);
  }
  assert.equal(result.total,1,errors.join('\n'));
  assert.equal(modelCalls,1);
  const detail = await tools.get('honor_learn').execute({key:'sort-copy'},exec);
  assert.equal(detail.card.sources[0].evidence,source);
  assert.ok(detail.teachingPrompt);
  await tools.get('honor_mark').execute({key:'sort-copy',status:'known'},exec);
  assert.equal((await tools.get('honor_list').execute({},exec)).total,0);
});
