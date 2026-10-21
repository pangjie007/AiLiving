import type { DatabaseSync } from 'node:sqlite';
import type { LiveEventInput } from '../domain/events.mts';
import { validateEvent } from '../domain/events.mts';
import { createHash } from 'node:crypto';

export type Scope = { workspaceId: string; hostId: string; viewerId: string };
export type MemoryInput = {
  memoryId: string; workspaceId: string; hostId: string; viewerId: string | null;
  visibility: 'private' | 'public'; kind: string; content: string;
  confidence: number; createdAt: number; expiresAt: number | null;
  pinned: boolean; evidenceEventIds: string[];
};
export type ProfileFactInput = {
  factId: string; workspaceId: string; hostId: string; viewerId: string;
  key: string; value: string; kind: 'explicit' | 'inferred'; confidence: number;
  createdAt: number; expiresAt: number | null; evidenceEventId: string;
};
export class ViewerEpochError extends Error {}

export type StoredMemory = MemoryInput;
export type StoredProfileFact = Omit<ProfileFactInput, 'evidenceEventId'> & {
  evidenceEventIds: string[];
  supersededAt: number | null;
};
type IngestResult = { inserted: boolean; viewerEpoch: number | null };

function eventKey(source: string, sourceEventId: string): string {
  return createHash('sha256').update(`${source}\0${sourceEventId}`).digest('hex');
}

const DAY = 86_400_000;
const EVENT_TEXT_RETENTION = 30 * DAY;
const MEMORY_RETENTION = 90 * DAY;

function requireText(value: string, field: string, max = 4000): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Invalid ${field}`);
  }
}

export class MemoryRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) { this.#db = db; }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #viewerEpoch(scope: Scope): { epoch: number; forgottenAt: number | null } | undefined {
    return this.#db.prepare(`SELECT epoch, forgotten_at AS forgottenAt
      FROM viewer_generations WHERE workspace_id=? AND host_id=? AND viewer_id=?`)
      .get(scope.workspaceId, scope.hostId, scope.viewerId) as
      { epoch: number; forgottenAt: number | null } | undefined;
  }

  #assertCurrent(scope: Scope, expectedEpoch: number): void {
    const row = this.#viewerEpoch(scope);
    if (!row || row.forgottenAt !== null || row.epoch !== expectedEpoch) {
      throw new ViewerEpochError('stale viewer epoch');
    }
  }

  ingestEvent(input: LiveEventInput, now: number): IngestResult {
    const event = validateEvent(input, now);
    return this.#transaction(() => {
      this.#db.prepare('DELETE FROM erased_event_keys WHERE expires_at <= ?').run(now);
      const prior = this.#db.prepare(`SELECT viewer_id AS viewerId FROM live_events
        WHERE workspace_id=? AND host_id=? AND source=? AND source_event_id=?`)
        .get(event.workspaceId, event.hostId, event.source, event.sourceEventId) as
        { viewerId: string | null } | undefined;
      if (prior) {
        const epoch = prior.viewerId === null ? null : this.#viewerEpoch({
          workspaceId: event.workspaceId, hostId: event.hostId, viewerId: prior.viewerId
        })?.epoch ?? null;
        return { inserted: false, viewerEpoch: epoch };
      }
      if (event.viewerId !== null) {
        const scope = { workspaceId: event.workspaceId, hostId: event.hostId, viewerId: event.viewerId };
        this.#db.prepare(`INSERT INTO viewer_generations(workspace_id,host_id,viewer_id)
          VALUES (?,?,?) ON CONFLICT DO NOTHING`).run(scope.workspaceId, scope.hostId, scope.viewerId);
      }
      const hash = eventKey(event.source, event.sourceEventId);
      const erased = this.#db.prepare(`SELECT 1 AS found FROM erased_event_keys
        WHERE workspace_id=? AND host_id=? AND key_hash=? AND expires_at>?`)
        .get(event.workspaceId, event.hostId, hash, now);
      if (erased) {
        const epoch = event.viewerId === null ? null : this.#viewerEpoch({
          workspaceId: event.workspaceId, hostId: event.hostId, viewerId: event.viewerId
        })!.epoch;
        return { inserted: false, viewerEpoch: epoch };
      }
      if (event.viewerId !== null) {
        const scope = { workspaceId: event.workspaceId, hostId: event.hostId, viewerId: event.viewerId };
        this.#db.prepare(`UPDATE viewer_generations SET forgotten_at=NULL
          WHERE workspace_id=? AND host_id=? AND viewer_id=?`)
          .run(scope.workspaceId, scope.hostId, scope.viewerId);
      }
      const epoch = event.viewerId === null ? null : this.#viewerEpoch({
        workspaceId: event.workspaceId, hostId: event.hostId, viewerId: event.viewerId
      })!.epoch;
      this.#db.prepare(`INSERT INTO live_events(
        event_id,workspace_id,host_id,session_id,source,source_event_id,type,
        occurred_at,received_at,viewer_id,visibility,content,source_key_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.eventId, event.workspaceId, event.hostId, event.sessionId,
        event.source, event.sourceEventId, event.type, event.occurredAt,
        event.receivedAt, event.viewerId, event.visibility, event.content,
        eventKey(event.source, event.sourceEventId)
      );
      return { inserted: true, viewerEpoch: epoch };
    });
  }

  #validateMemory(input: MemoryInput, now: number): void {
    requireText(input.memoryId, 'memory ID', 200);
    requireText(input.workspaceId, 'workspace ID', 200);
    requireText(input.hostId, 'host ID', 200);
    requireText(input.kind, 'memory kind', 100);
    requireText(input.content, 'memory content');
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 ||
        !Number.isFinite(input.createdAt) || input.createdAt < 0 || !Number.isFinite(now) || now < 0 ||
        input.createdAt > now + 300_000 ||
        (input.expiresAt !== null && (!Number.isFinite(input.expiresAt) || input.expiresAt <= input.createdAt)) ||
        !Array.isArray(input.evidenceEventIds) || input.evidenceEventIds.length === 0) {
      throw new Error('Invalid memory metadata or missing evidence');
    }
    const publicShape = input.visibility === 'public' && input.viewerId === null;
    const privateShape = input.visibility === 'private' && typeof input.viewerId === 'string' && !!input.viewerId.trim();
    if (!publicShape && !privateShape) throw new Error('Invalid memory visibility scope');
  }

  #insertMemory(input: MemoryInput, now: number): void {
    this.#validateMemory(input, now);
    const maximumExpiry = input.createdAt + MEMORY_RETENTION;
    const storedInput: MemoryInput = { ...input, expiresAt: input.pinned ? null :
      Math.min(input.expiresAt ?? maximumExpiry, maximumExpiry) };
    const evidenceIds = [...new Set(input.evidenceEventIds)];
    if (evidenceIds.length !== input.evidenceEventIds.length) throw new Error('Duplicate memory evidence');
    for (const eventId of evidenceIds) {
      const evidence = this.#db.prepare(`SELECT viewer_id AS viewerId, visibility
        FROM live_events WHERE event_id=? AND workspace_id=? AND host_id=?`)
        .get(eventId, input.workspaceId, input.hostId) as
        { viewerId: string | null; visibility: string } | undefined;
      if (!evidence) throw new Error('Memory evidence event does not exist in scope');
      if (input.visibility === 'public' &&
          (evidence.viewerId !== null || evidence.visibility !== 'public')) {
        throw new Error('Public memory requires anonymous public evidence');
      }
      if (input.visibility === 'private' && evidence.viewerId !== input.viewerId) {
        throw new Error('Private memory evidence belongs to another viewer');
      }
    }
    this.#db.prepare(`INSERT INTO memories(
      memory_id,workspace_id,host_id,viewer_id,visibility,kind,content,
      confidence,created_at,expires_at,pinned
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      storedInput.memoryId, storedInput.workspaceId, storedInput.hostId, storedInput.viewerId, storedInput.visibility,
      storedInput.kind, storedInput.content, storedInput.confidence, storedInput.createdAt, storedInput.expiresAt,
      storedInput.pinned ? 1 : 0
    );
    const insertEvidence = this.#db.prepare('INSERT INTO memory_evidence(memory_id,event_id) VALUES (?,?)');
    for (const eventId of evidenceIds) insertEvidence.run(input.memoryId, eventId);
  }

  savePrivateMemory(input: MemoryInput, expectedEpoch: number, now: number): void {
    if (input.visibility !== 'private' || input.viewerId === null) throw new Error('Expected private memory');
    this.#transaction(() => {
      this.#assertCurrent({ workspaceId: input.workspaceId, hostId: input.hostId, viewerId: input.viewerId! }, expectedEpoch);
      this.#insertMemory(input, now);
    });
  }

  savePublicMemory(input: MemoryInput, now: number): void {
    if (input.visibility !== 'public' || input.viewerId !== null) throw new Error('Expected public memory');
    this.#transaction(() => this.#insertMemory(input, now));
  }

  listMemories(scope: Scope, now: number): MemoryInput[] {
    const rows = this.#db.prepare(`SELECT memory_id AS memoryId, workspace_id AS workspaceId,
      host_id AS hostId, viewer_id AS viewerId, visibility, kind, content, confidence,
      created_at AS createdAt, expires_at AS expiresAt, pinned
      FROM memories WHERE workspace_id=? AND host_id=? AND
        (visibility='public' OR (visibility='private' AND viewer_id=?)) AND
        (expires_at IS NULL OR expires_at>?) ORDER BY created_at,memory_id`)
      .all(scope.workspaceId, scope.hostId, scope.viewerId, now) as
      (Omit<MemoryInput, 'evidenceEventIds' | 'pinned'> & { pinned: number })[];
    const evidenceQuery = this.#db.prepare(`SELECT event_id AS eventId FROM memory_evidence
      WHERE memory_id=? ORDER BY event_id`);
    return rows.map(row => ({ ...row, pinned: row.pinned === 1,
      evidenceEventIds: (evidenceQuery.all(row.memoryId) as { eventId: string }[]).map(item => item.eventId) }));
  }

  setProfileFact(input: ProfileFactInput, expectedEpoch: number, now: number): { superseded: boolean; ignored?: boolean } {
    requireText(input.factId, 'fact ID', 200);
    requireText(input.key, 'profile key', 100);
    requireText(input.value, 'profile value', 1000);
    if (!Number.isFinite(input.confidence) || input.confidence < 0.6 || input.confidence > 1 ||
        (input.kind === 'explicit' && input.confidence !== 1) ||
        !Number.isFinite(input.createdAt) || input.createdAt < 0 || !Number.isFinite(now) || now < 0 ||
        input.createdAt > now + 300_000 ||
        (input.expiresAt !== null && (!Number.isFinite(input.expiresAt) || input.expiresAt <= input.createdAt))) {
      throw new Error('Invalid profile fact metadata');
    }
    return this.#transaction(() => {
      const scope = { workspaceId: input.workspaceId, hostId: input.hostId, viewerId: input.viewerId };
      this.#assertCurrent(scope, expectedEpoch);
      const event = this.#db.prepare(`SELECT viewer_id AS viewerId FROM live_events
        WHERE event_id=? AND workspace_id=? AND host_id=?`)
        .get(input.evidenceEventId, input.workspaceId, input.hostId) as
        { viewerId: string | null } | undefined;
      if (event?.viewerId !== input.viewerId) throw new Error('Profile evidence belongs to another viewer or is missing');
      const current = this.#db.prepare(`SELECT created_at AS createdAt FROM profile_facts
        WHERE workspace_id=? AND host_id=? AND viewer_id=? AND key=? AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 1`)
        .get(input.workspaceId, input.hostId, input.viewerId, input.key, input.createdAt) as
        { createdAt: number } | undefined;
      if (current && input.createdAt <= current.createdAt) return { superseded: false, ignored: true };
      const expiresAt = Math.min(input.expiresAt ?? input.createdAt + MEMORY_RETENTION,
        input.createdAt + MEMORY_RETENTION);
      const result = this.#db.prepare(`UPDATE profile_facts SET superseded_at=?
        WHERE workspace_id=? AND host_id=? AND viewer_id=? AND key=? AND superseded_at IS NULL
          AND (expires_at IS NULL OR expires_at>?)`).run(
        input.createdAt, input.workspaceId, input.hostId, input.viewerId, input.key, input.createdAt
      );
      this.#db.prepare(`INSERT INTO profile_facts(
        fact_id,workspace_id,host_id,viewer_id,key,value,kind,confidence,created_at,expires_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        input.factId, input.workspaceId, input.hostId, input.viewerId, input.key,
        input.value, input.kind, input.confidence, input.createdAt, expiresAt
      );
      this.#db.prepare('INSERT INTO profile_evidence(fact_id,event_id) VALUES (?,?)')
        .run(input.factId, input.evidenceEventId);
      return { superseded: Number(result.changes) > 0 };
    });
  }

  #profileFactRows(scope: Scope, key: string | null, now: number | null): StoredProfileFact[] {
    const rows = this.#db.prepare(`SELECT fact_id AS factId, workspace_id AS workspaceId,
      host_id AS hostId, viewer_id AS viewerId, key, value, kind, confidence,
      created_at AS createdAt, expires_at AS expiresAt, superseded_at AS supersededAt
      FROM profile_facts WHERE workspace_id=? AND host_id=? AND viewer_id=?
      AND (? IS NULL OR key=?) AND (? IS NULL OR superseded_at IS NOT NULL OR expires_at IS NULL OR expires_at>?)
      ORDER BY created_at,fact_id`).all(
      scope.workspaceId, scope.hostId, scope.viewerId, key, key, now, now
    ) as Omit<StoredProfileFact, 'evidenceEventIds'>[];
    const evidenceQuery = this.#db.prepare(`SELECT event_id AS eventId FROM profile_evidence
      WHERE fact_id=? ORDER BY event_id`);
    return rows.map(row => ({ ...row,
      evidenceEventIds: (evidenceQuery.all(row.factId) as { eventId: string }[]).map(item => item.eventId) }));
  }

  listProfileFacts(scope: Scope, now: number): StoredProfileFact[] {
    return this.#profileFactRows(scope, null, now).filter(row =>
      row.supersededAt === null && (row.expiresAt === null || row.expiresAt > now));
  }

  listProfileFactHistory(scope: Scope, key: string): StoredProfileFact[] {
    return this.#profileFactRows(scope, key, null);
  }

  listRawEvents(scope: Scope): LiveEventInput[] {
    return this.#db.prepare(`SELECT event_id AS eventId, workspace_id AS workspaceId,
      host_id AS hostId, session_id AS sessionId, source, source_event_id AS sourceEventId,
      type, occurred_at AS occurredAt, received_at AS receivedAt, viewer_id AS viewerId,
      visibility, content FROM live_events
      WHERE workspace_id=? AND host_id=? AND viewer_id=? AND content_purged=0 ORDER BY occurred_at,event_id`)
      .all(scope.workspaceId, scope.hostId, scope.viewerId) as LiveEventInput[];
  }

  purgeExpired(now: number): {
    rawEventsRedacted: number; memoriesDeleted: number; profileFactsDeleted: number; erasedKeysDeleted: number;
  } {
    if (!Number.isFinite(now) || now < 0) throw new Error('Invalid purge time');
    return this.#transaction(() => {
      const expiredEvents = this.#db.prepare(`SELECT workspace_id AS workspaceId,host_id AS hostId,
        source,source_event_id AS sourceEventId FROM live_events
        WHERE content_purged=0 AND received_at<=?`)
        .all(now - EVENT_TEXT_RETENTION) as
        { workspaceId: string; hostId: string; source: string; sourceEventId: string }[];
      const insertHash = this.#db.prepare(`INSERT INTO erased_event_keys(workspace_id,host_id,key_hash,expires_at)
        VALUES (?,?,?,?) ON CONFLICT(workspace_id,host_id,key_hash)
        DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`);
      for (const event of expiredEvents) {
        insertHash.run(event.workspaceId, event.hostId, eventKey(event.source, event.sourceEventId), now + MEMORY_RETENTION);
      }
      const redacted = this.#db.prepare(`UPDATE live_events SET content='',source_event_id='redacted:' || event_id,
        content_purged=1 WHERE content_purged=0 AND received_at<=?`).run(now - EVENT_TEXT_RETENTION);
      const memories = this.#db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at<=?').run(now);
      const facts = this.#db.prepare('DELETE FROM profile_facts WHERE expires_at IS NOT NULL AND expires_at<=?').run(now);
      const keys = this.#db.prepare('DELETE FROM erased_event_keys WHERE expires_at<=?').run(now);
      return { rawEventsRedacted: Number(redacted.changes), memoriesDeleted: Number(memories.changes),
        profileFactsDeleted: Number(facts.changes), erasedKeysDeleted: Number(keys.changes) };
    });
  }

  getViewerEpoch(scope: Scope): number | null {
    return this.#viewerEpoch(scope)?.epoch ?? null;
  }

  forgetViewer(scope: Scope, now: number): { newEpoch: number } {
    if (!Number.isFinite(now) || now < 0) throw new Error('Invalid deletion time');
    return this.#transaction(() => {
      this.#db.prepare(`INSERT INTO viewer_generations(workspace_id,host_id,viewer_id)
        VALUES (?,?,?) ON CONFLICT DO NOTHING`).run(scope.workspaceId, scope.hostId, scope.viewerId);
      const generation = this.#viewerEpoch(scope)!;
      const events = this.#db.prepare(`SELECT source,source_event_id AS sourceEventId,event_id AS eventId,
        source_key_hash AS sourceKeyHash
        FROM live_events WHERE workspace_id=? AND host_id=? AND viewer_id=?`)
        .all(scope.workspaceId, scope.hostId, scope.viewerId) as
        { source: string; sourceEventId: string; eventId: string; sourceKeyHash: string | null }[];
      this.#db.prepare('DELETE FROM erased_event_keys WHERE expires_at<=?').run(now);
      const insertHash = this.#db.prepare(`INSERT INTO erased_event_keys(workspace_id,host_id,key_hash,expires_at)
        VALUES (?,?,?,?) ON CONFLICT(workspace_id,host_id,key_hash)
        DO UPDATE SET expires_at=excluded.expires_at`);
      for (const event of events) {
        insertHash.run(scope.workspaceId, scope.hostId,
          event.sourceKeyHash ?? eventKey(event.source, event.sourceEventId), now + 90 * 86_400_000);
      }
      this.#db.prepare(`DELETE FROM memories WHERE workspace_id=? AND host_id=? AND
        (viewer_id=? OR memory_id IN (
          SELECT me.memory_id FROM memory_evidence me
          JOIN live_events e ON e.event_id=me.event_id
          WHERE e.workspace_id=? AND e.host_id=? AND e.viewer_id=?
        ))`).run(scope.workspaceId, scope.hostId, scope.viewerId,
          scope.workspaceId, scope.hostId, scope.viewerId);
      this.#db.prepare(`DELETE FROM profile_facts
        WHERE workspace_id=? AND host_id=? AND viewer_id=?`)
        .run(scope.workspaceId, scope.hostId, scope.viewerId);
      this.#db.prepare(`DELETE FROM live_events
        WHERE workspace_id=? AND host_id=? AND viewer_id=?`)
        .run(scope.workspaceId, scope.hostId, scope.viewerId);
      this.#db.prepare(`UPDATE viewer_generations SET epoch=?, forgotten_at=?
        WHERE workspace_id=? AND host_id=? AND viewer_id=?`)
        .run(generation.epoch + 1, now, scope.workspaceId, scope.hostId, scope.viewerId);
      return { newEpoch: generation.epoch + 1 };
    });
  }
}
