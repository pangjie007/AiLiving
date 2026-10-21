import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function openDatabase(path = ':memory:'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;');
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get() as
    { version: number } | undefined;
  let currentVersion = versions?.version ?? 0;
  if (currentVersion > 3) {
    db.close();
    throw new Error(`Database schema ${currentVersion} is newer than this application`);
  }
  if (!versions) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE viewer_generations (
          workspace_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
          forgotten_at INTEGER,
          PRIMARY KEY (workspace_id, host_id, viewer_id)
        ) STRICT;
        CREATE TABLE live_events (
          event_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          source TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          type TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          viewer_id TEXT,
          visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
          content TEXT NOT NULL,
          UNIQUE (workspace_id, host_id, source, source_event_id),
          FOREIGN KEY (workspace_id, host_id, viewer_id)
            REFERENCES viewer_generations(workspace_id, host_id, viewer_id)
        ) STRICT;
        CREATE INDEX live_events_scope_time
          ON live_events(workspace_id, host_id, viewer_id, occurred_at);
        CREATE TABLE erased_event_keys (
          workspace_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, host_id, key_hash)
        ) STRICT;
        CREATE TABLE profile_facts (
          fact_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('explicit','inferred')),
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          superseded_at INTEGER,
          FOREIGN KEY (workspace_id, host_id, viewer_id)
            REFERENCES viewer_generations(workspace_id, host_id, viewer_id)
        ) STRICT;
        CREATE INDEX profile_facts_active
          ON profile_facts(workspace_id, host_id, viewer_id, key, superseded_at);
        CREATE TABLE profile_evidence (
          fact_id TEXT NOT NULL REFERENCES profile_facts(fact_id) ON DELETE CASCADE,
          event_id TEXT NOT NULL REFERENCES live_events(event_id) ON DELETE CASCADE,
          PRIMARY KEY (fact_id, event_id)
        ) STRICT;
        CREATE TABLE memories (
          memory_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          viewer_id TEXT,
          visibility TEXT NOT NULL CHECK (visibility IN ('private','public')),
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
          CHECK ((visibility='private' AND viewer_id IS NOT NULL) OR
                 (visibility='public' AND viewer_id IS NULL)),
          FOREIGN KEY (workspace_id, host_id, viewer_id)
            REFERENCES viewer_generations(workspace_id, host_id, viewer_id)
        ) STRICT;
        CREATE INDEX memories_scope_time
          ON memories(workspace_id, host_id, viewer_id, created_at);
        CREATE TABLE memory_evidence (
          memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
          event_id TEXT NOT NULL REFERENCES live_events(event_id) ON DELETE CASCADE,
          PRIMARY KEY (memory_id, event_id)
        ) STRICT;
      `);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, Date.now());
      db.exec('COMMIT');
      currentVersion = 1;
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  if (currentVersion < 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE live_events ADD COLUMN content_purged INTEGER NOT NULL DEFAULT 0
        CHECK (content_purged IN (0,1));`);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
    currentVersion = 2;
  }
  if (currentVersion < 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE live_events ADD COLUMN source_key_hash TEXT;');
      const rows = db.prepare('SELECT event_id AS eventId,source,source_event_id AS sourceEventId FROM live_events')
        .all() as { eventId: string; source: string; sourceEventId: string }[];
      const update = db.prepare('UPDATE live_events SET source_key_hash=? WHERE event_id=?');
      for (const row of rows) {
        update.run(createHash('sha256').update(`${row.source}\0${row.sourceEventId}`).digest('hex'), row.eventId);
      }
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(3, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return db;
}
