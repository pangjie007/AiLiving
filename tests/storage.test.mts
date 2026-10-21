import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/storage/database.mts';
import { MemoryRepository } from '../src/storage/memory-repository.mts';
import type { LiveEventInput } from '../src/domain/events.mts';
import type { MemoryInput, ProfileFactInput, Scope } from '../src/storage/memory-repository.mts';

const NOW = 1_800_000_000_000;
function event(overrides: Partial<LiveEventInput> = {}): LiveEventInput {
  return {
    eventId: 'e1', workspaceId: 'w1', hostId: 'h1', sessionId: 's1',
    source: 'sim', sourceEventId: 'source-1', type: 'chat',
    occurredAt: NOW - 100, receivedAt: NOW, viewerId: 'v1',
    visibility: 'public', content: '我喜欢爵士乐', ...overrides
  };
}
const scope: Scope = { workspaceId: 'w1', hostId: 'h1', viewerId: 'v1' };
function memory(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    memoryId: 'm1', workspaceId: 'w1', hostId: 'h1', viewerId: 'v1',
    visibility: 'private', kind: 'preference', content: '观众喜欢爵士乐',
    confidence: 1, createdAt: NOW, expiresAt: null, pinned: false,
    evidenceEventIds: ['e1'], ...overrides
  };
}
function fact(overrides: Partial<ProfileFactInput> = {}): ProfileFactInput {
  return {
    factId: 'f1', workspaceId: 'w1', hostId: 'h1', viewerId: 'v1',
    key: 'favorite_music', value: '爵士', kind: 'explicit', confidence: 1,
    createdAt: NOW, expiresAt: null, evidenceEventId: 'e1', ...overrides
  };
}
function fixture() {
  const db = openDatabase();
  return { db, repo: new MemoryRepository(db) };
}

test('database applies schema version one and enables SQLite foreign keys', () => {
  const db = openDatabase();
  assert.equal((db.prepare('SELECT version FROM schema_migrations').get() as { version: number }).version, 1);
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.throws(() => db.prepare(`INSERT INTO live_events (
    event_id, workspace_id, host_id, session_id, source, source_event_id,
    type, occurred_at, received_at, viewer_id, visibility, content
  ) VALUES ('e1','w1','h1','s1','sim','source-1','chat',1,1,'v1','public','hi')`).run());
  db.close();
});

test('database uses the native SQLite connection type', () => {
  const db = openDatabase();
  assert.ok(db instanceof DatabaseSync);
  db.close();
});

test('来源事件幂等且记忆按工作空间、角色、观众隔离', () => {
  const { db, repo } = fixture();
  assert.deepEqual(repo.ingestEvent(event(), NOW), { inserted: true, viewerEpoch: 0 });
  assert.deepEqual(repo.ingestEvent(event(), NOW), { inserted: false, viewerEpoch: 0 });
  repo.savePrivateMemory(memory(), 0);
  assert.equal(repo.listMemories(scope, NOW).length, 1);
  assert.equal(repo.listMemories({ ...scope, viewerId: 'v2' }, NOW).length, 0);
  assert.equal(repo.listMemories({ ...scope, workspaceId: 'w2' }, NOW).length, 0);
  assert.equal(repo.listMemories({ ...scope, hostId: 'h2' }, NOW).length, 0);
  db.close();
});

test('画像事实保存来源，冲突修订保留旧值和证据', () => {
  const { db, repo } = fixture();
  repo.ingestEvent(event(), NOW);
  repo.ingestEvent(event({ eventId: 'e2', sourceEventId: 'source-2', content: '最近喜欢摇滚' }), NOW);
  const first = repo.setProfileFact(fact(), 0);
  const second = repo.setProfileFact(fact({ factId: 'f2', value: '摇滚', evidenceEventId: 'e2' }), 0);
  assert.equal(first.superseded, false);
  assert.equal(second.superseded, true);
  assert.deepEqual(repo.listProfileFacts(scope, NOW).map(row => row.value), ['摇滚']);
  assert.equal(repo.listProfileFactHistory(scope, 'favorite_music').length, 2);
  assert.deepEqual(repo.listProfileFactHistory(scope, 'favorite_music')[0]?.evidenceEventIds, ['e1']);
  db.close();
});

test('私人记忆必须引用同一观众的事件，公共记忆只能引用无身份公开事件', () => {
  const { db, repo } = fixture();
  repo.ingestEvent(event(), NOW);
  repo.ingestEvent(event({ eventId: 'v2-e1', sourceEventId: 'v2-source-1', viewerId: 'v2' }), NOW);
  assert.throws(() => repo.savePrivateMemory(memory({ viewerId: 'v2' }), 0), /evidence/);
  assert.throws(() => repo.savePublicMemory(memory({
    memoryId: 'public-1', viewerId: null, visibility: 'public'
  })));
  repo.ingestEvent(event({
    eventId: 'room-e1', sourceEventId: 'room-source-1', viewerId: null,
    content: '直播间正在讨论音乐'
  }), NOW);
  repo.savePublicMemory(memory({
    memoryId: 'public-1', viewerId: null, visibility: 'public',
    kind: 'room_topic', content: '直播间正在讨论音乐', evidenceEventIds: ['room-e1']
  }));
  db.close();
});

test('删除会擦除观众事件、事实和记忆，旧代次写入失败', () => {
  const { db, repo } = fixture();
  repo.ingestEvent(event(), NOW);
  repo.savePrivateMemory(memory(), 0);
  repo.setProfileFact(fact(), 0);
  db.prepare(`INSERT INTO memories(
    memory_id,workspace_id,host_id,viewer_id,visibility,kind,content,confidence,created_at
  ) VALUES ('legacy-summary','w1','h1',NULL,'public','room_topic','爵士音乐话题',1,?)`).run(NOW);
  db.prepare('INSERT INTO memory_evidence(memory_id,event_id) VALUES (?,?)')
    .run('legacy-summary', 'e1');
  const result = repo.forgetViewer(scope, NOW);
  assert.equal(result.newEpoch, 1);
  assert.equal(repo.listRawEvents(scope).length, 0);
  assert.equal(repo.listProfileFacts(scope, NOW).length, 0);
  assert.equal(repo.listMemories(scope, NOW).length, 0);
  assert.throws(() => repo.savePrivateMemory(memory({ memoryId: 'late' }), 0), /stale viewer epoch/);
  db.close();
});

test('旧来源事件回放被擦除哈希拦截，新事件使用新代次', () => {
  const { db, repo } = fixture();
  repo.ingestEvent(event(), NOW);
  repo.forgetViewer(scope, NOW + 1);
  assert.deepEqual(repo.ingestEvent(event(), NOW + 2), { inserted: false, viewerEpoch: 1 });
  assert.deepEqual(repo.ingestEvent(event({
    eventId: 'e2', sourceEventId: 'source-2', occurredAt: NOW + 1,
    receivedAt: NOW + 2, content: '我现在更喜欢摇滚'
  }), NOW + 2), { inserted: true, viewerEpoch: 1 });
  assert.throws(() => repo.savePrivateMemory(memory({
    memoryId: 'stale', evidenceEventIds: ['e2'], createdAt: NOW + 2
  }), 0), /stale viewer epoch/);
  repo.savePrivateMemory(memory({
    memoryId: 'current', evidenceEventIds: ['e2'], createdAt: NOW + 2
  }), 1);
  db.close();
});

test('文件数据库关闭并重新打开后保留事件、事实和记忆', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ailiving-sqlite-'));
  const path = join(dir, 'state.sqlite');
  try {
    const firstDb = openDatabase(path);
    const firstRepo = new MemoryRepository(firstDb);
    firstRepo.ingestEvent(event(), NOW);
    firstRepo.savePrivateMemory(memory(), 0);
    firstRepo.setProfileFact(fact(), 0);
    firstDb.close();

    const secondDb = openDatabase(path);
    const secondRepo = new MemoryRepository(secondDb);
    assert.equal(secondRepo.listRawEvents(scope).length, 1);
    assert.equal(secondRepo.listMemories(scope, NOW).length, 1);
    assert.equal(secondRepo.listProfileFacts(scope, NOW).length, 1);
    secondDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记忆写入失败会回滚已插入的部分记录', () => {
  const { db, repo } = fixture();
  repo.ingestEvent(event(), NOW);
  db.exec(`CREATE TRIGGER reject_evidence BEFORE INSERT ON memory_evidence
    BEGIN SELECT RAISE(ABORT, 'simulated evidence failure'); END;`);
  assert.throws(() => repo.savePrivateMemory(memory(), 0), /simulated evidence failure/);
  assert.equal(repo.listMemories(scope, NOW).length, 0);
  assert.equal(repo.getViewerEpoch(scope), 0);
  db.close();
});
