import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const recipes = new Map([
  ['sql-version-guard', 'lab.py'],
  ['js-latest-request', 'lab.mjs'],
]);
const recipeRoot = fileURLToPath(new URL('../recipes/', import.meta.url));
export const recipeIds = Object.freeze([...recipes.keys()]);

// Only packaged recipes are executable. Every invocation gets a fresh learner-owned copy.
export async function runDemo(recipeId, { outDir } = {}) {
  if (!recipes.has(recipeId)) throw new Error('未知实验：' + recipeId);
  if (typeof outDir !== 'string' || !outDir.trim()) throw new Error('请提供实验输出目录 outDir');
  const parent = resolve(outDir);
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, recipeId + '-'));
  const reportPath = join(directory, 'verify-report.json');
  let report;
  try {
    for (const name of [recipes.get(recipeId), 'experiment.mjs', 'README.md']) {
      await copyFile(join(recipeRoot, recipeId, name), join(directory, name));
    }
    await copyFile(join(recipeRoot, 'common', 'verify.mjs'), join(directory, 'verify.mjs'));
    await execute(process.execPath, ['verify.mjs'], { cwd: directory, timeout: 75000, windowsHide: true });
    report = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (error) {
    // The verifier records a normal failed check before exiting with status 1.
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      report = { recipeId, checkedAt: new Date().toISOString(), runtime: null, checks: [] };
    }
    report.status = 'failed';
    report.verified = false;
    report.error ??= error.message;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return { ...report, directory, reportPath };
}
