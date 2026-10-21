import assert from 'node:assert/strict';
import { publishPersona } from '../src/domain/persona.mts';
import { HostRuntime } from '../src/domain/runtime.mts';

const persona = publishPersona({
  hostId: 'demo-host', version: 1, name: '小夏', facts: ['擅长讲故事'],
  baseline: { pleasure: 0, activation: 0.5, willingness: 0.6, fatigue: 0 },
  maxExpression: 2
});
const runtime = new HostRuntime('demo-session', persona, 0);
console.log('演练模式：人格与状态内核，不连接真实模型或数字人。');
console.log('角色：', persona.name, '版本：', persona.version);
console.log('观众称赞：', runtime.apply({ id: 'praise', at: 0, delta: { pleasure: 0.1 } }));
console.log('两分钟后：', runtime.apply({ id: 'clock', at: 120_000, delta: {} }));
runtime.permit('viewer-1', 2);
const pending = runtime.issueTicket('viewer-1');
runtime.refuse('viewer-1');
assert.equal(runtime.isCurrent(pending), false);
console.log('观众拒绝后表达等级：', runtime.expressionLevel('viewer-1'));
const next = runtime.issueTicket('viewer-1');
runtime.takeover();
runtime.resume();
assert.equal(runtime.isCurrent(next), false);
console.log('人工接管并恢复后，旧任务仍已取消。');
runtime.end();
assert.equal(runtime.phase, 'ended');
console.log('演练完成，会话已结束。');
