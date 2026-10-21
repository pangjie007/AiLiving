# AiLiving

娱乐型写实 AI 主播管理平台，当前交付人格与状态内核。

## 本机运行

需要 Node.js 26。当前里程碑无第三方依赖，无需安装包。

运行测试：`npm test`

运行演练：`npm run demo`

## 当前能力

不可变人格发布、有限幅的状态更新和时间衰减、拒绝后的许可锁定、新同意事件去重、拒绝与人工接管后的任务取消、结束会话及跨会话凭证隔离。把可信同意事件接入正式服务时，服务端仍须验证来源与观众身份。

## 当前边界

尚无管理界面、数据持久化、分层记忆、智能决策、节目播放器、真实语音和数字人服务。规则与脚本用于机制验证，不代表真实主播智能质量。原生 TypeScript 执行尚未包含静态类型检查。

## 设计与计划

- [完整系统设计](docs/superpowers/specs/2026-10-21-ai-host-management-design.md)
- [开发路线](docs/superpowers/plans/2026-10-21-ai-host-delivery-roadmap.md)
- [首个里程碑计划](docs/superpowers/plans/2026-10-21-persona-state-kernel.md)
