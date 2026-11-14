// DSH_CLI=/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js node scripts/smoke-dsh.mjs
// Packs and installs into a fresh web profile, then mounts THAT package in real host services.
// The turn driver and model response are deterministic so no network credentials are required.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const cli = process.env.DSH_CLI;
if (!cli) throw new Error('请将 DSH_CLI 指向已安装的 @deepseek-ai/dsh/lib/bin.js');
const anchor = await realpath(resolve(cli));
const requireFromDsh = createRequire(anchor);
const host = name => import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/' + name)).href);
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'human-honor-host-'));
const project = join(temp, 'work');
const home = join(temp, 'host');
const db = join(temp, 'state', 'knowledge.sqlite');
process.env.DSH_HOME = home;
process.env.HUMAN_HONOR_DB = db;
process.env.HUMAN_HONOR_DEMOS = join(temp, 'labs');
let ctx;
try {
  await mkdir(project);
  const npm = process.env.npm_execpath;
  const packArgs = ['pack', '--ignore-scripts', '--json', '--pack-destination', temp];
  const packed = await execute(npm ? process.execPath : 'npm', npm ? [npm, ...packArgs] : packArgs, { cwd: root });
  const archive = join(temp, JSON.parse(packed.stdout)[0].filename);
  await execute(process.execPath, [anchor, 'plugin', '--profile', 'web', 'add', archive], { timeout: 90000 });
  const profile = join(home, 'profiles', 'web');
  const profileRequire = createRequire(join(profile, 'package.json'));
  const installed = await import(pathToFileURL(profileRequire.resolve('dsh-human-honor')));
  const profileConfig = await readFile(join(profile, 'package.json'), 'utf8');
  assert.match(profileConfig, /dsh-human-honor/);

  const [{ Context }, { default: Sessions }, { default: Subprocess }, { default: Fs },
    { default: SystemPrompt }, { default: Tools }, workspaceChanges, llm] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-subprocess-local', 'dsh-fs-local', 'dsh-system-prompt',
    'dsh-tools', 'dsh-workspace-changes', 'dsh-llm',
  ].map(host));
  const sql = 'UPDATE notes SET body = ?, version = version + 1 WHERE id = ? AND version = ?;';
  const route = { provider: 'honor-fixture', model: 'smoke' };
  let requests = 0;
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      const content = options.messages[0].content[0].text;
      assert.ok(content.includes(sql));
      requests++;
      const text = JSON.stringify({cards:[{key:'fixture-version-match',title:'怎样把旧版本限制作为写入条件？',
        rule:'在更新时匹配版本；不匹配的记录不会被更新。',conditions:'带版本的更新操作。',
        topic:'数据库/更新', evidence:sql.slice(0,-1)}]});
      yield {type:'text-delta',index:0,text};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx = new Context();
  for (const [plugin, config] of [[Sessions], [Subprocess], [Fs,{cwd:project}], [SystemPrompt],
    [Tools], [llm.default], [workspaceChanges], [(await host('dsh-commands')).default], [installed]]) await ctx.plugin(plugin, config);
  const batchTools = typeof ctx.tools.setExecutor === 'function';
  if (batchTools) await ctx.plugin(await host('dsh-tool-executor-native'));
  assert.ok(ctx.tools.get('honor_list'), '插件未注册模型工具');
  ctx.llm.registerAdapter([route.provider], new Adapter());

  await execute('git', ['init','-q'], { cwd:project });
  const session = ctx.sessions.create('honor-smoke', {meta:{cwd:project}});
  session.append('turn/start', {turn:1});
  session.append('step/start', {turn:1,step:1});
  const agent = {session};
  const args = JSON.stringify({file_path:'save.sql', content:sql});
  const call = {type:'tool-call',id:'edit-1',name:'write',arguments:args};
  session.append('assistant/message', {stream:[],turn:1,step:1,
    message:llm.createAssistantMessage({content:[call],source:route})}, {surfaceOp:'append'});
  const callEvent = session.append('tool/call', {turn:1,step:1,callId:call.id,name:call.name,arguments:args});
  await ctx.waterfall('tools/pre-execute', {agent}, () => Promise.resolve());
  await writeFile(join(project,'save.sql'), sql+'\n');
  session.append('tool/result',{turn:1,step:1,message:llm.createToolResultMessage({callId:call.id,
    content:[{type:'text',text:'written'}],isError:false})},{surfaceOp:'append',sourceEventSeqs:[callEvent.seq]});
  await ctx.parallel('agent/turn-stopping', {agent,turn:1});
  session.append('step/end',{turn:1,step:1});
  session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  await ctx.waterfall('tools/pre-execute', {agent}, () => Promise.resolve());
  const changed = session.snapshotEvents().find(e=>e.type==='workspace/changes');
  assert.ok(changed, '真实工作区 Recorder 未生成 workspace/changes');
  assert.equal(ctx.workspaceChanges.summary(session.id, changed.seq).files[0].path,'save.sql');

  let number = 0;
  async function runTool(name, args) {
    const id = 'smoke-'+(++number);
    const signal = AbortSignal.timeout(25000);
    const result = batchTools
      ? (await ctx.tools.execute({calls:[{type:'tool-call',name,id,arguments:JSON.stringify(args)}],signal})).results[0].result
      : await ctx.tools.execute({name,arguments:args,callId:id,signal});
    assert.ok(!result.isError,JSON.stringify(result));
    return result.value ?? JSON.parse(result.content[0].text);
  }
  let listing;
  const until = Date.now()+12000;
  do {
    listing = await runTool('honor_list',{status:'all'});
    if (listing.cards.some(card=>card.key==='fixture-version-match')) break;
    await delay(100);
  } while(Date.now()<until);
  assert.ok(requests>0, '宿主没有调用测试模型适配器');
  assert.ok(listing.cards.some(card=>card.key==='fixture-version-match'),JSON.stringify(listing));
  assert.ok(listing.cards.some(card=>card.key==='sql-version-guard'));
  const result = await runTool('honor_demo',{key:'sql-version-guard'});
  assert.equal(result.verified,true,JSON.stringify(result));
  await runTool('honor_mark',{key:'sql-version-guard',status:'known'});
  assert.ok((await runTool('honor_list',{status:'known'})).cards.some(c=>c.key==='sql-version-guard'));
  const shown = await ctx.commands.execute(agent,'/honor show sql-version-guard',[],AbortSignal.timeout(5000));
  assert.equal(shown?.result.kind,'success',JSON.stringify(shown));
  assert.match(shown.result.text,/save\.sql/);
  const moved = await ctx.commands.execute(agent,'/honor later sql-version-guard',[],AbortSignal.timeout(5000));
  assert.equal(moved?.result.kind,'success');
  assert.ok((await runTool('honor_list',{status:'later'})).cards.some(c=>c.key==='sql-version-guard'));
  const version = JSON.parse(await readFile(requireFromDsh.resolve('@deepseek-ai/dsh/package.json'),'utf8')).version;
  console.log('DSH '+version+'：临时 web profile 安装、Cordis 注册、真实 workspace/changes、宿主模型服务调用测试适配器、知识库查询、/honor 命令、标记与独立 SQL 实验均通过。');
} finally {
  if (ctx) await ctx.fiber.dispose();
  await rm(temp,{recursive:true,force:true});
}
