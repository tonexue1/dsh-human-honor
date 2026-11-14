import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024;
const extensions = new Set(('js mjs cjs jsx ts mts cts tsx vue svelte css scss sass less html htm xml svg py pyi rb php java kt kts scala groovy gradle c cc cpp cxx h hpp hxx cs fs fsx go rs swift m mm dart sql graphql gql sh bash zsh fish ps1 lua r jl ex exs erl hrl clj cljs hs ml mli nim zig sol v sv proto toml yaml yml json jsonc ini conf properties md mdx rst cmake mk asm s tf ets').split(' '));
const special = new Set(['dockerfile', 'makefile', 'cmakelists.txt', 'rakefile', 'gemfile', 'jenkinsfile', 'justfile', 'meson.build']);
const ignoredDirs = new Set(('.git .hg .svn node_modules bower_components vendor vendors third_party third-party .gradle .idea .venv venv __pycache__ .next .nuxt .cache .terraform target build dist out coverage generated .dsh .dsh-human-honor .human-honor').split(' '));
const lockfile = /(?:\.lock|\.lockb|\.min\.(?:js|css)|\.d\.ts\.map)$|^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum)$/i;
const secretName = /^(?:\.env(?:$|\.)|\.npmrc$|\.pypirc$|\.netrc$|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.))|(?:secret|credential|password|service[-_]?account|auth[-_]?token|key[-_]?store|private[-_]?key|google-services|googleService-Info)|\.(?:pem|pfx|p12|jks|keystore|key)$/i;
const secretText = /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{60,}|AKIA[A-Z0-9]{16})\b|["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)["']?\s*[:=]\s*["'][^\s"']{16,}["']/i;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isSourcePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return false;
  const parts = relativePath.replaceAll('\\', '/').toLowerCase().split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || ignoredDirs.has(part) || secretName.test(part))) return false;
  const name = parts.at(-1);
  return !lockfile.test(name) && (special.has(name) || extensions.has(path.posix.extname(name).slice(1)));
}

export function containsSensitiveText(code) {
  return secretText.test(code);
}

class Skip extends Error {}

async function git(cwd, args, options = {}) {
  const { publicRemote, ...other } = options;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXTERNAL_DIFF']) delete env[key];
  if (publicRemote) {
    // A public import must not borrow a developer's credentials, URL rewrites or prompts.
    for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') || key === 'GIT_ASKPASS' || key === 'SSH_ASKPASS') delete env[key];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_ALLOW_PROTOCOL: 'https' });
  }
  const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + devNull, ...args],
    { cwd, env, encoding: 'buffer', maxBuffer: MAX_OUTPUT, timeout: 30_000, windowsHide: true, ...other });
  return stdout;
}

function numberOption(value, fallback, name) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(name + ' 必须为正整数');
  return n;
}

function makeFilter(options) {
  const requested = (options.subpath ?? '.').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (path.win32.isAbsolute(options.subpath ?? '.') || requested.split('/').includes('..') || requested.includes('\0')) {
    throw new Error('subpath 必须是仓库内的相对路径');
  }
  return {
    subpath: requested === '.' ? '' : requested,
    maxFiles: numberOption(options.maxFiles, 150, 'maxFiles'),
    maxBytes: numberOption(options.maxFileBytes, 131_072, 'maxFileBytes')
  };
}

async function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || ref.includes('\0')) throw new Error('无效的 Git revision');
  const oid = (await git(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).toString().trim();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('无法解析提交');
  return oid;
}

function treeObjects(output) {
  const rows = new Map();
  for (const row of output.toString('utf8').split('\0')) {
    if (!row) continue;
    const at = row.indexOf('\t');
    const [mode, type, oid, size] = row.slice(0, at).trim().split(/\s+/);
    rows.set(row.slice(at + 1), { mode, type, oid, size: Number(size) });
  }
  return rows;
}

function indexObjects(output) {
  const rows = new Map();
  for (const row of output.toString('utf8').split('\0')) {
    if (!row) continue;
    const at = row.indexOf('\t');
    const [mode, oid, stage] = row.slice(0, at).split(' ');
    rows.set(row.slice(at + 1), { mode, oid, conflict: stage !== '0' });
  }
  return rows;
}

function decode(data, maxBytes) {
  if (data.length > maxBytes) throw new Skip('超过大小限制');
  if (data.includes(0)) throw new Skip('二进制内容');
  let code;
  try { code = utf8.decode(data); } catch { throw new Skip('非 UTF-8 内容'); }
  if (containsSensitiveText(code)) throw new Skip('含疑似凭据');
  return code;
}

async function readBlob(root, obj, limit) {
  if (!obj) return '';
  if (!['100644', '100755'].includes(obj.mode) || obj.conflict) throw new Skip('符号链接、子模块或未合并条目');
  const size = obj.size ?? Number((await git(root, ['cat-file', '-s', obj.oid])).toString());
  if (size > limit) throw new Skip('超过大小限制');
  return decode(await git(root, ['cat-file', 'blob', obj.oid], { maxBuffer: Math.max(size + 256, 1024) }), limit);
}

async function readWorkingFile(root, relativePath, limit) {
  const absolute = path.join(root, relativePath);
  try {
    const st = await lstat(absolute);
    if (!st.isFile() || (await realpath(absolute)) !== absolute) throw new Skip('符号链接或特殊文件');
    if (st.size > limit) throw new Skip('超过大小限制');
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(st.size + 1, limit + 1));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== st.size) throw new Skip('文件正在变化');
      return decode(buffer.subarray(0, bytesRead), limit);
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw error;
  }
}

async function collect(project, revision, names, filter, getSource) {
  const sources = [], warnings = [];
  let skipped = 0, truncated = 0;
  for (const name of names) {
    if (filter.subpath && name !== filter.subpath && !name.startsWith(filter.subpath + '/')) continue;
    if (!isSourcePath(name)) { skipped++; continue; }
    if (sources.length >= filter.maxFiles) {
      skipped++;
      truncated++;
      continue;
    }
    try {
      const source = await getSource(name);
      if (source) sources.push({ project, path: name, ...source });
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped++;
      if (warnings.length < 20) warnings.push(name + '：' + error.message);
    }
  }
  if (truncated) warnings.push('达到文件数上限 ' + filter.maxFiles + '，有 ' + truncated + ' 个候选未读，可用 subpath 分批读取');
  return { project, revision, sources, warnings, skipped };
}

function publicUrl(input) {
  if (!/^[\w+.-]+:\/\//.test(input)) return null;
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('远端仅接受不带凭据、查询串或 fragment 的 HTTPS Git URL');
  }
  return url.href.replace(/\/$/, '');
}

export async function localRoot(input) {
  const dir = path.resolve(input);
  const absolute = (await git(dir, ['rev-parse', '--show-toplevel'])).toString().replace(/\r?\n$/, '');
  return realpath(absolute);
}

async function repositoryAt(root, project, filter, ref) {
  const revision = await resolveCommit(root, ref);
  const scopes = filter.subpath ? ['--', filter.subpath] : [];
  const objects = treeObjects(await git(root, ['ls-tree', '-r', '-l', '-z', revision, ...scopes]));
  return collect(project, revision, objects.keys(), filter, async name => ({
    code: await readBlob(root, objects.get(name), filter.maxBytes), revision, kind: 'repository'
  }));
}

export async function readRepository(input = '.', options = {}) {
  const filter = makeFilter(options);
  const url = publicUrl(input);
  if (!url) {
    const root = await localRoot(input);
    return repositoryAt(root, root, filter, options.ref ?? 'HEAD');
  }
  const ref = options.ref ?? 'HEAD';
  if (ref !== 'HEAD' && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|[\w][\w./-]*)$/.test(ref)) throw new Error('远端引用格式无效');
  const temp = await mkdtemp(path.join(tmpdir(), 'honor-import-'));
  try {
    await git(temp, ['init', '--bare', '--quiet', '.'], { publicRemote: true });
    await git(temp, ['-c', 'credential.helper=', 'fetch', '--quiet', '--no-tags', '--depth=1', url, ref], { publicRemote: true, timeout: 90_000 });
    return await repositoryAt(temp, url.replace(/\.git$/i, ''), filter, 'FETCH_HEAD');
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function readChanges(input = '.', options = {}) {
  const root = await localRoot(input);
  const filter = makeFilter(options);
  let revision = 'unborn';
  try { revision = await resolveCommit(root, 'HEAD'); } catch (error) {
    if (error.code !== 128 || !(await git(root, ['symbolic-ref', '-q', 'HEAD'])).length) throw error;
  }
  const scopes = filter.subpath ? ['--', filter.subpath] : [];
  const [tree, index, status] = await Promise.all([
    revision === 'unborn' ? Buffer.alloc(0) : git(root, ['ls-tree', '-r', '-l', '-z', revision, ...scopes]),
    git(root, ['ls-files', '--stage', '-z', ...scopes]),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all', ...scopes])
  ]);
  const base = treeObjects(tree), staged = indexObjects(index);
  const entries = status.toString('utf8').split('\0').filter(Boolean);
  const names = entries.filter(entry => !options.staged || (entry[0] !== ' ' && entry[0] !== '?')).map(entry => entry.slice(3));
  return collect(root, revision, names, filter, async name => {
    if (staged.get(name)?.conflict) throw new Skip('未合并条目');
    const [before, code] = await Promise.all([
      readBlob(root, base.get(name), filter.maxBytes),
      options.staged ? readBlob(root, staged.get(name), filter.maxBytes) : readWorkingFile(root, name, filter.maxBytes)
    ]);
    if (code === before) return null;
    const hash = createHash('sha256').update(before).update('\0').update(code).digest('hex');
    return { code, before, revision: revision + ':' + hash, kind: 'change' };
  });
}
