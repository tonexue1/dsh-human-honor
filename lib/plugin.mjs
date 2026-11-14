import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { registerCommands } from './commands.mjs';
import { CaptureQueue } from './host-queue.mjs';
import { openStore } from './store.mjs';
import { extract, readTeachingPrompt } from './learning.mjs';
import { databasePath, demoRoot } from './paths.mjs';
import { runDemo, recipeIds } from './demo.mjs';
import { createLab } from './lab.mjs';
import { readRepository, isSourcePath, localRoot, containsSensitiveText } from './sources.mjs';

export const name = 'dsh-human-honor';
export const inject = ['tools', 'llm', 'workspaceChanges'];

function under(root, target) {
  const path = relative(root,target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..'+sep);
}

function modelRoute(config) {
  return config?.provider && config?.model ? {provider:config.provider,model:config.model} : null;
}

function completion(llm, route, sessionId, lifetime) {
  if (!route) return undefined;
  return async prompt => {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(90000)]);
    const call = await llm.prepareCall(route,signal,(controls,model)=>({
      ...controls, maxTokens:Math.min(4000, model.maxTokens ?? 4000),
      ...(model.reasoning?.efforts?.length ? {reasoningEffort:model.reasoning.efforts[0].id} : {}),
    }));
    const text = new Map();
    let finish;
    const options = {...call.config, sessionId, signal, messages:[{role:'user',content:[{type:'text',text:prompt}]}]};
    for await (const chunk of call.stream(options)) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') text.set(chunk.index,(text.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'block-end' && chunk.block.type === 'text') text.set(chunk.index,chunk.block.text);
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    signal.throwIfAborted();
    if (finish?.kind !== 'stop') throw new Error('教学模型未正常完成：'+(finish?.kind ?? '无结束事件'));
    return [...text.entries()].sort(([a],[b])=>a-b).map(([,value])=>value).join('\n');
  };
}

export function apply(ctx) {
  const dbPath = databasePath();
  const store = openStore(dbPath);
  const queue = new CaptureQueue(dbPath+'.queue');
  ctx.inject(['commands'], commandCtx => registerCommands(commandCtx,store));
  const lifetime = new AbortController();
  const routes = new WeakMap();
  const captures = new Set();
  let draining;

  async function drain() {
    while (!lifetime.signal.aborted) {
      const job = queue.next();
      if (!job) return;
      try {
        const version = job.route ? 'dsh-1-'+JSON.stringify(job.route) : 'offline-1';
        if (!store.hasAnalyzed(job.source,version)) {
          const cards = await extract(job.source,{
            complete: completion(ctx.llm,job.route,job.session,lifetime.signal),
            known: job.route ? store.candidates(job.source) : [],
          });
          lifetime.signal.throwIfAborted();
          if (queue.owns(job)) store.ingest(job.source,cards,version);
        }
        queue.done(job);
      } catch (error) {
        queue.fail(job,error.message,lifetime.signal.aborted);
        if (!lifetime.signal.aborted) ctx.logger.warn('人类荣耀解析失败，已保留材料：'+error.message);
      }
    }
  }
  function wake() {
    if (lifetime.signal.aborted || draining) return;
    draining = drain().catch(error=>ctx.logger.warn('人类荣耀解析队列：'+error.message))
      .finally(()=>{draining = undefined;});
  }
  const tick = setInterval(wake,2000);
  tick.unref();
  wake();

  async function capture(session,event) {
    // WorkspaceChanges appends synchronously BEFORE it publishes the summary under event.seq.
    await Promise.resolve();
    if (lifetime.signal.aborted) return;
    const summary = ctx.workspaceChanges.summary(session.id,event.seq);
    if (!summary) return;
    const sources = [];
    for (const [index,file] of summary.files.entries()) {
      if (file.binary || file.oversized || !isSourcePath(file.path)) continue;
      const absolute = resolve(summary.cwd,file.path);
      if (!under(summary.cwd,absolute) || under(demoRoot(),absolute)) continue;
      const diff = await ctx.workspaceChanges.diff(session.id,event.seq,index,lifetime.signal);
      if (diff?.kind !== 'text') continue;
      if (diff.hunks.some(hunk=>hunk.lines.some(line=>containsSensitiveText(line.slice(1))))) continue;
      for (const hunk of diff.hunks) {
        const side = prefix => hunk.lines.filter(line=>line[0] === ' ' || line[0] === prefix)
          .map(line=>line.slice(1)).join('\n');
        const code = side('+'), before = side('-');
        if (code === before || (!code.trim() && !before.trim())) continue;
        sources.push({kind:'dsh',project:summary.cwd,path:file.path,code,before,
          revision:summary.snapshot?.after || String(session.id)+'/turn-'+summary.turn+'@'+event.seq,
          line:hunk.newStart});
      }
    }
    lifetime.signal.throwIfAborted();
    queue.put(JSON.stringify([session.id,summary.turn]),event.seq,sources,routes.get(session),String(session.id), Date.now()+1000);
  }
  ctx.on('session/event',(session,event)=>{
    const route = event.type === 'request/header' ? modelRoute(event.data.header?.config)
      : event.type === 'assistant/message' ? modelRoute(event.data.message?.source) : null;
    if (route) routes.set(session,route);
    if (event.type !== 'workspace/changes') return;
    const task = capture(session,event).catch(error=>{
      if (!lifetime.signal.aborted) ctx.logger.warn('人类荣耀未能读取本轮差异：'+error.message);
    }).finally(()=>captures.delete(task));
    captures.add(task);
  });

  const key = {type:'string',description:'知识点的 key，由 honor_list 返回'};
  const status = {type:'string',enum:['inbox','later','known']};
  function register(name,description,properties,required,run) {
    ctx.tools.register({name,description,parameters:{type:'object',properties,required,additionalProperties:false},
      output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      async execute(args,exec){ exec.signal.throwIfAborted(); return await run(args,exec); }});
  }
  function getCard(key) {
    const card = store.get(key);
    if (!card) throw new Error('找不到该知识点：'+key);
    return card;
  }
  register('honor_list','查看人类荣耀知识库；默认仅列新知识，支持搜索和状态过滤。',{status:{type:'string',enum:['inbox','later','known','all']},query:{type:'string'}},[],args=>{
    const cards = args.query ? store.search(args.query,args.status ?? 'all') : store.list(args.status ?? 'inbox');
    return {total:cards.length,cards:cards.slice(0,100),queue:queue.status()};
  });
  register('honor_mark','用户明确表示已会、想稍后学或希望重新学习时，更新这条知识的状态。',{key,status},['key','status'],args=>{
    getCard(args.key);
    store.setStatus(args.key,args.status);
    return {key:args.key,status:args.status};
  });
  register('honor_learn','读取单条知识的学习材料和原代码证据，按照返回的教学提示继续本次对话。',{key},['key'],args=>({
    card:getCard(args.key),teachingPrompt:readTeachingPrompt(),
  }));
  register('honor_demo','为所选知识准备学习实验。内置实验实际运行并提供报告；其他知识生成独立草稿并给出后续操作。',{key},['key'],async(args,exec)=>{
    const card = getCard(args.key);
    if (recipeIds.includes(card.demo)) return runDemo(card.demo,{outDir:demoRoot()});
    const session = exec.agent?.session;
    const complete = completion(ctx.llm,routes.get(session),session?.id,AbortSignal.any([exec.signal,lifetime.signal]));
    const lab = await createLab(card,demoRoot(),{complete});
    return {...lab,verifyCommand:[process.execPath,fileURLToPath(new URL('../bin/human-honor.mjs',import.meta.url)),'lab-verify',lab.directory],
      nextStep:'用户已要求运行时，先在草稿中补齐实现，再立即通过 DSH 原生终端按 verifyCommand 的参数执行。遵循当前工作区权限，检查实际报告；失败则基于报告修复实验实现并复跑，保持验收条件。'};
  });
  register('honor_import','将当前会话工作目录内的 Git 仓库或指定子目录作为学习材料，排队解析已提交源码。',{subpath:{type:'string',description:'相对于当前 Git 仓库的路径，可省略'}},[],async(args,exec)=>{
    const session = exec.agent?.session;
    if (!session?.header?.cwd) throw new Error('当前会话没有工作目录');
    const project = await realpath(session.header.cwd);
    const target = await realpath(resolve(project,args.subpath ?? '.'));
    if (!under(project,target)) throw new Error('请选择当前工作目录内的路径');
    const repository = await localRoot((await stat(target)).isDirectory() ? target : dirname(target));
    const result = await readRepository(repository,{subpath:relative(repository,target) || undefined});
    exec.signal.throwIfAborted();
    queue.put('import:'+randomUUID(),1,result.sources,routes.get(session),String(session.id));
    wake();
    return {project:result.project,revision:result.revision,queued:result.sources.length,
      warnings:result.warnings ?? [],skipped:result.skipped ?? 0};
  });
  register('honor_retry','重新处理此前解析失败的材料。',{},[],()=>{
    const queued = queue.retry();
    wake();
    return {queued};
  });
  ctx.effect(()=>async()=>{
    lifetime.abort();
    clearInterval(tick);
    await Promise.allSettled([...captures,...(draining ? [draining] : [])]);
    queue.close();
    store.close();
  });
}
