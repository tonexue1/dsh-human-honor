import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/human-honor.mjs', import.meta.url));
const query = 'UPDATE notes SET body = ?, version = version + 1 WHERE id = ? AND version = ?;\n';

test('two Git repos share one human-confirmed concept through independent CLI processes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'honor-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, HUMAN_HONOR_DB: join(dir, 'human.sqlite') };
  delete env.HUMAN_HONOR_MODEL;
  delete env.HUMAN_HONOR_CHAT_URL;
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [bin, ...args, '--json'], { env })).stdout);
  const repos = [];
  for (const name of ['notes-app', 'server-api']) {
    const repo = join(dir, name);
    await mkdir(repo);
    await exec('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'save.sql'), query);
    repos.push(repo);
  }
  const first = await cli('changes', repos[0]);
  assert.equal(first.addedConcepts, 1);
  assert.equal((await cli('changes', repos[0])).reused, 1);
  await cli('mark', 'sql-version-guard', 'known');
  // Import committed source in the other project through the non-DSH entry point.
  await exec('git', ['add', 'save.sql'], { cwd: repos[1] });
  await exec('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','source'], { cwd: repos[1] });
  const next = await cli('import', repos[1]);
  assert.equal(next.addedConcepts, 0);
  assert.equal(next.addedSources, 1);
  assert.deepEqual(await cli('list'), []);
  const known = await cli('show', 'sql-version-guard');
  assert.equal(known.status, 'known');
  assert.equal(known.sources.length, 2);
  assert.equal(new Set(known.sources.map(s=>s.project)).size, 2);
  assert.equal((await cli('tree'))[known.topic].length, 1);
  assert.match((await cli('learn', known.key)).explanation, /UPDATE/);
  const demo = await cli('demo', known.key, '--out', join(dir, 'labs'));
  assert.equal(demo.verified, true);
});
