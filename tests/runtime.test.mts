import test from 'node:test';
import assert from 'node:assert/strict';
import { publishPersona } from '../src/domain/persona.mts';
import { HostRuntime } from '../src/domain/runtime.mts';

function setup(sessionId = 'session-1') {
  const persona = publishPersona({
    hostId: 'host-1', version: 1, name: '小夏', facts: ['擅长讲故事'],
    baseline: { pleasure: 0, activation: 0.5, willingness: 0.6, fatigue: 0 },
    maxExpression: 2
  });
  return { persona, runtime: new HostRuntime(sessionId, persona, 0) };
}

test('事件影响限幅，变化有记录，随时间回归人格基线', () => {
  const { runtime, persona } = setup();
  const change = runtime.apply({ id: 'e1', at: 0, delta: { pleasure: 1 } });
  assert.equal(change?.after.pleasure, 0.15);
  assert.equal(change?.before.pleasure, 0);
  runtime.apply({ id: 'clock', at: 120_000, delta: {} });
  assert.ok(Math.abs(runtime.mood.pleasure - 0.15 / Math.E) < 1e-10);
  assert.equal(persona.baseline.pleasure, 0);
});

test('同一事件不重复累计，拒绝倒退时间和无效数值', () => {
  const { runtime } = setup();
  runtime.apply({ id: 'e1', at: 100, delta: { pleasure: 0.1 } });
  assert.equal(runtime.apply({ id: 'e1', at: 100, delta: { pleasure: 0.1 } }), null);
  assert.equal(runtime.mood.pleasure, 0.1);
  assert.throws(() => runtime.apply({ id: 'bad-time', at: 99, delta: {} }));
  assert.throws(() => runtime.apply({ id: 'bad-delta', at: 100, delta: { pleasure: NaN } }));
  assert.equal(runtime.mood.pleasure, 0.1);
});

test('未知用户默认无升级许可，拒绝保持生效直至收到新的明确同意', () => {
  const { runtime } = setup();
  assert.equal(runtime.expressionLevel('v1'), 0);
  runtime.permit('v1', 3);
  assert.equal(runtime.expressionLevel('v1'), 2);
  const old = runtime.issueTicket('v1');
  runtime.refuse('v1');
  assert.equal(runtime.expressionLevel('v1'), 0);
  assert.equal(runtime.isCurrent(old), false);
  assert.equal(runtime.isCurrent(runtime.issueTicket('v1')), true);
  runtime.grantExplicitConsent('v1', 2, 'consent-event-1');
  runtime.refuse('v1');
  runtime.grantExplicitConsent('v1', 2, 'consent-event-1');
  assert.throws(() => runtime.permit('v1', 1));
  assert.equal(runtime.expressionLevel('v1'), 0);
  runtime.grantExplicitConsent('v1', 1, 'consent-event-2');
  assert.equal(runtime.expressionLevel('v1'), 1);
});

test('人工接管后迟到任务失效，恢复运行也不会复活旧任务', async () => {
  const { runtime } = setup();
  const ticket = runtime.issueTicket('v1');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lateResult = gate.then(() => runtime.isCurrent(ticket));
  runtime.takeover();
  assert.equal(runtime.phase, 'takeover');
  assert.throws(() => runtime.issueTicket('v1'));
  runtime.resume();
  release();
  assert.equal(await lateResult, false);
  assert.equal(runtime.isCurrent(runtime.issueTicket('v1')), true);
});

test('删除观众使旧任务失效，不影响其他观众', () => {
  const { runtime } = setup();
  runtime.permit('v1', 2);
  const removed = runtime.issueTicket('v1');
  const other = runtime.issueTicket('v2');
  runtime.forget('v1');
  assert.equal(runtime.isCurrent(removed), false);
  assert.equal(runtime.expressionLevel('v1'), 0);
  assert.equal(runtime.isCurrent(other), true);
});

test('会话结束不可恢复，不同会话不能接受彼此凭证', () => {
  const { runtime } = setup();
  const foreign = setup('session-2').runtime.issueTicket('v1');
  assert.equal(runtime.isCurrent(foreign), false);
  runtime.end();
  assert.throws(() => runtime.resume());
  assert.throws(() => runtime.issueTicket('v1'));
  assert.throws(() => runtime.apply({ id: 'late', at: 0, delta: {} }));
});

test('非法许可不改变已有边界', () => {
  const { runtime } = setup();
  runtime.permit('v1', 1);
  for (const level of [-1, 4, 0.5, NaN]) {
    assert.throws(() => runtime.permit('v1', level));
  }
  assert.equal(runtime.expressionLevel('v1'), 1);
});
