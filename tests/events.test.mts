import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/domain/events.mts';
import type { LiveEventInput } from '../src/domain/events.mts';

const now = 1_800_000_000_000;
function sample(overrides: Partial<LiveEventInput> = {}): LiveEventInput {
  return {
    eventId: 'event-1', workspaceId: 'workspace-1', hostId: 'host-1',
    sessionId: 'session-1', source: 'simulator', sourceEventId: 'source-1',
    type: 'chat', occurredAt: now - 1000, receivedAt: now,
    viewerId: 'viewer-1', visibility: 'public', content: '你好，主播！',
    ...overrides
  };
}

test('接受有效事件并冻结验证后的副本', () => {
  const input = sample({ hostId: ' host-1 ' });
  const event = validateEvent(input, now);
  assert.equal(event.hostId, 'host-1');
  assert.equal(Object.isFrozen(event), true);
  assert.equal(input.hostId, ' host-1 ');
});

test('拒绝缺失作用域、未知类型和非法可见范围', () => {
  assert.throws(() => validateEvent(sample({ workspaceId: ' ' }), now));
  assert.throws(() => validateEvent(sample({ type: 'unknown' as LiveEventInput['type'] }), now));
  assert.throws(() => validateEvent(sample({ visibility: 'secret' as LiveEventInput['visibility'] }), now));
});

test('拒绝超长文本、未来接收时间和无效时间戳', () => {
  assert.throws(() => validateEvent(sample({ content: 'x'.repeat(4001) }), now));
  assert.throws(() => validateEvent(sample({ receivedAt: now + 300_001 }), now));
  assert.throws(() => validateEvent(sample({ occurredAt: Number.NaN }), now));
});

test('拒绝超过 24 小时的旧事件以及超出容差的未来事件', () => {
  assert.throws(() => validateEvent(sample({ occurredAt: now - 86_400_001 }), now));
  assert.throws(() => validateEvent(sample({ occurredAt: now + 300_001 }), now));
});
