import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execCB } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readChanges, readRepository, isSourcePath } from '../lib/sources.mjs';
const exec = promisify(execCB);
const git = (dir, ...args) => exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=test@invalid', ...args], { cwd: dir });
async function repo(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'honor-source-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await git(folder, 'init', '-q');
  return folder;
}

test('reads net staged, unstaged, deleted, and untracked code; respects ignore and path policies', async t => {
  const dir = await repo(t);
  await writeFile(path.join(dir, '.gitignore'), 'ignored.js\n');
  for (const f of ['hello world.js', 'both.py', 'gone.sql']) await writeFile(path.join(dir, f), 'original\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-qm', 'baseline');
  await writeFile(path.join(dir, 'both.py'), 'staged\n');
  await git(dir, 'add', 'both.py');
  await writeFile(path.join(dir, 'both.py'), 'working\n');
  await writeFile(path.join(dir, 'hello world.js'), 'unstaged\n');
  await rm(path.join(dir, 'gone.sql'));
  await writeFile(path.join(dir, 'new source.js'), 'new\n');
  await writeFile(path.join(dir, 'ignored.js'), 'ignored\n');
  await writeFile(path.join(dir, 'token.yaml'), 'password: "this_is_a_fixture_value"\n');
  await writeFile(path.join(dir, 'credentials.json'), '{}\n');
  await writeFile(path.join(dir, 'binary.py'), Buffer.from([0, 29]));
  await mkdir(path.join(dir, 'vendor'));
  await writeFile(path.join(dir, 'vendor/dep.js'), 'skipped\n');
  const read = await readChanges(dir);
  const found = Object.fromEntries(read.sources.map(s => [s.path, s]));
  assert.deepEqual(Object.keys(found).sort(), ['both.py','gone.sql','hello world.js','new source.js']);
  assert.equal(found['both.py'].code, 'working\n');
  assert.equal(found['both.py'].before, 'original\n');
  assert.equal(found['gone.sql'].code, '');
  assert.equal(found['new source.js'].before, '');
  assert.ok(read.warnings.some(w => w.includes('二进制')));
  assert.ok(read.warnings.some(w => w.includes('疑似凭据')));
  const index = await readChanges(dir, { staged: true });
  assert.deepEqual(index.sources.map(s => [s.path, s.code]), [['both.py', 'staged\n']]);
  const snapshot = await readRepository(dir);
  assert.equal(snapshot.project, read.project);
  assert.deepEqual(snapshot.sources.map(s => s.code), Array(3).fill('original\n'));
});

test('freezes local repository snapshots, narrows literal scope, and enforces file and size limits', async t => {
  const dir = await repo(t);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src/[unit].js'), '1\n');
  await writeFile(path.join(dir, 'src/y.js'), '2\n');
  await writeFile(path.join(dir, 'src/z.js'), 'oversized'.repeat(100));
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'first');
  const { stdout: oid } = await git(dir, 'rev-parse', 'HEAD');
  await writeFile(path.join(dir, 'src/[unit].js'), '2\n');
  await git(dir, 'commit', '-qam', 'second');
  const result = await readRepository(dir, { ref: oid.trim(), subpath: 'src/[unit].js' });
  assert.deepEqual(result.sources.map(s => s.code), ['1\n']);
  assert.equal(result.sources[0].revision, oid.trim());
  const large = await readRepository(dir, { maxFileBytes: 5 });
  assert.equal(large.sources.length, 2);
  assert.ok(large.warnings[0].includes('大小'));
  const few = await readRepository(dir, { maxFiles: 1 });
  assert.equal(few.sources.length, 1);
  assert.ok(few.warnings[0].includes('上限'));
  await assert.rejects(readRepository(dir, { subpath: '../parent' }));
});

test('reads initial commits and skips symlinks outside the project', async t => {
  const dir = await repo(t);
  await writeFile(path.join(dir, 'a.py'), 'print(1)\n');
  if (process.platform !== 'win32') await symlink(path.join(dir, 'a.py'), path.join(dir, 'link.py'));
  const delta = await readChanges(dir);
  assert.equal(delta.revision, 'unborn');
  assert.deepEqual(delta.sources.map(s=>s.path), ['a.py']);
  await git(dir, 'add', '.'); await git(dir, 'commit', '-qm', 'first');
  assert.deepEqual((await readRepository(dir)).sources.map(s=>s.path), ['a.py']);
});

test('admits typical source but excludes common secrets, generated outputs and absolute/parent paths', () => {
  for (const name of ['src/main.kt','src/a.mjs','source.sql','src\\view.ts','Dockerfile','README.md']) assert.ok(isSourcePath(name), name);
  for (const name of ['../a.py','/root/a.js','C:\\pw\\x.sql','./a.ts','.env.local','config/secrets.json','lib/keyStore.json','lib.min.js','node_modules/a.ts','dist/a.js','package-lock.json','ui.png']) assert.equal(isSourcePath(name), false, name);
});

test('rejects URL credentials, non-HTTPS transports and injected options', async () => {
  for (const uri of ['https://user:token@example.org/a.git','https://example.org/a.git?token=abc','file:///tmp/tree','ssh://example.org/repo']) {
    await assert.rejects(readRepository(uri),/HTTPS/);
  }
  await assert.rejects(readRepository('https://example.org/a.git', { ref: '--entire' }), /引用/);
});
