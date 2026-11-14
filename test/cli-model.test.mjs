import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/human-honor.mjs', import.meta.url));

test('CLI constructs a third concept, observes a failing result, repairs it and runs again',async t=>{
  const dir = await mkdtemp(join(tmpdir(),'honor-model-cli-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db = join(dir,'state.sqlite');
  const store = openStore(db);
  const expression = 'console.log(value ?? 10)';
  store.ingest({project:'sample',path:'defaults.js',code:expression},[{
    key:'nullish-default',title:'默认值怎样保留有效的零？',topic:'JS/表达式',
    rule:'?? 只在左侧为空值时取默认值。',conditions:'数字或空值。',evidence:expression,
  }]);
  store.close();
  const plan = {runtime:'node',question:'遇到 0 时使用哪个值？',change:'仅切换默认值运算符',
    cases:[{name:'zero',input:0,control:10,variant:0},{name:'null',input:null,control:10,variant:10}]};
  const program = `const x=JSON.parse(process.argv[3]); const y=process.argv[2]==='control' ? x||10 : x??10; console.log(JSON.stringify(y))`;
  const mutation = {find:'x??10',replace:'x||10'};
  const requests = [];
  const server = createServer(async(req,res)=>{
    let body=''; for await(const chunk of req) body+=chunk;
    requests.push(JSON.parse(body));
    const stages = [plan,{source:program.replace(' : x??10',' : (x??10)||10'),mutation},{source:program,mutation}];
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(stages[requests.length-1])}}]}));
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {port}=server.address();
  const {stdout}=await exec(process.execPath,[cli,'demo','nullish-default','--run','--json','--out',dir],{
    env:{...process.env,HUMAN_HONOR_DB:db,HUMAN_HONOR_CHAT_URL:'http://127.0.0.1:'+port,
      HUMAN_HONOR_MODEL:'fixture'},timeout:25000});
  const report=JSON.parse(stdout);
  assert.equal(report.verified,true);
  assert.equal(requests.length,3);
  assert.equal(report.checks.length,6);
  assert.deepEqual(JSON.parse(await readFile(report.directory+'/plan.json','utf8')),plan);
});
