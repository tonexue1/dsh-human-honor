import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../lib/store.mjs'

const source = {
  project: 'alpha', revision: 'abc123', kind: 'diff', path: 'db.js',
  before: 'UPDATE docs SET body=? WHERE id=?',
  code: 'UPDATE docs SET body=?, version=version+1 WHERE id=? AND version=?'
}
const card = {
  key: 'sql-version-guard', title: '基于版本的条件更新', conditions: ['存在多个写入者'],
  topic: '数据库/并发', rule: 'UPDATE 检查打开时的版本，匹配失败不会覆盖新稿。',
  evidence: 'WHERE id=? AND version=?', demo: 'sql-version-guard'
}

test('重复投递和更新提取器保留同一出处。空提取也会被缓存', (t) => {
  const db = openStore(':memory:')
  t.after(() => db.close())
  assert.equal(db.hasAnalyzed(source), false)
  assert.deepEqual(db.ingest(source, [card]), { cached: false, addedConcepts: 1, addedSources: 1 })
  assert.deepEqual(db.ingest(source, [card]), { cached: true, addedConcepts: 0, addedSources: 0 })
  assert.equal(db.hasAnalyzed(source, '2'), false)
  assert.deepEqual(db.ingest(source, [card], '2'), { cached: false, addedConcepts: 0, addedSources: 0 })
  assert.deepEqual(db.get(card.key).sources, [{
    project: 'alpha', revision: 'abc123', kind: 'diff', path: 'db.js', evidence: card.evidence, side: 'after'
  }])
  const empty = { ...source, code: 'return 1' }
  db.ingest(empty, [])
  assert.equal(db.hasAnalyzed(empty), true)
  assert.equal(db.get(card.key).sourceCount, 1)
  assert.equal(db.hasAnalyzed({ ...empty, before: 'return 0' }), false)
})

test('跨仓库同一规律汇总两个出处且保留个人确认的状态；新边界独立入箱', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'honor-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'nested', 'knowledge.sqlite')
  const first = openStore(file)
  first.ingest(source, [card])
  first.setStatus(card.key, 'later')
  assert.deepEqual(first.list(), [])
  first.setStatus(card.key, 'known')
  first.close()
  const db = openStore(file)
  t.after(() => db.close())
  const second = { ...source, project: 'beta', path: 'notes.py', revision: 'def456' }
  const extra = { ...card, key: 'new-boundary', rule: '另一个保证', evidence: 'version=version+1' }
  const observedAgain = { ...card, title: '新措辞' }
  assert.deepEqual(db.ingest(second, [observedAgain, extra]), { cached: false, addedConcepts: 1, addedSources: 2 })
  assert.deepEqual(db.counts(), { inbox: 1, later: 0, known: 1, all: 2 })
  assert.deepEqual(db.list().map(item => item.key), ['new-boundary'])
  assert.equal(db.get(card.key).rule, card.rule)
  assert.deepEqual(db.get(card.key).conditions, card.conditions)
  assert.deepEqual(db.get(card.key).sources.map(s => s.project), ['alpha', 'beta'])
  assert.equal(db.setStatus(card.key, 'inbox').status, 'inbox')
})

test('新证据可以引用被删除的那一侧；编造出处会回滚整批', (t) => {
  const db = openStore(':memory:')
  t.after(() => db.close())
  const old = { ...card, key: 'old-version', evidence: source.before }
  assert.throws(() => db.ingest(source, [old, { ...card, evidence: 'something else' }]), /Evidence/)
  assert.equal(db.hasAnalyzed(source), false)
  assert.deepEqual(db.list('all'), [])
  db.ingest(source, [old])
  assert.equal(db.get(old.key).sources[0].side, 'before')
  assert.equal(db.get('missing'), null)
  assert.throws(() => db.setStatus('missing', 'known'), /Unknown knowledge key/)
  assert.throws(() => db.setStatus(old.key, 'anything'), /Unknown knowledge status/)
  assert.deepEqual(db.search('条件更新').map(c => c.key), [old.key])
  assert.equal(db.search('update', 'inbox')[0].key, old.key)
  assert.deepEqual(db.search('%'), [])
})

test('同名但条件变化时禁止静默套用旧卡的掌握状态', (t) => {
  const db = openStore(':memory:')
  t.after(() => db.close())
  db.ingest(source, [card])
  db.setStatus(card.key, 'known')
  const newer = { ...source, project: 'beta' }
  const changed = { ...card, conditions: '单个进程中的本地变量' }
  assert.throws(() => db.ingest(newer, [changed]), /Rule or conditions differ/)
  assert.equal(db.hasAnalyzed(newer), false)
  assert.equal(db.get(card.key).sourceCount, 1)
  db.ingest(newer, [{ ...changed, key: 'different-boundary' }])
  assert.equal(db.get('different-boundary').status, 'inbox')
})

test('两个打开的连接重放同一输入只能建设一次', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'honor-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const one = openStore(join(dir, 'shared.sqlite'))
  const two = openStore(join(dir, 'shared.sqlite'))
  t.after(() => { one.close(); two.close() })
  assert.equal(two.hasAnalyzed(source), false)
  one.ingest(source, [card])
  assert.equal(two.ingest(source, [card]).cached, true)
  assert.equal(one.get(card.key).sourceCount, 1)
})

test('导入仓库时只重算实际变化的文件，未变文件仍指向真实来源提交', (t) => {
  const db = openStore(':memory:')
  t.after(() => db.close())
  const first = { ...source, kind: 'repository' }
  db.ingest(first, [card])
  const later = { ...first, revision: '123def' }
  assert.equal(db.hasAnalyzed(later), true)
  assert.equal(db.ingest(later, [card]).cached, true)
  assert.equal(db.get(card.key).sources[0].revision, 'abc123')
  assert.equal(db.hasAnalyzed({ ...later, code: 'another value' }), false)
})

test('小库给足所有候选，大库以源码符号/条件和中文主题召回，再用近期知识补足', (t) => {
  const db = openStore(':memory:')
  t.after(() => db.close())
  db.ingest({ ...source, code: 'queue.enqueueUniqueTask(stableId)' }, [{
    ...card, key: 'unique-work', topic: '任务/幂等投递', title: '用唯一任务标识避免重复创建',
    conditions: '重试可能重复到达', evidence: 'queue.enqueueUniqueTask(stableId)'
  }])
  assert.deepEqual(db.candidates(source).map(item => item.key), ['unique-work'])
  for (let i = 0; i < 45; i++) {
    db.ingest({ ...source, code: 'print(' + i + ')' }, [{
      ...card, key: 'case-' + i, topic: '打印输出', conditions: '脚本输出',
      rule: '显示结果', title: '案例 ' + i, evidence: 'print(' + i + ')'
    }])
  }
  const candidates = db.candidates({ path: 'x.py', code: 'scheduler.enqueue_unique_task(ids)' }, 3)
  assert.deepEqual(candidates.map(item => item.key), ['unique-work', 'case-44', 'case-43'])
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['conditions','key','rule','title','topic'])
  assert.equal(db.candidates({ path: 'x', code: '幂等问题' }, 1)[0].key, 'unique-work')
  assert.equal(db.candidates({ path: 'x', code: '重试' }, 1)[0].key, 'unique-work')
  assert.equal(db.candidates(source).length, 36)
  assert.throws(() => db.candidates(source, 500), /limit/)
})
