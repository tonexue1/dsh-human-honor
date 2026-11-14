import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDemo, recipeIds } from '../lib/demo.mjs';

const execute = promisify(execFile);

test('both portable recipes preserve behavior through the documented verifier', async t => {
  const root = await mkdtemp(join(tmpdir(), 'honor-demos-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of recipeIds) {
    const result = await runDemo(id, { outDir: root });
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(result.checks.length, 3);
    const moved = join(root, 'portable-' + id);
    await cp(result.directory, moved, { recursive: true });
    await rm(join(moved, 'verify-report.json'));
    await execute(process.execPath, ['verify.mjs'], { cwd: moved });
    const copiedReport = JSON.parse(await readFile(join(moved, 'verify-report.json')));
    assert.equal(copiedReport.status, 'verified');
  }

  const first = await runDemo('js-latest-request', { outDir: root });
  const file = join(first.directory, 'lab.mjs');
  const changed = (await readFile(file, 'utf8')).replace('if (id === latest) guarded = value;', 'guarded = value;');
  await writeFile(file, changed);
  await assert.rejects(execute(process.execPath, ['verify.mjs'], { cwd: first.directory }));
  assert.equal(JSON.parse(await readFile(first.reportPath)).status, 'failed');
  const second = await runDemo('js-latest-request', { outDir: root });
  assert.equal(second.status, 'verified');
  assert.equal(await readFile(file, 'utf8'), changed);
  await assert.rejects(runDemo('../outside', { outDir: root }), /未知实验/);
});
