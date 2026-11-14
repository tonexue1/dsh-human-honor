import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// The queue survives a stopped Host. A lease permits two profiles sharing the same
// personal database to drain it, and lets a new process recover abandoned jobs.
export class CaptureQueue {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS capture_batches(
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS capture_jobs(
        id TEXT PRIMARY KEY, batch TEXT NOT NULL, source TEXT NOT NULL, route TEXT,
        session TEXT NOT NULL, ready INTEGER NOT NULL, lease TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_ready ON capture_jobs(ready);
    `);
  }
  put(batch, revision, sources, route, session, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT revision FROM capture_batches WHERE id=?').get(batch);
      if (!old || old.revision < revision) {
        this.db.prepare('DELETE FROM capture_jobs WHERE batch=?').run(batch);
        this.db.prepare('INSERT INTO capture_batches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision')
          .run(batch,revision);
        const add = this.db.prepare('INSERT INTO capture_jobs(id,batch,source,route,session,ready) VALUES (?,?,?,?,?,?)');
        for (const [index,source] of sources.entries()) {
          const id = createHash('sha256').update(JSON.stringify([batch,revision,index])).digest('hex');
          add.run(id,batch,JSON.stringify(source),JSON.stringify(route ?? null),session,now);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  next() {
    const now = Date.now();
    const token = randomUUID();
    const row = this.db.prepare(`UPDATE capture_jobs SET lease=?, ready=? WHERE id=(
      SELECT id FROM capture_jobs WHERE ready<=? ORDER BY ready,id LIMIT 1
    ) RETURNING id,source,route,session,attempts`).get(token,now+180000,now);
    return row && {...row,token,source:JSON.parse(row.source),route:JSON.parse(row.route)};
  }
  owns(job) {
    return Boolean(this.db.prepare('SELECT 1 FROM capture_jobs WHERE id=? AND lease=?').get(job.id,job.token));
  }
  done(job) {
    this.db.prepare('DELETE FROM capture_jobs WHERE id=? AND lease=?').run(job.id,job.token);
  }
  fail(job, message, stopping) {
    const tries = job.attempts + (stopping ? 0 : 1);
    // After three failed infrastructure/model calls, keep the source for user-initiated retry.
    const next = stopping ? Date.now() : tries >= 3 ? Number.MAX_SAFE_INTEGER : Date.now() + tries*30000;
    this.db.prepare('UPDATE capture_jobs SET lease=NULL, ready=?, attempts=?, error=? WHERE id=? AND lease=?')
      .run(next,tries,String(message).slice(0,450),job.id,job.token);
  }
  retry() {
    return this.db.prepare('UPDATE capture_jobs SET attempts=0, ready=?, error=NULL WHERE error IS NOT NULL AND lease IS NULL')
      .run(Date.now()).changes;
  }
  status() {
    return this.db.prepare('SELECT count(*) AS queued, count(error) AS pendingRetry FROM capture_jobs').get();
  }
  close() { this.db.close(); }
}
