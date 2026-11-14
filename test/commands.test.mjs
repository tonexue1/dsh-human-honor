import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCommands } from '../lib/commands.mjs';
import { openStore } from '../lib/store.mjs';

function commandTest(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  for (const key of ['parent', 'child']) {
    const source = { path: key + '.sql', project: 'test', revision: 'rev1', code: 'SELECT 1' };
    store.ingest(source, [{ key, title: key + ' 小实验', rule: '返回一个值', conditions: 'SQL', topic:
      key === 'parent' ? '数据库' : '数据库/查询', evidence: 'SELECT 1' }]);
  }
  let definition;
  const disposer = () => {};
  assert.equal(registerCommands({ commands: { register(spec) { definition = spec; return disposer; } } }, store), disposer);
  assert.equal(definition.name, 'honor');
  return (rawInput = '') => definition.handler({ rawInput });
}

test('command registry supports no-model human actions, source inspection and restoring state', t => {
  const run = commandTest(t);
  assert.match(run().text, /child 小实验/);
  assert.equal(run(' known child').kind, 'success');
  assert.doesNotMatch(run(' list').text, /child 小实验/);
  assert.match(run(' list known').text, /child 小实验/);
  const view = run('show child');
  assert.match(view.text, /SELECT 1/);
  assert.match(view.text, /child.sql/);
  assert.equal(run('later child').kind, 'success');
  assert.match(run('list later').text, /child 小实验/);
  assert.equal(run('inbox child').kind, 'success');
  assert.match(run('list').text, /child 小实验/);
});

test('topic tree nests multi-level classifications and search accepts a multiword query', t => {
  const run = commandTest(t);
  assert.match(run('tree').text, /数据库\n  · .*parent 小实验.*\n  查询\n    · .*child 小实验/);
  assert.match(run('search child 小实验').text, /child 小实验/);
  for (const input of ['list __proto__', 'show missing', 'known', 'later child extra', 'search', 'tree bad']) {
    assert.equal(run(input).kind, 'error');
  }
});

test('headless profiles can omit the commands service', () => {
  assert.equal(registerCommands({}, null), undefined);
});
