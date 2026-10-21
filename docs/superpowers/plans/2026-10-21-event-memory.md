# 观众事件与记忆存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现可持久化、按工作空间/角色/观众隔离的直播事件、画像事实和记忆，支持证据检索、幂等写入、纠错历史、删除及迟到写入阻断。

**Architecture:** 使用 Node 26 内置 `node:sqlite` 与 SQLite 事务，不增加第三方数据库依赖。所有读写经 `MemoryRepository`，先验证作用域和代次；删除在一个事务里撤销记忆/画像/事件，保留短期事件哈希去重标记与代次墓碑，避免旧工作恢复已删数据。

**Tech Stack:** TypeScript 可擦除语法、Node.js 26 原生 `node:sqlite`、`node:test`、SQLite；DB API 同步执行，适用于当前单机单运营者原型，不作为高并发生产方案。

---

## 文件职责

```text
src/domain/events.mts                 标准事件、枚举与边界验证
src/storage/database.mts               数据库连接、约束、schema 版本迁移
src/storage/memory-repository.mts      幂等事件、画像、记忆、删除事务
tests/events.test.mts                  事件格式、时间、载荷限制
tests/storage.test.mts                 SQLite 持久化、隔离、证据、删除
scripts/memory-demo.mts                可重复的画像和遗忘演练
README.md                              更新第二阶段已交付能力
```

## 数据契约

- 工作空间、角色和观众 ID 由上游分配；平台同名用户默认视为不同观众。
- 事件含唯一本地 ID、来源与来源事件 ID、会话、时间、事件类型、可选观众、可见范围和原始文本。
- 画像事实区分 `explicit` 与 `inferred`，带置信度、有效期、证据事件和历史修订；新值覆盖旧值前先标记旧值已被替代。
- 记忆含 `private` 或 `public` 可见范围。私人记忆绑定一个观众；公共记忆不允许引用带观众身份的事件。
- 每位观众有删除代次；异步分析写入必须携带当初捕获的代次。删除后新对话可重新激活身份，但代次递增，旧写入因此过期。
- 删除事务擦除该观众的原始事件、画像、私人记忆及依赖其事件的公共摘要。保留 90 天的不可逆 SHA-256 事件去重哈希与代次墓碑；墓碑不保留文本或昵称，用于阻止旧请求和回放恢复数据。90 天后，24 小时事件时效校验仍会拒绝旧回放。

## Task 1：标准事件和输入校验

**Files:** Create `src/domain/events.mts`, `tests/events.test.mts`.

- [x] 首先编写三个失败测试：接受有效公开消息；拒绝缺少作用域、未知类型、超长文本和非法可见范围；拒绝比收到时间早 24 小时以上或发生在未来 5 分钟之后的事件。测试使用固定时间常量，不读取真实时钟。
- [x] 先添加函数签名骨架 `validateEvent(event, now)` 并抛出 `Error('Event validation is not implemented')`，运行 `node --test tests/events.test.mts`，确认有效事件用例因为骨架而失败。
- [x] 定义 `LiveEventInput`，字段为 `eventId, workspaceId, hostId, sessionId, source, sourceEventId, type, occurredAt, receivedAt, viewerId, visibility, content`；`viewerId` 可为 `null`，`visibility` 为 `public | private`，`type` 为 `chat | viewer_joined | program_request | operator`。
- [x] 实现纯函数 `validateEvent(event: LiveEventInput, now: number): LiveEventInput`：所有 ID trim 后非空且不超过 200 字符，类型和可见范围为允许值，文本不超过 4000 字符，时间是有限非负毫秒数，发生时间不得比 `now` 早 24 小时或晚 5 分钟，收到时间不得晚于 `now + 5 分钟`。返回冻结的浅拷贝；调用方只保留验证后的文本。
- [x] 执行 `node --test tests/events.test.mts`，确认三项用例通过。

## Task 2：数据库和第一版迁移

**Files:** Create `src/storage/database.mts`, `tests/storage.test.mts`.

- [x] 写数据库测试：内存库连接后 `schema_migrations` 为版本 1；SQLite 外键约束已启用；重新打开文件库后同一版本仍在。
- [x] 最小 `openDatabase(path)` 骨架只创建 `DatabaseSync` 后抛出标记错误，先运行迁移测试确认因迁移缺失而失败。
- [x] 实现 `openDatabase(path = ':memory:')`：创建 `DatabaseSync`、执行 `PRAGMA foreign_keys = ON`、设置 `PRAGMA busy_timeout = 5000`，读取 `schema_migrations` 并在 `BEGIN IMMEDIATE` 事务中应用版本 1。事务失败执行 `ROLLBACK` 并原样抛错。
- [x] migration 创建下列表与约束：

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE viewer_generations (
  workspace_id TEXT NOT NULL, host_id TEXT NOT NULL, viewer_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  forgotten_at INTEGER, PRIMARY KEY (workspace_id, host_id, viewer_id)
) STRICT;
CREATE TABLE live_events (
  event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, host_id TEXT NOT NULL,
  session_id TEXT NOT NULL, source TEXT NOT NULL, source_event_id TEXT NOT NULL,
  type TEXT NOT NULL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
  viewer_id TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  content TEXT NOT NULL,
  UNIQUE (workspace_id, host_id, source, source_event_id),
  FOREIGN KEY (workspace_id, host_id, viewer_id)
    REFERENCES viewer_generations(workspace_id, host_id, viewer_id)
) STRICT;
CREATE TABLE erased_event_keys (
  workspace_id TEXT NOT NULL, host_id TEXT NOT NULL, key_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, host_id, key_hash)
) STRICT;
CREATE TABLE profile_facts (
  fact_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, host_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('explicit','inferred')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at INTEGER NOT NULL, expires_at INTEGER, superseded_at INTEGER,
  FOREIGN KEY (workspace_id, host_id, viewer_id)
    REFERENCES viewer_generations(workspace_id, host_id, viewer_id)
) STRICT;
CREATE TABLE profile_evidence (
  fact_id TEXT NOT NULL REFERENCES profile_facts(fact_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES live_events(event_id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, event_id)
) STRICT;
CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, host_id TEXT NOT NULL,
  viewer_id TEXT, visibility TEXT NOT NULL CHECK (visibility IN ('private','public')),
  kind TEXT NOT NULL, content TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at INTEGER NOT NULL, expires_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  CHECK ((visibility='private' AND viewer_id IS NOT NULL) OR
         (visibility='public' AND viewer_id IS NULL)),
  FOREIGN KEY (workspace_id, host_id, viewer_id)
    REFERENCES viewer_generations(workspace_id, host_id, viewer_id)
) STRICT;
CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES live_events(event_id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, event_id)
) STRICT;
```

- [x] 外键复合引用要求 `viewer_generations` 主键复合顺序匹配；测试应真实插入与违反约束两种情况，而非只检查 pragma 返回值。
- [x] 执行 `node --test tests/storage.test.mts`，确认迁移和重启测试通过。

## Task 3：事件、画像和记忆仓库

**Files:** Create `src/storage/memory-repository.mts`, extend `tests/storage.test.mts`.

- [x] 先写以下行为测试再实现仓库：

```typescript
test('来源事件幂等且记忆按工作空间、角色、观众隔离', () => {
  const db = openDatabase();
  const repo = new MemoryRepository(db);
  const event = sampleEvent({ workspaceId: 'w1', hostId: 'h1', viewerId: 'v1' });
  assert.deepEqual(repo.ingestEvent(event, NOW), { inserted: true, viewerEpoch: 0 });
  assert.deepEqual(repo.ingestEvent(event, NOW), { inserted: false, viewerEpoch: 0 });
  repo.savePrivateMemory(sampleMemory({ eventId: event.eventId }), 0);
  assert.equal(repo.listMemories({ workspaceId: 'w1', hostId: 'h1', viewerId: 'v1' }).length, 1);
  assert.equal(repo.listMemories({ workspaceId: 'w1', hostId: 'h1', viewerId: 'v2' }).length, 0);
  assert.equal(repo.listMemories({ workspaceId: 'w2', hostId: 'h1', viewerId: 'v1' }).length, 0);
  db.close();
});

test('画像事实保存来源，冲突修订保留旧值和证据', () => {
  const first = repo.setProfileFact(sampleFact({ value: '爵士', eventId: 'e1' }), 0);
  const second = repo.setProfileFact(sampleFact({ value: '摇滚', eventId: 'e2' }), 0);
  assert.equal(first.superseded, true);
  assert.deepEqual(repo.listProfileFacts(scope), [{ value: '摇滚', evidence: ['e2'] }]);
  assert.equal(repo.listProfileFactHistory(scope, 'favorite_music').length, 2);
});

test('删除会擦除观众事件、事实和记忆，旧代次写入失败', () => {
  repo.ingestEvent(eventV1, NOW);
  repo.savePrivateMemory(memoryV1, 0);
  repo.setProfileFact(factV1, 0);
  const result = repo.forgetViewer(scope, NOW);
  assert.equal(result.newEpoch, 1);
  assert.equal(repo.listRawEvents(scope).length, 0);
  assert.equal(repo.listProfileFacts(scope).length, 0);
  assert.equal(repo.listMemories(scope).length, 0);
  assert.throws(() => repo.savePrivateMemory(memoryV1, 0), /stale viewer epoch/);
});

test('旧来源事件回放被擦除哈希拦截，新事件使用新代次', () => {
  repo.forgetViewer(scope, NOW);
  assert.deepEqual(repo.ingestEvent(eventV1, NOW), { inserted: false, viewerEpoch: 1 });
  assert.deepEqual(repo.ingestEvent(eventV2, NOW + 1), { inserted: true, viewerEpoch: 1 });
  assert.throws(() => repo.savePrivateMemory(memoryV2, 0), /stale viewer epoch/);
  assert.doesNotThrow(() => repo.savePrivateMemory(memoryV2, 1));
});
```

- [x] 在 `memory-repository.mts` 定义公开类型 `Scope`, `MemoryInput`, `ProfileFactInput` 和 `ViewerEpochError`。`Scope` 含 `workspaceId, hostId, viewerId`。
- [x] `MemoryRepository.ingestEvent(input, now)` 先调用事件校验；按 `(source, sourceEventId)` 查唯一约束，重复返回 `inserted:false`。新观众建代次 0；墓碑观众新鲜新事件清除 `forgotten_at` 并返回递增后的当前代次。`erased_event_keys` 命中时不插入且不激活观众。
- [x] `setProfileFact(input, expectedEpoch, now)` 在事务内要求观众存在、未删除、代次相同，证据事件属于同一工作空间、角色和观众；明确事实置信度强制为 1，推测值置信度须在 0.6–1；创建时间不能晚于当前操作时间 5 分钟以上；只有 `createdAt` 严格晚于当前事实时才替换旧值，迟到或同时间版本返回 `ignored:true`。
- [x] `savePrivateMemory(input, expectedEpoch, now)` 验证观众代次、证据事件归属、非空内容和创建时间；`savePublicMemory(input, now)` 要求证据事件 `viewer_id IS NULL AND visibility='public'`。两种记忆至少各有一个证据事件。
- [x] `listProfileFacts(scope, now)` 仅返回匹配作用域、未过期、未被替代事实；`listProfileFactHistory` 返回同作用域事实及证据；`listMemories(scope, now)` 返回该观众私人记忆和公开记忆，排除过期记忆。
- [x] `forgetViewer(scope, now)` 用 `BEGIN IMMEDIATE` 保证原子性：确保代次行存在、算出该观众来源事件集合、写入 90 天去重哈希、删除私人记忆及引用这些事件的公开记忆、删除该观众全部画像和原始事件、代次加一并写 `forgotten_at`。失败回滚所有步骤。不要在删除日志记录昵称、消息正文或来源事件原文。
- [x] `purgeExpired(now)` 用单个事务擦除 30 天前事件正文与原来源 ID，保留无正文事件证据行和来源 ID SHA-256 摘要，并写 90 天回放拦截键；摘要保留到事件删除，确保迟来的遗忘操作能重新延长拦截期。低熵或可猜测的来源 ID 可能被候选值比对推断。删除过期记忆、事实和去重键。清理任务由未来服务端定时调度。
- [x] schema v2 增加事件正文清除标志，v3 增加来源 ID SHA-256 摘要；为已有 v1 数据库提供原地迁移并回填摘要，保留原有事件。
- [x] 普通事实和未固定记忆在未指定期限时默认 90 天，显式期限最多 90 天；固定记忆不自动过期。
- [x] 所有 SQL 使用预备语句绑定参数；作用域字段始终来自每个方法参数并出现在 WHERE 条件，不接受调用方提供任意 SQL 片段。
- [x] 运行 `node --test tests/storage.test.mts`，确认幂等、范围隔离、证据历史、删除回放和旧代次拦截用例通过。

## Task 4：文件持久化和操作演练

**Files:** Extend `tests/storage.test.mts`; create `scripts/memory-demo.mts`; modify `README.md`.

- [x] 写文件库重启测试：在临时目录写事件、画像和记忆，关闭数据库后重开并确认能查到；清理时删除 DB、WAL 和 SHM 文件。
- [x] 写事务回滚测试：尝试写入找不到来源事件的记忆，断言操作报错，记忆表行数保持 0，事件和观众代次不变。
- [x] `memory-demo.mts` 使用内存库创建模拟观众、入一条明确兴趣事件、保存偏好事实与私人记忆、列出内容，然后执行删除并打印“删除前 1 条记忆/删除后 0 条、旧代次写入被拒”。不得接收或输出真实用户数据。
- [x] README 加入“事件与记忆存储”章节，列出匿名模拟数据、SQLite 文件默认位置 `data/ailiving.sqlite`、本地 demo 命令、删除 90 天哈希/代次墓碑说明，以及当前尚未有管理界面和真实直播接入。
- [x] 执行完整 `npm test`、`npm run demo:memory`、`npm run demo` 和 `git diff --check`。不得只以类型可擦除执行宣称静态类型检查通过。

## 验收与实现边界

- [x] 同一来源事件重放不重复建档、不重复记忆。
- [x] 每次查询和更新严格按工作空间、角色和观众筛选。
- [x] 图片事实与记忆都有可追溯事件证据；新事实修订保留历史。
- [x] 删除事务移除原始正文、画像、私有记忆及受影响的公开摘要；旧代次异步写入失败。
- [x] 过 30 天后只保留无正文事件证据及 90 天去重哈希；清理任务处理原文、过期事实/记忆和 90 天后哈希清理，旧事件新鲜度校验继续拒绝回放。
- [x] SQLite 外键开启，事务异常时不留下部分结果，持久化在关闭重开后生效。
- [x] 本阶段不包含模型生成画像、自动写入生产记忆、前端、跨平台身份合并和正式直播消息发送。

## 自审

- [x] 运行测试代码后更新计划复选框与执行记录；计划步骤必须与仓库真实文件、API 和 SQL 一致。
- [x] 重点核对公共记忆不能经观众私有事件创建，删除任意观众时没有留下引用其事件的摘要。
- [x] Node 内置 `node:sqlite` 的同步 API 适用于当前单进程原型；进程重启持久化必须通过真实文件 DB 测试验证。


## 执行记录（2026-10-21）

- 已实现事件验证、SQLite schema v1、幂等事件仓库、带证据的事实修订、私人/公开记忆查询、事务化删除和过期清理。
- `npm test`：29 项通过，0 项失败；覆盖 v1 原地迁移、30 天原文擦除、90 天过期、哈希清理、延迟遗忘后回放拦截、未来时间拒绝、时间倒序画像写入保护、作用域隔离、重开持久化和事务回滚。
- `npm run demo:memory`：显示删除前 1 条记忆、删除后 0 条，迟到写入拒绝；`npm run demo` 和 `git diff --check` 通过。
- 测试运行时为 Node v26.4.0，数据库来自 Node 内置 `node:sqlite`；没有第三方包。没有静态 TypeScript 检查器。
- 存储接收的 viewerId 必须是内部不透明 ID；真实平台身份映射仍由未来适配器实现。代次墓碑不含昵称或消息正文，仓库不保留平台来源事件原 ID。
- 清理操作需由未来服务端定时调度；普通事实、未固定记忆默认 90 天，固定记忆不自动过期。
