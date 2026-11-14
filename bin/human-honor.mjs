#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openStore } from '../lib/store.mjs';
import { databasePath, demoRoot } from '../lib/paths.mjs';
import { readChanges, readRepository } from '../lib/sources.mjs';
import { extract, readTeachingPrompt } from '../lib/learning.mjs';
import { runDemo, recipeIds } from '../lib/demo.mjs';
import { createLab, freezeLab, verifyLab } from '../lib/lab.mjs';
import { cliModel } from '../lib/completion.mjs';

const usage = `人类荣耀 · 本地学习工作台

  human-honor changes [本地仓库] [--staged]
  human-honor import <本地仓库或 HTTPS Git URL> [--ref 版本] [--subpath 相对路径]
  human-honor list [inbox|known|later|all]       查看个人知识库
  human-honor tree [inbox|known|later|all]       按主题浏览
  human-honor search <词语>                     查找知识与出处
  human-honor show <知识ID>                     阅读规律、适用条件与来源
  human-honor learn <知识ID> [--guide]          结合源码讲解或引导预测
  human-honor mark <知识ID> <known|later|inbox>  我会了 / 稍后学 / 放回待判断
  human-honor demo <知识ID> [--out 目录] [--run]         构建实验，已有配方直接运行
  human-honor lab-freeze <实验目录>              冻结新实验的观察条件
  human-honor lab-verify <实验目录>              执行该实验中的本地程序
  human-honor recipes                           查看已验证的内置配方
全局选项：--db <数据库路径>、--json、--help。`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    run: { type: 'boolean' }, guide: { type: 'boolean' }, staged: { type: 'boolean' }, ref: { type: 'string' },
    subpath: { type: 'string' }, out: { type: 'string' },
  },
});
const [action, subject, status] = positionals;
const labels = { inbox: '待判断', known: '已掌握', later: '稍后学' };

function need(value, what) {
  if (!value) throw new Error('缺少' + what + '，运行 --help 查看用法。');
  return value;
}

function output(data, human) {
  console.log(values.json ? JSON.stringify(data, null, 2) : human);
}

function showList(cards) {
  if (!cards.length) return '没有符合条件的知识点。';
  return cards.map(card =>
    '[' + labels[card.status] + '] ' + card.title + '\n  ' + card.topic + ' · ' + card.key + ' · ' + card.sourceCount + ' 处来源'
  ).join('\n');
}

async function analyze(store) {
  const model = cliModel();
  const input = action === 'changes' ? subject || '.' : need(subject, '仓库');
  const batch = action === 'changes'
    ? await readChanges(input, { staged: values.staged, subpath: values.subpath })
    : await readRepository(input, { ref: values.ref, subpath: values.subpath });
  const totals = { analyzed: 0, reused: 0, addedConcepts: 0, addedSources: 0 };
  const errors = [];
  for (const source of batch.sources) {
    try {
      if (store.hasAnalyzed(source, model.version)) { totals.reused++; continue; }
      const cards = await extract(source, { complete: model.complete, known: model.complete ? store.candidates(source) : [] });
      const result = store.ingest(source, cards, model.version);
      totals.analyzed++;
      totals.addedConcepts += result.addedConcepts;
      totals.addedSources += result.addedSources;
    } catch (error) {
      errors.push(source.path + '：' + error.message);
    }
  }
  const result = { ...totals, project: batch.project, revision: batch.revision, mode: model.complete ? 'model' : 'offline', warnings: batch.warnings, skipped: batch.skipped, errors };
  const summary = `分析 ${totals.analyzed} 份，复用 ${totals.reused} 份。新增 ${totals.addedConcepts} 个知识点、${totals.addedSources} 处来源。`;
  output(result, [summary, model.complete ? '已使用配置的模型。' : '离线模式仅识别两种内置机制。', ...(batch.warnings || []), ...errors].join('\n'));
  if (errors.length) process.exitCode = 1;
}

async function main() {
  if (!action || values.help) { console.log(usage); return; }
  if (action === 'recipes') { output(recipeIds, recipeIds.join('\n')); return; }
  if (action === 'lab-freeze' || action === 'lab-verify') {
    const directory = resolve(need(subject, '实验目录'));
    const report = action === 'lab-freeze' ? await freezeLab(directory) : await verifyLab(directory);
    output(report, JSON.stringify(report, null, 2));
    if (action === 'lab-verify' && !report.verified) process.exitCode = 1;
    return;
  }
  const store = openStore(values.db ? resolve(values.db) : databasePath());
  try {
    if (['changes', 'import'].includes(action)) { await analyze(store); return; }
    if (action === 'tree') {
      const groups = Object.groupBy(store.list(subject || 'all'), card => card.topic);
      output(groups, Object.entries(groups).map(([topic, cards]) => topic + '\n' + cards.map(c => '  [' + labels[c.status] + '] ' + c.title + ' · ' + c.key).join('\n')).join('\n\n') || '知识库为空。');
      return;
    }
    if (action === 'list' || action === 'search') {
      if (action === 'list' && subject && ![...Object.keys(labels), 'all'].includes(subject)) throw new Error('未知列表状态');
      const cards = action === 'list' ? store.list(subject || 'inbox') : store.search(need(subject, '搜索词'));
      output(cards, showList(cards)); return;
    }
    if (!['mark', 'show', 'learn', 'demo'].includes(action)) throw new Error('未知命令：' + action);
    const key = need(subject, '知识 ID');
    const card = store.get(key);
    if (!card && !(action === 'demo' && recipeIds.includes(key))) throw new Error('找不到知识点：' + key);
    if (action === 'mark') {
      if (!Object.hasOwn(labels, status)) throw new Error('状态应为 known、later 或 inbox。');
      output(store.setStatus(key, status), card.title + ' → ' + labels[status]); return;
    }
    if (action === 'demo') {
      const recipe = card?.demo || key;
      const outDir = resolve(values.out || demoRoot());
      if (recipeIds.includes(recipe)) {
        const result = await runDemo(recipe, { outDir });
        output(result, [result.verified ? '行为验证通过' : '行为验证失败', result.directory, result.reportPath, result.error].filter(Boolean).join('\n'));
        if (!result.verified) process.exitCode = 1;
      } else {
        const { complete } = cliModel();
        const lab = await createLab(card, outDir, { complete });
        if (!values.run || lab.status !== 'generated') {
          output(lab, [lab.directory, lab.instructions].join('\n'));
          if (values.run && lab.status === 'draft') process.exitCode = 1;
          return;
        }
        let report = await verifyLab(lab.directory);
        if (!report.verified) {
          const { repairLab } = await import('../lib/lab.mjs');
          await repairLab(lab.directory, { complete, report });
          report = await verifyLab(lab.directory);
        }
        output(report, [report.verified ? '行为验证通过' : '行为验证失败', report.directory, report.reportPath, report.error].filter(Boolean).join('\n'));
        if (!report.verified) process.exitCode = 1;
      }
      return;
    }
    const conditions = Array.isArray(card.conditions) ? card.conditions.join('；') : card.conditions;
    const references = card.sources.map(s => s.project + ' / ' + s.path + (s.revision ? ' @ ' + s.revision : '') + '\n' + s.evidence).join('\n\n');
    if (action === 'show') {
      output(card, [card.title, card.rule, '适用条件：' + conditions, references].join('\n\n')); return;
    }
    const model = cliModel();
    let explanation;
    if (model.complete) {
      const excerpt = card.sources.slice(0, 3).map(({ path, evidence }) => ({ path, evidence }));
      const material = { title: card.title, rule: card.rule, conditions, excerpt };
      explanation = await model.complete(readTeachingPrompt() + '\n用户选择：' + (values.guide ? '引导预测，只问第一步' : '直接讲') + '\n教材数据：' + JSON.stringify(material));
    } else {
      explanation = values.guide
        ? card.title + '\n\n' + card.sources[0].evidence + '\n\n先预测：移除上面这段代码中的关键条件，结果会怎样变化？'
        : card.title + '\n\n' + card.rule + '\n适用条件：' + conditions + '\n\n回看原代码：\n' + card.sources[0].evidence;
    }
    output({ key, explanation }, explanation);
  } finally { store.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
