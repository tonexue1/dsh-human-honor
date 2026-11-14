import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { experiment } from './experiment.mjs';

const execute = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const options = { cwd: directory, timeout: 10000, maxBuffer: 256 * 1024,
  windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };

async function findRuntime() {
  if (experiment.runtime === 'node') {
    return { command: process.execPath, flags: [], version: 'Node.js ' + process.versions.node };
  }
  const probe = 'import sys,sqlite3; print("Python", sys.version.split()[0], "/ SQLite", sqlite3.sqlite_version)';
  const problems = [];
  for (const [command, ...flags] of [['python3'], ['python'], ['py', '-3']]) {
    try {
      const { stdout } = await execute(command, [...flags, '-c', probe], options);
      if (!stdout.startsWith('Python 3.')) throw new Error('需要 Python 3');
      return { command, flags, version: stdout.trim() };
    } catch (error) {
      problems.push(command + ': ' + String(error.code ?? error.message));
    }
  }
  throw new Error('找不到含 sqlite3 的 Python 3。' + problems.join(' / '));
}

async function runCase(report, runtime, entry, sample, name) {
  const args = [...runtime.flags, entry, '--order', sample.order, '--a-text', '稿件 A', '--b-text', '稿件 B', '--json'];
  const { stdout } = await execute(runtime.command, args, options);
  const actual = JSON.parse(stdout);
  const passed = isDeepStrictEqual(actual, sample.expected);
  report.checks.push({ name, order: sample.order, passed, expected: sample.expected, actual });
  if (!passed) throw new Error('结果与独立断言不符：' + name);
  return actual;
}

async function verify() {
  const report = {
    recipeId: experiment.recipeId, status: 'failed', verified: false,
    checkedAt: new Date().toISOString(), runtime: null, checks: [],
  };
  try {
    const runtime = await findRuntime();
    report.runtime = runtime.version;
    const sourceFile = join(directory, experiment.file);
    for (const sample of experiment.checks) {
      await runCase(report, runtime, sourceFile, sample, '正常实现 ' + sample.order);
    }
    // 只在新的临时副本中改动关键条件，原始入口与学员的文件保持可复跑。
    const source = await readFile(sourceFile, 'utf8');
    const control = experiment.negative;
    if (source.split(control.from).length !== 2) throw new Error('无法唯一定位反例的改动位置');
    const baseline = experiment.checks.find(test => test.order === control.order);
    if (!baseline || isDeepStrictEqual(control.expected, baseline.expected)) {
      throw new Error('反例必须和相同顺序的正常实现产生不同结果');
    }
    const temp = await mkdtemp(join(tmpdir(), 'honor-control-'));
    try {
      const entry = join(temp, basename(sourceFile));
      await writeFile(entry, source.replace(control.from, control.to), 'utf8');
      await runCase(report, runtime, entry, control, '移除关键条件的反例');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    report.verified = true;
    report.status = 'verified';
  } catch (error) {
    report.error = String(error.message);
  }
  const filename = join(directory, 'verify-report.json');
  const fresh = filename + '.' + randomUUID() + '.tmp';
  await writeFile(fresh, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await rename(fresh, filename);
  console.log(report.runtime ?? '运行环境不可用');
  for (const check of report.checks) {
    console.log((check.passed ? '通过' : '失败') + ' · ' + check.name);
  }
  if (report.error) console.error(report.error);
  process.exitCode = report.verified ? 0 : 1;
}

await verify();
