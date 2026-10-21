# 人格与状态内核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox (`- [x]`) syntax for tracking. Do not delegate unless the user explicitly chooses agent execution.

**Goal:** 交付一个可独立运行、可测试的角色内核，验证稳定人格、动态状态、拒绝约束、接管取消与场景演练。

**Architecture:** 人格发布生成不可变快照；运行实例维护时间驱动的状态和可撤销执行凭证。通过显式事件和虚拟时间验证机制，内核不调用外部服务、不生成正式直播输出，也不包含尚未完成的记忆与导演实现。

**Tech Stack:** TypeScript 的可擦除类型语法、Node.js 原生测试运行器及标准库。当前机器 Node v26.4.0、npm 11.17.0；本里程碑不安装第三方依赖。原生执行不等于静态类型检查，后续应用工具链单独增加 TypeScript 检查。

---

## 范围与文件结构

这是完整设计阶段一的第一个里程碑。覆盖设计第 5、6 节与第 13 节的取消基础；不声称已经完成画像、记忆、模型、节目、管理界面或真实数字人接入。

```text
package.json                         本机命令
.gitignore                           排除未来密钥、数据库和上传文件
src/domain/types.mts                 不含第三方依赖的公共类型
src/domain/persona.mts               人格校验与不可变发布快照
src/domain/runtime.mts               时间、状态、边界和取消代次
tests/persona.test.mts               发布与输入校验
tests/runtime.test.mts               状态、拒绝和迟到执行
scripts/demo.mts                     可重复的演练入口
README.md                            当前能力、命令和限制
```

所有命令在项目根目录执行。计划中的全部任务由同一执行者顺序完成，不创建不可写的 Git worktree，不声称已经提交代码。

## Task 1：定义契约与运行命令

**Files:** Create `package.json`, `.gitignore`, `src/domain/types.mts`.

- [x] 创建 `package.json`，内容如下：

```json
{
  "name": "ai-living",
  "private": true,
  "type": "module",
  "engines": { "node": ">=26 <27" },
  "scripts": {
    "test": "node --test tests/*.test.mts",
    "demo": "node scripts/demo.mts"
  }
}
```

- [x] 创建 `.gitignore`，内容如下：

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
data/
uploads/
*.sqlite
*.sqlite-shm
*.sqlite-wal
```

- [x] 创建 `src/domain/types.mts`：

```typescript
export type Phase = 'chatting' | 'takeover' | 'ended';
export type Mood = Readonly<{
  pleasure: number;
  activation: number;
  willingness: number;
  fatigue: number;
}>;
export type PersonaInput = {
  hostId: string;
  version: number;
  name: string;
  facts: string[];
  baseline: Mood;
  maxExpression: number;
};
export type Persona = Readonly<{
  hostId: string;
  version: number;
  name: string;
  facts: readonly string[];
  baseline: Mood;
  maxExpression: number;
}>;
export type MoodEvent = {
  id: string;
  at: number;
  delta: Partial<Mood>;
};
export type Transition = Readonly<{
  eventId: string;
  at: number;
  before: Mood;
  after: Mood;
}>;
export type Ticket = Readonly<{
  sessionId: string;
  epoch: number;
  viewerId: string;
  viewerEpoch: number;
}>;
```

- [x] 执行 `node --version` 和 `npm pkg get scripts`，确认当前运行时为 Node 26 且脚本路径准确。此步骤只有配置，不添加无意义的配置测试。

## Task 2：人格发布与不可变快照

**Files:** Create `tests/persona.test.mts`, `src/domain/persona.mts`.

- [x] 先编写 `tests/persona.test.mts`：

```typescript
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
```

- [x] 为运行测试添加最小接口骨架 `src/domain/persona.mts`，仅导出 `publishPersona`，函数体为 `throw new Error('Persona publishing is not implemented')`，参数和返回类型使用下方实现中的类型。执行 `node --test tests/persona.test.mts`，确认不可变快照用例因尚未实现而失败，不是语法或路径错误。

- [x] 将骨架替换为完整实现：

```typescript
import type { Persona, PersonaInput } from './types.mts';

export function publishPersona(input: PersonaInput): Persona {
  if (!input.hostId.trim() || !input.name.trim() ||
      !Number.isInteger(input.version) || input.version < 1) {
    throw new Error('Invalid identity or version');
  }
  if (!Number.isInteger(input.maxExpression) ||
      input.maxExpression < 0 || input.maxExpression > 3) {
    throw new Error('Expression level must be an integer from 0 to 3');
  }
  const ranges = {
    pleasure: [-1, 1], activation: [0, 1],
    willingness: [0, 1], fatigue: [0, 1]
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const value = input.baseline[key];
    const [min, max] = ranges[key];
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Invalid baseline: ${key}`);
    }
  }
  if (input.facts.some(fact => !fact.trim())) {
    throw new Error('Empty persona fact');
  }
  return Object.freeze({
    hostId: input.hostId.trim(), version: input.version,
    name: input.name.trim(),
    facts: Object.freeze([...input.facts]),
    baseline: Object.freeze({ ...input.baseline }),
    maxExpression: input.maxExpression
  });
}
```

- [x] 执行 `node --test tests/persona.test.mts`，预期 2 个测试通过；保留失败与成功的实际输出作为开发记录。

## Task 3：状态、拒绝约束与执行代次

**Files:** Create `tests/runtime.test.mts`, `src/domain/runtime.mts`.

- [x] 先编写全部行为测试：

```typescript
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
```

- [x] 添加仅含公共签名与抛出 `new Error('Runtime is not implemented')` 的 `HostRuntime` 骨架，公共 API 与下一步实现一致。运行 `node --test tests/runtime.test.mts`，确认失败原因是运行内核尚未实现，不是导入或语法错误。

- [x] 使用以下实现替换骨架：

```typescript
import type { Mood, MoodEvent, Persona, Phase, Ticket, Transition } from './types.mts';

const limits = {
  pleasure: [-1, 1], activation: [0, 1],
  willingness: [0, 1], fatigue: [0, 1]
} as const;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export class HostRuntime {
  readonly sessionId: string;
  readonly persona: Persona;
  #phase: Phase = 'chatting';
  #epoch = 0;
  #at: number;
  #mood: Mood;
  #seen = new Set<string>();
  #permissions = new Map<string, number>();
  #viewerEpochs = new Map<string, number>();
  #refused = new Set<string>();
  #consentEvents = new Map<string, Set<string>>();

  constructor(sessionId: string, persona: Persona, startedAt: number) {
    if (!sessionId.trim() || !Number.isFinite(startedAt) || startedAt < 0) {
      throw new Error('Invalid session or start time');
    }
    this.sessionId = sessionId;
    this.persona = persona;
    this.#at = startedAt;
    this.#mood = persona.baseline;
  }

  get mood(): Mood { return this.#mood; }
  get phase(): Phase { return this.#phase; }

  apply(event: MoodEvent): Transition | null {
    if (this.#phase !== 'chatting') throw new Error('Automatic state updates paused');
    if (!event.id.trim()) throw new Error('Missing event ID');
    if (this.#seen.has(event.id)) return null;
    if (!Number.isFinite(event.at) || event.at < this.#at) throw new Error('Invalid time');
    for (const [key, value] of Object.entries(event.delta)) {
      if (!Object.hasOwn(limits, key) || !Number.isFinite(value)) {
        throw new Error('Invalid mood delta');
      }
    }
    const before = this.#mood;
    const next = { ...before };
    const decay = Math.exp(-(event.at - this.#at) / 120_000);
    for (const key of Object.keys(limits) as (keyof Mood)[]) {
      const [min, max] = limits[key];
      const baseline = this.persona.baseline[key];
      next[key] = clamp(baseline + (before[key] - baseline) * decay +
        clamp(event.delta[key] ?? 0, -0.15, 0.15), min, max);
    }
    this.#mood = Object.freeze(next);
    this.#at = event.at;
    this.#seen.add(event.id);
    return Object.freeze({ eventId: event.id, at: event.at, before, after: this.#mood });
  }

  expressionLevel(viewerId: string): number {
    return Math.min(this.persona.maxExpression, this.#permissions.get(viewerId) ?? 0);
  }

  permit(viewerId: string, level: number): void {
    if (!viewerId.trim() || !Number.isInteger(level) || level < 0 || level > 3) {
      throw new Error('Invalid explicit permission');
    }
    if (this.#refused.has(viewerId)) {
      throw new Error('A new explicit consent event is required after refusal');
    }
    this.#permissions.set(viewerId, level);
    this.#invalidateViewer(viewerId);
  }

  grantExplicitConsent(viewerId: string, level: number, sourceEventId: string): void {
    if (!viewerId.trim() || !sourceEventId.trim() ||
        !Number.isInteger(level) || level < 0 || level > 3) {
      throw new Error('Invalid explicit consent');
    }
    let seenEvents = this.#consentEvents.get(viewerId);
    if (!seenEvents) {
      seenEvents = new Set<string>();
      this.#consentEvents.set(viewerId, seenEvents);
    }
    if (seenEvents.has(sourceEventId)) return;
    seenEvents.add(sourceEventId);
    this.#refused.delete(viewerId);
    this.#permissions.set(viewerId, level);
    this.#invalidateViewer(viewerId);
  }

  refuse(viewerId: string): void {
    if (!viewerId.trim()) throw new Error('Missing viewer ID');
    this.#refused.add(viewerId);
    this.#permissions.set(viewerId, 0);
    this.#invalidateViewer(viewerId);
  }

  forget(viewerId: string): void {
    this.#permissions.delete(viewerId);
    this.#refused.delete(viewerId);
    this.#consentEvents.delete(viewerId);
    this.#invalidateViewer(viewerId);
  }

  #invalidateViewer(viewerId: string): void {
    this.#viewerEpochs.set(viewerId, (this.#viewerEpochs.get(viewerId) ?? 0) + 1);
  }

  issueTicket(viewerId: string): Ticket {
    if (this.#phase !== 'chatting' || !viewerId.trim()) throw new Error('Cannot issue ticket');
    return Object.freeze({
      sessionId: this.sessionId, epoch: this.#epoch, viewerId,
      viewerEpoch: this.#viewerEpochs.get(viewerId) ?? 0
    });
  }

  isCurrent(ticket: Ticket): boolean {
    return this.#phase === 'chatting' && ticket.sessionId === this.sessionId &&
      ticket.epoch === this.#epoch &&
      ticket.viewerEpoch === (this.#viewerEpochs.get(ticket.viewerId) ?? 0);
  }

  takeover(): void {
    if (this.#phase === 'ended') throw new Error('Session ended');
    this.#phase = 'takeover';
    this.#epoch++;
  }

  resume(): void {
    if (this.#phase !== 'takeover') throw new Error('Session is not in takeover');
    this.#phase = 'chatting';
    this.#epoch++;
  }

  end(): void {
    this.#phase = 'ended';
    this.#epoch++;
  }
}
```

- [x] 执行 `npm test`，预期 9 个测试全部通过。`grantExplicitConsent` 要求来源事件 ID 并对重复事件去重；当前纯内存内核仍不能验证该事件来自用户本人，后续服务端必须校验事件身份与来源，语言模型不能直接调用 `permit` 或同意接口。

- [x] 审阅实现的范围：运行实例只持有临时边界，不提供持久化；`forget` 只验证取消基础，不等价于完整个人数据删除。后续记忆里程碑实现数据库事务、来源删除和持久化拒绝，不复用“会话结束即遗忘边界”的语义。

## Task 4：演练入口与交付说明

**Files:** Create `scripts/demo.mts`, `README.md`.

- [x] 创建 `scripts/demo.mts`：

```typescript
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
```

- [x] 创建 `README.md`，内容如下：

```markdown
# AiLiving

娱乐型写实 AI 主播管理平台，当前交付人格与状态内核。

## 本机运行

需要 Node.js 26。当前里程碑无第三方依赖，无需安装包。

运行测试：`npm test`

运行演练：`npm run demo`

## 当前能力

不可变人格发布、有限幅的状态更新和时间衰减、拒绝后的许可锁定、由新同意事件恢复许可、拒绝和接管后的任务取消、结束会话及跨会话凭证隔离。

## 当前边界

尚无管理界面、数据持久化、分层记忆、智能决策、节目播放器、真实语音和数字人服务。规则与脚本用于机制验证，不代表真实主播智能质量。原生 TypeScript 执行尚未包含静态类型检查。

## 设计与计划

- [完整系统设计](docs/superpowers/specs/2026-10-21-ai-host-management-design.md)
- [开发路线](docs/superpowers/plans/2026-10-21-ai-host-delivery-roadmap.md)
- [首个里程碑计划](docs/superpowers/plans/2026-10-21-persona-state-kernel.md)
```

- [x] 执行 `npm test`，确认实际为 9 个通过、0 个失败；执行 `npm run demo`，确认结束提示出现且进程退出码为 0。
- [x] 根据实际测试结果更新本计划复选框，记录命令与结果；没有运行的验证不标记为通过。

## 自审与后续接口

- [x] 检查类型、路径、导出与测试中的名称完全一致。
- [x] 确认首次执行只产生内核源文件，不触发外部消息、网络服务或真实媒体输出。
- [x] 确认状态记录不被描述为完整事件持久化，取消凭证不被描述为认证令牌。
- [x] 本计划验收后，下一份计划扩展标准事件、SQLite 记忆证据和删除事务，沿用 persona、runtime 与 ticket 的明确边界；引入工作空间作用域和持久化拒绝，不把临时 Map 当作生产存储。

## 执行记录

计划状态：首个里程碑已执行完成。实际工作区测试与演练结果记录如下。

### 计划自审记录（2026-10-21）

将本文完整代码块提取到独立临时目录，使用本机 Node v26.4.0 运行 `npm test`：9 个通过、0 个失败；运行 `npm run demo`：状态衰减、拒绝、接管恢复及结束演练正常，退出码为 0。

计划代码预检不是工作区验收。工作区实施按测试先失败后通过执行；拒绝后恢复许可的测试曾按预期失败，补充拒绝锁定与新同意事件去重后通过。

### 工作区实施验收（2026-10-21）

- `npm test`：9 项通过，0 项失败。
- `npm run demo`：展示人格版本、称赞导致的状态变化、两分钟衰减、拒绝后强度归零、人工接管后旧票据失效，并以退出码 0 结束。
- 本机 Node 26 原生执行 TypeScript 可擦除语法。当前未安装或运行静态类型检查器；后续应用工具链需要补充。
- 检查过当前源文件中的未实现标记；没有扫描到 TODO、TBD 或测试骨架残留。
- 当前工作区无 Git 仓库，因此未能使用 worktree 或记录 Git 提交。
- 该里程碑没有交付持久化、画像/记忆、推理、导演、节目播放器或管理界面。
