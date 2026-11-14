// DSH command handlers are human UI actions; they don't send prompts to an agent.
const labels = { inbox: '待判断', later: '稍后学', known: '已掌握', all: '全部' };
const help = [
  '/honor list [inbox|known|later|all]  查看知识卡',
  '/honor tree  按主题浏览',
  '/honor search <词语>  查找知识',
  '/honor show <知识ID>  查看规律、适用条件和源码',
  '/honor known|later|inbox <知识ID>  我会了 / 稍后学 / 放回待判断',
].join('\n');

function listCards(cards) {
  return cards.length
    ? cards.map(c => `[${labels[c.status]}] ${c.title}（${c.key}）`).join('\n')
    : '该列表目前为空。';
}

function topicTree(cards) {
  if (!cards.length) return '知识库目前为空。';
  const root = { children: new Map(), cards: [] };
  for (const card of cards) {
    let node = root;
    for (const step of card.topic.split('/').map(s => s.trim()).filter(Boolean)) {
      if (!node.children.has(step)) node.children.set(step, { children: new Map(), cards: [] });
      node = node.children.get(step);
    }
    node.cards.push(card);
  }
  const lines = [];
  function visit(node, depth) {
    const prefix = '  '.repeat(depth);
    for (const card of node.cards) lines.push(`${prefix}· [${labels[card.status]}] ${card.title}（${card.key}）`);
    for (const [name, child] of node.children) {
      lines.push(prefix + name);
      visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return lines.join('\n');
}

function handle(store, rawInput) {
  const [action = 'list', ...args] = rawInput.trim().split(/\s+/).filter(Boolean);
  const [key] = args;
  const success = text => ({ kind: 'success', text });
  const error = message => ({ kind: 'error', text: message });
  if (action === 'help') return success(help);
  if (action === 'list') {
    if (args.length > 1 || (key && !Object.hasOwn(labels, key))) return error(help);
    const status = key || 'inbox';
    return success(`${labels[status]}\n${listCards(store.list(status))}\n\n/honor help  查看操作`);
  }
  if (action === 'tree') return args.length ? error(help) : success(topicTree(store.list('all')));
  if (action === 'search') return key ? success(listCards(store.search(args.join(' ')))) : error(help);
  if (['known', 'later', 'inbox', 'show'].includes(action) && args.length === 1) {
    const card = store.get(key);
    if (!card) return error(`找不到知识点 ${key}，可用 /honor search 搜索。`);
    if (action !== 'show') {
      store.setStatus(key, action);
      return success(`已更新为「${labels[action]}」：${card.title}（${key}）`);
    }
    const conditions = Array.isArray(card.conditions) ? card.conditions.join('；') : card.conditions;
    const sources = card.sources.map(s => [
      `${s.project} / ${s.path} · ${s.revision || '本地快照'}${s.side === 'before' ? '（改动前）' : ''}`,
      s.evidence,
    ].join('\n'));
    return success([`[${labels[card.status]}] ${card.title}`, card.rule, '适用条件：' + conditions,
      ...sources, `/honor known ${key}    /honor later ${key}`].join('\n\n'));
  }
  return error(help);
}

export function registerCommands(ctx, store) {
  if (!ctx.commands) return;
  return ctx.commands.register({
    name: 'honor',
    description: '人类荣耀：阅读知识、查看主题树、标记掌握状态',
    input: { hint: '[list / tree / search / show / known / later / inbox / help]' },
    handler: ({ rawInput }) => handle(store, rawInput),
  });
}
