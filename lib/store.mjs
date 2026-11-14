import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { databasePath } from './paths.mjs'

const states = new Set(['inbox', 'later', 'known'])

// The topic is only a browsing path. Identity is the extractor's stable key for
// a rule and its boundary conditions, independent of project and language.
const schema = `
  CREATE TABLE IF NOT EXISTS concept (
    key TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    rule TEXT NOT NULL,
    conditions TEXT NOT NULL,
    topic TEXT NOT NULL,
    demo TEXT,
    status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','later','known'))
  );
  CREATE INDEX IF NOT EXISTS concept_status ON concept(status);
  CREATE TABLE IF NOT EXISTS analysis (
    fingerprint TEXT PRIMARY KEY NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source (
    fingerprint TEXT PRIMARY KEY NOT NULL,
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    revision TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS occurrence (
    concept_key TEXT NOT NULL REFERENCES concept(key),
    source_id TEXT NOT NULL REFERENCES source(fingerprint),
    side TEXT NOT NULL CHECK (side IN ('before','after')),
    evidence TEXT NOT NULL,
    UNIQUE (concept_key, source_id, side, evidence)
  );
  CREATE INDEX IF NOT EXISTS occurrence_source ON occurrence(source_id);
  CREATE TABLE IF NOT EXISTS search_term (
    term TEXT NOT NULL,
    concept_key TEXT NOT NULL REFERENCES concept(key),
    PRIMARY KEY (term, concept_key)
  ) WITHOUT ROWID;
`

const overview = `
  SELECT c.*, (
    SELECT count(*) FROM occurrence o WHERE o.concept_key = c.key
  ) AS sourceCount FROM concept c
`

function nonempty(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

function sourceIdentity(source) {
  const { project, path, kind = 'file', revision = '', code, before } = source
  nonempty(project, 'project')
  nonempty(path, 'path')
  nonempty(kind, 'kind')
  if (typeof revision !== 'string' || typeof code !== 'string' ||
      (before != null && typeof before !== 'string')) {
    throw new TypeError('revision, code and optional before must be strings')
  }
  // A dirty working tree can change repeatedly without a commit. Hash the
  // actual before/after content too; keep only matched evidence in the DB.
  // Repository imports carry the entire file at HEAD. An unrelated commit
  // leaves this observation unchanged; retain its first real revision.
  const inputRevision = kind === 'repository' ? '' : revision
  const fingerprint = digest([project, path, kind, inputRevision, before ?? null, code])
  return { fingerprint, project, path, kind, revision }
}

function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

const stopwords = new Set('a an and as async await bool break case catch class const def do else export false for from function if import in int let new none not null of or pass private public return self static str string super then this throw true try var void while'.split(' '))

function terms(text, limit = 160) {
  const found = new Set()
  // Camel case, snake case, and contiguous Chinese each need different
  // boundaries. Preserve compound names as well as their common stems.
  for (const [word] of text.matchAll(/[A-Za-z][A-Za-z0-9_]*|[\p{Script=Han}]+/gu)) {
    if (/^[\p{Script=Han}]/u.test(word)) {
      for (let i = 1; i < word.length && found.size < limit; i++) found.add(word.slice(i - 1, i + 1))
    } else {
      const parts = word.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[ _]+/)
      for (const part of [word, ...parts]) {
        const term = part.toLowerCase()
        if (term.length >= 2 && term.length <= 80 && !stopwords.has(term)) found.add(term)
      }
    }
    if (found.size >= limit) break
  }
  return [...found].slice(0, limit)
}

function validateCard(card, source) {
  for (const field of ['key', 'title', 'rule', 'topic', 'evidence']) {
    nonempty(card[field], field)
  }
  const conditions = card.conditions ?? ''
  if (typeof conditions !== 'string' &&
      !(Array.isArray(conditions) && conditions.every(value => typeof value === 'string'))) {
    throw new TypeError('conditions must be a string or array of strings')
  }
  if (card.demo != null) nonempty(card.demo, 'demo')
  if (source.code.includes(card.evidence)) return 'after'
  if (source.before?.includes(card.evidence)) return 'before'
  throw new Error(`Evidence for "${card.key}" did not occur in the source`)
}

function readCard(row) {
  return { ...row, conditions: JSON.parse(row.conditions) }
}

function validateState(status, allowAll = false) {
  if (states.has(status) || (allowAll && status === 'all')) return
  throw new RangeError(`Unknown knowledge status: ${String(status)}`)
}

/**
 * Synchronous per-person SQLite store. Each analysis result, including an empty
 * result, is committed atomically. A change of extractor version enables retry.
 */
export function openStore(dbPath = databasePath()) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    db.exec(schema)
    const addTerm = db.prepare('INSERT OR IGNORE INTO search_term(term, concept_key) VALUES (?, ?)')
    function indexCard(card, evidence) {
      const text = [card.key, card.title, card.topic, card.rule, card.conditions, evidence].join('\n')
      for (const term of terms(text, 320)) addTerm.run(term, card.key)
    }
    // Backfill databases created before term indexing. The DDL and
    // backfill are idempotent when two host processes start together.
    if (db.prepare('PRAGMA user_version').get().user_version === 0) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of db.prepare('SELECT c.*, o.evidence FROM concept c JOIN occurrence o ON o.concept_key=c.key').iterate()) {
          indexCard(row, row.evidence)
        }
        db.exec('PRAGMA user_version = 1; COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    const processed = db.prepare('SELECT 1 FROM analysis WHERE fingerprint = ?')
    const finish = db.prepare('INSERT INTO analysis(fingerprint) VALUES (?)')
    const addConcept = db.prepare(`
      INSERT INTO concept(key, title, rule, conditions, topic, demo) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `)
    const definition = db.prepare('SELECT rule, conditions FROM concept WHERE key = ?')
    const addSource = db.prepare(`
      INSERT INTO source(fingerprint, project, path, kind, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO NOTHING
    `)
    const addOccurrence = db.prepare(`
      INSERT INTO occurrence(concept_key, source_id, side, evidence) VALUES (?, ?, ?, ?)
      ON CONFLICT(concept_key, source_id, side, evidence) DO NOTHING
    `)
    const cardByKey = db.prepare(overview + ' WHERE c.key = ?')
    const sourceList = db.prepare(`
      SELECT s.project, s.path, s.kind, s.revision, o.side, o.evidence
      FROM occurrence o JOIN source s ON s.fingerprint = o.source_id
      WHERE o.concept_key = ? ORDER BY o.rowid
    `)
    const order = ' ORDER BY c.topic, c.title, c.key'
    const allCards = db.prepare(overview + order)
    const statusCards = db.prepare(overview + ' WHERE c.status = ?' + order)
    const updateState = db.prepare('UPDATE concept SET status = ? WHERE key = ?')

    function get(key) {
      const row = cardByKey.get(key)
      if (!row) return null
      return { ...readCard(row), sources: sourceList.all(key).map(source => ({ ...source })) }
    }

    function hasAnalyzed(source, version = '1') {
      const identity = sourceIdentity(source)
      const fingerprint = digest([identity.fingerprint, version])
      return Boolean(processed.get(fingerprint))
    }

    function ingest(source, cards, version = '1') {
      if (!Array.isArray(cards)) throw new TypeError('cards must be an array')
      const identity = sourceIdentity(source)
      const fingerprint = digest([identity.fingerprint, version])
      const result = { cached: false, addedConcepts: 0, addedSources: 0 }
      db.exec('BEGIN IMMEDIATE')
      try {
        if (processed.get(fingerprint)) {
          db.exec('COMMIT')
          return { ...result, cached: true }
        }
        if (cards.length) {
          addSource.run(identity.fingerprint, identity.project, identity.path,
            identity.kind, identity.revision)
        }
        for (const card of cards) {
          const side = validateCard(card, source)
          const conditions = JSON.stringify(card.conditions ?? '')
          const inserted = addConcept.run(card.key, card.title, card.rule,
            conditions, card.topic, card.demo ?? null).changes
          if (!inserted) {
            // Another writer may have added this key after the extractor read
            // its catalog. Never attach a new guarantee to a known card.
            const existing = definition.get(card.key)
            if (existing.rule !== card.rule || existing.conditions !== conditions) {
              throw new Error(`Rule or conditions differ for "${card.key}"; reuse its definition or use a new key`)
            }
          }
          result.addedConcepts += inserted
          const newSource = addOccurrence.run(card.key, identity.fingerprint,
            side, card.evidence).changes
          result.addedSources += newSource
          if (newSource) indexCard(card, card.evidence)
        }
        finish.run(fingerprint)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }

    function list(status = 'inbox') {
      validateState(status, true)
      const rows = status === 'all' ? allCards.all() : statusCards.all(status)
      return rows.map(readCard)
    }

    function setStatus(key, status) {
      validateState(status)
      if (!updateState.run(status, key).changes) throw new Error(`Unknown knowledge key: ${key}`)
      return get(key)
    }

    function search(query, status = 'all') {
      nonempty(query, 'query')
      validateState(status, true)
      const match = db.prepare(overview + `
        WHERE (? = 'all' OR c.status = ?) AND
          instr(lower(c.key || char(10) || c.topic || char(10) || c.title || char(10) ||
                c.rule || char(10) || c.conditions), lower(?)) > 0
      ` + order)
      return match.all(status, status, query.trim()).map(readCard)
    }

    function counts() {
      const totals = { inbox: 0, later: 0, known: 0, all: 0 }
      for (const row of db.prepare('SELECT status, count(*) AS n FROM concept GROUP BY status').all()) {
        totals[row.status] = row.n
        totals.all += row.n
      }
      return totals
    }

    const fields = 'c.key, c.title, c.rule, c.conditions, c.topic'
    const recent = db.prepare(`SELECT ${fields} FROM concept c ORDER BY c.rowid DESC LIMIT ?`)
    function candidates(source, limit = 36) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError('candidate limit must be between 1 and 100')
      }
      const latest = recent.all(limit + 1)
      if (latest.length <= limit) return latest.map(readCard)
      const words = terms([source.path, source.code, source.before].filter(Boolean).join('\n'))
      if (!words.length) return latest.slice(0, limit).map(readCard)
      // Rare terms (e.g. an API name) count more than identifiers shared
      // throughout a library. SQLite uses the term index for each lookup.
      const relevant = db.prepare(`
        WITH matches AS (
          SELECT concept_key, 1.0 / count(*) OVER (PARTITION BY term) AS weight
          FROM search_term WHERE term IN (SELECT value FROM json_each(?))
        )
        SELECT ${fields} FROM matches JOIN concept c ON c.key = matches.concept_key
        GROUP BY c.key ORDER BY sum(matches.weight) DESC, c.rowid DESC LIMIT ?
      `).all(JSON.stringify(words), limit)
      const chosen = new Map()
      for (const row of [...relevant, ...latest]) {
        chosen.set(row.key, row)
        if (chosen.size === limit) break
      }
      return [...chosen.values()].map(readCard)
    }

    return { ingest, hasAnalyzed, list, get, setStatus, search, candidates, counts, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}
