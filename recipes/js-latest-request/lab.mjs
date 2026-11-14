// A、B 依次发出。手动交付 Promise 的结果，精确控制两个响应回来的顺序。
import { parseArgs } from 'node:util';

async function search(order, labels) {
  let latest = 0;
  let plain = null;
  let guarded = null;
  const received = [];
  const pending = new Map();
  for (const label of ['A', 'B']) {
    const id = ++latest;
    const response = new Promise(resolve => pending.set(label, resolve));
    response.then(value => {
      received.push(label);
      plain = value;
      if (id === latest) guarded = value;
    });
  }
  for (const label of order) {
    pending.get(label)(labels[label]);
    await Promise.resolve(); // 让刚交付的响应先完成，再交付下一个
  }
  return { received, plain, guarded };
}

const { values } = parseArgs({ options: {
  order: { type: 'string', default: 'BA' },
  'a-text': { type: 'string', default: 'A 的结果' },
  'b-text': { type: 'string', default: 'B 的结果' },
  json: { type: 'boolean' },
}});
if (!['AB', 'BA'].includes(values.order)) {
  console.error('--order 必须是 AB 或 BA');
  process.exitCode = 2;
} else {
  const result = await search(values.order, { A: values['a-text'], B: values['b-text'] });
  if (values.json) console.log(JSON.stringify(result));
  else {
    console.log('发起顺序 A → B，实际收到顺序 ' + result.received.join(' → '));
    console.log('收到就显示：' + result.plain);
    console.log('按请求编号更新：' + result.guarded);
  }
}
