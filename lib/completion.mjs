import { createHash } from 'node:crypto';

// An explicit endpoint lets the command-line importer use a local model as well.
export function cliModel(env = process.env) {
  const endpoint = env.HUMAN_HONOR_CHAT_URL;
  const model = env.HUMAN_HONOR_MODEL;
  if (!endpoint && !model) return { version: 'offline-1' };
  if (!endpoint || !model) throw new Error('请同时设置 HUMAN_HONOR_CHAT_URL（完整聊天接口 URL）和 HUMAN_HONOR_MODEL。');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('聊天接口需要 http 或 https。');
  const identity = createHash('sha256').update(endpoint + '\n' + model).digest('hex').slice(0, 16);
  return {
    version: 'model-1-' + identity,
    async complete(prompt) {
      const headers = { 'content-type': 'application/json' };
      if (env.HUMAN_HONOR_API_KEY) headers.authorization = 'Bearer ' + env.HUMAN_HONOR_API_KEY;
      const response = await fetch(url, {
        method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!response.ok) throw new Error('模型接口返回 HTTP ' + response.status);
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回文本。');
      return content;
    },
  };
}
