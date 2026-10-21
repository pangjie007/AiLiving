import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPersona } from '../src/domain/persona.mts';
import type { PersonaInput } from '../src/domain/types.mts';

function input(): PersonaInput {
  return {
    hostId: 'host-1', version: 1, name: '小夏',
    facts: ['擅长讲故事'], maxExpression: 2,
    baseline: { pleasure: 0.2, activation: 0.5, willingness: 0.6, fatigue: 0 }
  };
}

test('发布快照不受草稿修改影响，嵌套字段不可变', () => {
  const draft = input();
  const persona = publishPersona(draft);
  draft.facts.push('未经发布的新背景');
  assert.deepEqual(persona.facts, ['擅长讲故事']);
  assert.equal(Object.isFrozen(persona), true);
  assert.equal(Object.isFrozen(persona.facts), true);
  assert.equal(Object.isFrozen(persona.baseline), true);
});

test('拒绝越界、非有限数值和无效版本', () => {
  for (const maxExpression of [-1, 4, 1.5, NaN]) {
    assert.throws(() => publishPersona({ ...input(), maxExpression }));
  }
  assert.throws(() => publishPersona({ ...input(), version: 0 }));
  assert.throws(() => publishPersona({ ...input(), hostId: ' ' }));
  assert.throws(() => publishPersona({
    ...input(), baseline: { ...input().baseline, activation: Infinity }
  }));
});
