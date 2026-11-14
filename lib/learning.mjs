import { readFileSync } from 'node:fs';

const extractPrompt = readFileSync(new URL('../prompts/extract.md', import.meta.url), 'utf8');
const teachingPrompt = readFileSync(new URL('../prompts/teach.md', import.meta.url), 'utf8');

export function readTeachingPrompt() {
  return teachingPrompt;
}

const recipes = [
  {
    key: 'sql-version-guard',
    title: '两个编辑者从同一旧版本保存时，怎样阻止迟到的修改覆盖新内容？',
    rule: '把期望版本放在 UPDATE 的 WHERE 条件里，并在同一语句中递增版本。前一次写入成功后，仍使用旧版本的写入将匹配零行。',
    conditions: '修改同一条记录时各写入者都检查原版本并推进版本，调用方需要处理零行更新。',
    topic: '数据库/并发更新',
    detect: sqlVersionEvidence,
  },
  {
    key: 'js-latest-request',
    title: '后发请求先返回时，怎样避免较老的响应覆盖当前结果？',
    rule: '为每次请求保存递增序号，收到结果时只让仍与最新序号匹配的请求写入当前状态。',
    conditions: '多个请求更新同一份状态，目标是保留最新发起的请求，编号需要在共享范围内唯一。',
    topic: '异步编程/响应顺序',
    detect: latestRequestEvidence,
  },
];

function sqlVersionEvidence(code, path) {
  // Inspect individual SQL statements. Quoted SQL in Python/JavaScript is a
  // common source; a separate string literal is a separate candidate.
  const isSQL = /\.sql$/i.test(path);
  // Scan strings and comments together so a quoted example in a commented-out
  // host statement cannot create an occurrence. Backreferences preserve the
  // delimiter for ordinary as well as Python triple-quoted SQL strings.
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\#[^\n]*|("""|'''|["'`])(?:\\[\s\S]|(?!\1)[\s\S])*?\1/g;
  const rawStatements = isSQL ? [code] : [];
  if (!isSQL) {
    for (const token of code.matchAll(tokens)) {
      const quote = token[1];
      if (!quote) continue;
      const contents = token[0].slice(quote.length, -quote.length);
      if (/^\s*UPDATE\b/i.test(contents)) rawStatements.push(contents);
    }
  }
  for (const text of rawStatements) {
    for (const raw of text.split(';')) {
      // Replacing values and comments preserves source formatting and offsets.
      const sql = raw.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'/g,
        match => ' '.repeat(match.length));
      const update = /\bUPDATE\s+[\w.]+\s+SET\b([\s\S]+?)\bWHERE\b([\s\S]+)/i.exec(sql);
      if (!update) continue;
      const bump = /\b((?:lock_)?version|revision)\s*=\s*\1\s*\+\s*1\b/i.exec(update[1]);
      if (!bump || /\b(?:OR|NOT|SELECT)\b/i.test(update[2])) continue;
      const check = new RegExp('(?:^|\\bAND\\b)\\s*' + bump[1] +
        '\\s*=\\s*(?:\\?(?:\\d+)?|[:@$]\\w+|%s)(?=\\s*(?:$|\\)|\\bAND\\b|\\bRETURNING\\b))', 'i');
      if (check.test(update[2])) return raw.slice(update.index, update.index + update[0].length).trimEnd();
    }
  }
  return null;
}

function latestRequestEvidence(code, path) {
  if (!/\.(?:[cm]?[jt]sx?|vue|svelte|html?)$/i.test(path)) return null;
  const masked = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    value => ' '.repeat(value.length));
  const captures = masked.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*\+\+\s*([\w$]+(?:\.[\w$]+)*)/g);
  for (const capture of captures) {
    const start = capture.index;
    const tail = masked.slice(start + capture[0].length, start + 1600);
    const conditions = tail.matchAll(/\bif\s*\(\s*([\w$.]+)\s*(===|!==)\s*([\w$.]+)\s*\)\s*(\{\s*)?/g);
    for (const guard of conditions) {
      const [, left, op, right] = guard;
      const [id, latest] = capture.slice(1);
      if (!(left === id && right === latest || left === latest && right === id)) continue;
      if (!/\bawait\b|\.then\s*\(/.test(tail.slice(0, guard.index))) continue;
      const action = tail.slice(guard.index + guard[0].length).trimStart();
      if (op === '!==' && !/^return\b/.test(action)) continue;
      if (op === '===' && !/^(?:[\w$.]+\s*=(?!=)|(?:render|set|update|display|show|apply)[\w$]*\s*\()/i.test(action)) continue;
      const end = start + capture[0].length + guard.index + guard[0].length;
      const nextLine = code.indexOf('\n', end);
      return code.slice(start, nextLine === -1 ? code.length : nextLine).trimEnd();
    }
  }
  return null;
}

const fieldLimits = { title: 300, rule: 1500, conditions: 1200, topic: 200, evidence: 4500 };
const keyFormat = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function catalogCard({ key, title, rule, conditions, topic }) {
  return { key, title, rule, conditions, topic };
}

function validateCards(text, source, catalog) {
  if (typeof text !== 'string') throw new TypeError('模型提取结果必须是 JSON 文本');
  const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i, '$1');
  const result = JSON.parse(json);
  const items = Array.isArray(result) ? result : result?.cards;
  if (!Array.isArray(items) || items.length > 8) throw new Error('模型结果必须包含最多八项的 cards 数组');
  return items.map(item => {
    if (!item || typeof item.key !== 'string' || item.key.length > 100 || !keyFormat.test(item.key)) {
      throw new Error('无效的知识点 key');
    }
    const card = { key: item.key };
    for (const [field, limit] of Object.entries(fieldLimits)) {
      if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > limit) {
        throw new Error(`知识点 ${card.key} 的 ${field} 为空或过长`);
      }
      card[field] = field === 'evidence' ? item[field] : item[field].trim();
    }
    if (!source.code.includes(card.evidence) && !source.before?.includes(card.evidence)) throw new Error(`知识点 ${card.key} 的证据没有逐字出现在源码中`);
    const existing = catalog.get(card.key);
    if (existing && (existing.rule !== card.rule || existing.conditions !== card.conditions)) {
      throw new Error(`知识点 ${card.key} 的规律或适用条件发生变化，请保留现有定义或另建 key`);
    }
    // Bind only recipes shipped with the host. A model cannot select a new executable.
    if (recipes.some(recipe => recipe.key === card.key)) card.demo = card.key;
    return card;
  });
}

/** Analyze one after-image or diff hunk. complete(prompt) returns plain JSON text. */
export async function extract(source, { complete, known = [] } = {}) {
  if (typeof source?.code !== 'string') throw new TypeError('source.code 必须是源码字符串');
  if ((!source.code.trim() && !source.before?.trim()) || source.code === source.before) return [];
  const cards = new Map();
  for (const recipe of recipes) {
    const evidence = recipe.detect(source.code, source.path || '');
    if (evidence && !source.before?.includes(evidence)) {
      cards.set(recipe.key, { ...catalogCard(recipe), evidence, demo: recipe.key });
    }
  }
  if (!complete) return [...cards.values()];

  const catalog = new Map([...known, ...recipes].map(item => [item.key, catalogCard(item)]));
  const input = {
    source: { path: source.path, kind: source.kind, code: source.code, before: source.before },
    concepts: [...catalog.values()], detected: [...cards.keys()],
  };
  const output = await complete(extractPrompt + '\n\n' + JSON.stringify(input));
  for (const card of validateCards(output, source, catalog)) {
    const prior = cards.get(card.key);
    if (prior && (prior.rule !== card.rule || prior.conditions !== card.conditions)) {
      throw new Error(`知识点 ${card.key} 被用于不同的规律`);
    }
    if (!prior) cards.set(card.key, card);
  }
  return [...cards.values()];
}
