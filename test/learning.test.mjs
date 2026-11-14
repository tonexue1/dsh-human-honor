import test from 'node:test';
import assert from 'node:assert/strict';
import { extract, readTeachingPrompt } from '../lib/learning.mjs';

const sql = 'UPDATE note SET body = ?, version = version + 1 WHERE id = ? AND version = ?;';
const source = { project: 'notes', path: 'save.sql', revision: 'snap', code: sql };
const js = `async function search(term) {
  const requestId = ++latestId;
  const value = await fetchValue(term);
  if (requestId !== latestId) return;
  render(value);
}`;
const modelCard = { key: 'deferred-close', title: '何时关闭文件？', rule: '在当前作用域退出时执行已推迟的关闭操作。',
  conditions: '注册了关闭操作，且函数正常退出。', topic: 'Go/资源管理', evidence: 'defer f.Close()' };
const go = { path: 'read.go', kind: 'import', code: 'func scan(f *os.File) { defer f.Close(); read(f) }' };

test('SQL recognizes conditional increment in one statement, including parameterized host code', async () => {
  for (const item of [source, { path: 'repo.py', code: `cursor.execute("${sql}", args)` },
    { path: 'repo.ts', code: "db.run('UPDATE docs SET revision = revision + 1 WHERE revision = :old AND id = :id', row)" }]) {
    const [card] = await extract(item);
    assert.equal(card.key, 'sql-version-guard');
    assert.equal(card.demo, card.key);
    assert.ok(item.code.includes(card.evidence));
  }
});

test('offline SQL ignores comments, strings, plain updates, and non-exclusive predicates', async () => {
  for (const code of [sql.replace(' AND version = ?', ''), sql.replace('AND version', 'OR version'),
    sql.replace('version = version + 1', 'version = 1'), '-- ' + sql, "SELECT '" + sql.slice(0,-1) + "';",
    'UPDATE docs SET version=version+1 WHERE id=? AND version=? OR status=2;']) {
    assert.deepEqual(await extract({ ...source, code }), [], code);
  }
});

test('SQL embedded in an executable host string is distinct from a commented-out example', async () => {
  assert.deepEqual(await extract({ path: 'db.py', code: '# db.execute("' + sql + '")' }), []);
  assert.deepEqual(await extract({ path: 'db.ts', code: '/* db.exec("' + sql + '") */' }), []);
  const [card] = await extract({ path: 'db.py', code: 'db.execute("""\n' + sql + '\n""")' });
  assert.equal(card.key, 'sql-version-guard');
});

test('JS recognizes linked increment and asynchronous guard, rejects wrong identifiers and comments', async () => {
  const [card] = await extract({ path: 'search.ts', code: js });
  assert.equal(card.key, 'js-latest-request');
  assert.ok(js.includes(card.evidence));
  for (const code of [js.replace('requestId !== latestId', 'other !== latestId'),
    js.replace('await ', ''), '/*' + js + '*/', js.replace('if (requestId !== latestId) return;', 'if (requestId !== latestId) console.log(1);')]) {
    assert.deepEqual(await extract({ path:'search.ts', code }), []);
  }
});

test('unknown materials can yield no knowledge and unchanged content is not sent to model', async () => {
  assert.deepEqual(await extract({ path: 'x.ts', code: 'export const n = 1;' }), []);
  const complete = () => { throw new Error('should not call model'); };
  assert.deepEqual(await extract({ ...source, before: sql }, { complete }), []);
  assert.deepEqual(await extract({ ...source, before: sql + '\n-- Other line' }), []);
});

test('general language extraction accepts an independently evidenced model card, and shows reuse candidates', async () => {
  const complete = async prompt => {
    assert.match(prompt, /defer f.Close\(\)/);
    assert.match(prompt, /deferred-close/);
    return '```json\n' + JSON.stringify({cards: [{...modelCard, demo: '/opt/unknown-script'}]}) + '\n```';
  };
  const cards = await extract(go, { complete, known: [modelCard] });
  assert.deepEqual(cards, [modelCard]);
});

test('invalid model results fail visibly and semantic key collisions cannot silently update mastery', async () => {
  for (const data of ['bad', '{}', 'null', {cards: [{...modelCard, key: 'not/path'}]},
    {cards: [{...modelCard, evidence: 'missing()'}]}, {cards: [{...modelCard, conditions: '   '}]},
    {cards: [{...modelCard, rule: '发生了别的事'}]}]) {
    await assert.rejects(extract(go, {
      known: [modelCard], complete: async () => typeof data === 'string' ? data : JSON.stringify(data),
    }));
  }
  await assert.rejects(extract(go, {complete: async () => {throw new Error('provider offline');}}), /provider offline/);
});

test('teaching prompt includes human choices, evidence, and explicit mastery', () => {
  const text = readTeachingPrompt();
  for (const part of ['直接讲', '带我推', '跑 Demo', '实际运行', '明确选择']) assert.ok(text.includes(part));
});

test('a deleted expression can still ground a model lesson in its recorded before-image', async () => {
  const deleted = { ...go, before: go.code, code: '' };
  const [card] = await extract(deleted, {
    complete: async prompt => {
      assert.ok(prompt.includes(go.code));
      return JSON.stringify({ cards: [modelCard] });
    },
  });
  assert.equal(card.evidence, modelCard.evidence);
});
