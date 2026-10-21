import assert from 'node:assert/strict';
import { openDatabase } from '../src/storage/database.mts';
import { MemoryRepository } from '../src/storage/memory-repository.mts';
import type { LiveEventInput } from '../src/domain/events.mts';

const now = Date.now();
const db = openDatabase();
const repository = new MemoryRepository(db);
const scope = { workspaceId: 'demo-workspace', hostId: 'demo-host', viewerId: 'demo-viewer' };
const event: LiveEventInput = {
  eventId: 'demo-event-1', ...scope, sessionId: 'demo-session',
  source: 'simulator', sourceEventId: 'demo-source-1', type: 'chat',
  occurredAt: now - 100, receivedAt: now, visibility: 'public',
  content: '我喜欢爵士乐。'
};
const ingest = repository.ingestEvent(event, now);
assert.equal(ingest.inserted, true);
repository.setProfileFact({
  factId: 'demo-fact-1', ...scope, key: 'favorite_music', value: '爵士',
  kind: 'explicit', confidence: 1, createdAt: now, expiresAt: null,
  evidenceEventId: event.eventId
}, ingest.viewerEpoch!);
repository.savePrivateMemory({
  memoryId: 'demo-memory-1', ...scope, visibility: 'private', kind: 'preference',
  content: '这位观众喜欢爵士乐。', confidence: 1, createdAt: now,
  expiresAt: null, pinned: false, evidenceEventIds: [event.eventId]
}, ingest.viewerEpoch!);
console.log('删除前记忆数：', repository.listMemories(scope, now).length);
const deletion = repository.forgetViewer(scope, now + 1);
console.log('删除后记忆数：', repository.listMemories(scope, now + 1).length);
assert.equal(repository.listMemories(scope, now + 1).length, 0);
assert.throws(() => repository.savePrivateMemory({
  memoryId: 'stale-memory', ...scope, visibility: 'private', kind: 'preference',
  content: '不应被写回。', confidence: 1, createdAt: now + 2,
  expiresAt: null, pinned: false, evidenceEventIds: [event.eventId]
}, ingest.viewerEpoch!), /stale viewer epoch/);
assert.equal(deletion.newEpoch, 1);
console.log('旧代次写入被拒；该演练仅使用模拟观众数据。');
db.close();
