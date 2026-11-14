import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLab, freezeLab, repairLab, verifyLab } from '../lib/lab.mjs';

const card = { key: 'js-nullish-default', title: '设置默认值时怎样保留有效的 0？', rule: '只在输入缺失时使用备用值' };
const cases = [
  { name: 'zero', input: 0, control: 5, variant: 0 },
  { name: 'null', input: null, control: 5, variant: 5 },
  { name: 'positive', input: 9, control: 9, variant: 9 },
];
const plan = { question: card.title, change: '对比 || 与 ??', runtime: 'node', cases };
const source = `const value = JSON.parse(process.argv[3]);
const result = process.argv[2] === "control" ? (value || 5) : (value ?? 5);
console.log(JSON.stringify(result));`;
const mutation = { find: 'value ?? 5', replace: 'value || 5' };

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'honor-lab-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('new concept goes through two model steps and real Node controls, mutation and tamper check', async t => {
  const root = await scratch(t);
  const prompts = [];
  const complete = async prompt => {
    prompts.push(prompt);
    return JSON.stringify(prompts.length === 1 ? plan : { source, mutation });
  };
  const lab = await createLab(card, root, { complete });
  assert.equal(prompts.length, 2);
  assert.equal(lab.status, 'generated');
  assert.equal(lab.verified, false);
  const report = await verifyLab(lab.directory);
  assert.equal(report.verified, true, JSON.stringify(report));
  assert.equal(report.checks.length, 9);
  assert.equal(JSON.parse(await readFile(report.reportPath)).verified, true);
  await writeFile(join(lab.directory, 'experiment.mjs'), source.replace('value ?? 5', 'value || 5') + '\n// value ?? 5');
  const broken = await verifyLab(lab.directory);
  assert.equal(broken.verified, false);
  const frozen = await readFile(join(lab.directory, 'plan.json'), 'utf8');
  const fixed = await repairLab(lab.directory, {report:broken, complete:async prompt => {
    assert.match(prompt, /A|zero/);
    return JSON.stringify({ source, mutation, plan:{cases:[]} });
  }});
  assert.equal(fixed.verified, false);
  assert.equal(await readFile(join(lab.directory,'plan.json'),'utf8'),frozen);
  assert.equal((await verifyLab(lab.directory)).verified,true);
  await assert.rejects(() => repairLab(lab.directory, {report:broken, complete:async () => '{}'}),/失败报告/);
  await writeFile(join(lab.directory, 'plan.json'), JSON.stringify({...plan, change:'改题'}));
  assert.equal((await verifyLab(lab.directory)).verified, false);
  await assert.rejects(() => freezeLab(lab.directory), /已经冻结/);
});

test('manual creation, invalid plans and arbitrary directory rejection', async t => {
  const root = await scratch(t);
  await assert.rejects(() => verifyLab(root));
  const a = await createLab(card, root);
  const b = await createLab(card, root);
  assert.notEqual(a.directory, b.directory);
  assert.equal(a.status, 'draft');
  await writeFile(join(a.directory, 'plan.json'), JSON.stringify({...plan, runtime: 'sh'}));
  await assert.rejects(() => freezeLab(a.directory), /runtime/);
  await writeFile(join(a.directory, 'plan.json'), JSON.stringify({...plan, cases:[cases[0],cases[0]]}));
  await assert.rejects(() => freezeLab(a.directory), /名称/);
  await writeFile(join(a.directory, 'plan.json'), JSON.stringify(plan));
  await freezeLab(a.directory);
  await writeFile(join(a.directory, 'experiment.mjs'), 'while (true) {}\n// ' + mutation.find);
  await writeFile(join(a.directory, 'mutation.json'), JSON.stringify(mutation));
  const slow = await verifyLab(a.directory, {timeoutMs:100});
  assert.equal(slow.verified, false);
  assert.match(slow.error, /超时/);
});

test('second runtime executes a SQLite outer join with an unmatched left row', async t => {
  const root = await scratch(t);
  const sample = {
    question:'怎样保留零订单的客户？', change:'移动右表谓词', runtime:'python',
    cases:[{name:'zero',input:0,control:0,variant:1},{name:'two',input:2,control:2,variant:2}],
  };
  const code = `import sqlite3, sys, json
n = json.loads(sys.argv[2])
c = sqlite3.connect(':memory:')
c.executescript("CREATE TABLE customer(id);INSERT INTO customer VALUES(1);CREATE TABLE orders(customer, paid);")
c.executemany("INSERT INTO orders VALUES(1, 1)", [() for _ in range(n)])
tail = "WHERE o.paid=1" if sys.argv[1] == "control" else "AND o.paid=1"
print(c.execute("SELECT COUNT(*) FROM customer c LEFT JOIN orders o ON c.id=o.customer " + tail).fetchone()[0])`;
  const change = {find:'"AND o.paid=1"',replace:'"WHERE o.paid=1"'};
  const lab = await createLab({key:'sql-outer-join',title:sample.question},root);
  await writeFile(join(lab.directory,'plan.json'), JSON.stringify(sample));
  await freezeLab(lab.directory);
  await writeFile(join(lab.directory,'experiment.py'),code);
  await writeFile(join(lab.directory,'mutation.json'),JSON.stringify(change));
  const report = await verifyLab(lab.directory);
  assert.equal(report.verified,true,JSON.stringify(report));
});
