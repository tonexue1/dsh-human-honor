import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function databasePath() {
  return process.env.HUMAN_HONOR_DB
    ? resolve(process.env.HUMAN_HONOR_DB)
    : join(homedir(), '.dsh-human-honor', 'knowledge.sqlite');
}

export function demoRoot() {
  return process.env.HUMAN_HONOR_DEMOS
    ? resolve(process.env.HUMAN_HONOR_DEMOS)
    : join(dirname(databasePath()), 'labs');
}
