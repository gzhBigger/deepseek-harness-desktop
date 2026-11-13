# Agent Note: 会话结束后自动研判任务状态

Status: implemented

## Problem

Super Kanban 删除了后台扫描后，任务状态只会由用户手动拖动/编辑、显式「重新研判」或验收改变。
用户希望会话完成一轮后，关联任务能自动根据这一轮的产出更新状态，否则每轮结束都要手动点一次研判。

自动改状态有两个风险：

- 把用户手写的标题、目标、优先级、标签覆盖掉；
- 已完成/已归档的任务被重新打开，或 AI 忙时产生重复请求。

## Decision

在插件宿主监听 DSH 的 `session/event`，只对 `turn/end` 做一次**按任务去抖**的自动研判。

- `turn/end` 后等 6 秒（`AUTO_ANALYZE_SETTLE_MS`），让会话日志落盘、后续事件稳定；同一任务的新 turn 会重置计时器。
- 只处理能通过 `findTaskBySession` 找到的、未归档且未完成的关联任务。
- 复用现有 `task.analyze`，传入 `auto: true`；AI/规则降级、预算保护、并发互斥都沿用既有逻辑，不新建一套分析器。
- `task.analyze` 冲突或被停止时 15 秒后重试；其他错误只记日志，不弹用户 toast。
- `updateTaskFromAnalysis` 在 `auto` 模式下只锁手写字段 `title`/`goal`/`priority`/`tags`，允许 `status`/`progress` 更新；已完成/归档任务在调度前就已跳过。
- 设置新增 `autoAnalyzeOnTurnEnd`，默认 `true`；设置页「AI」区提供开关，文案说明「已完成任务不自动重开」。
- `stop()` 清理所有待执行的计时器，避免插件卸载后回调仍在跑。
- 新任务固定创建为 `backlog`（弹窗不再让用户选状态）；`ContinueTaskModal` 只在草稿真正放入关联/新会话后调用 `task.update` 置 `in_progress`，且不写 `lockedFields`，后续自动研判仍可继续改状态。

## Alternatives considered

- **恢复旧的周期性扫描**：能自动更新，但会持续消耗 AI 额度、扫描无关会话，也违背用户“不需要扫描”的要求。
- **每个 `turn/end` 立即调用 `task.analyze`**：日志可能尚未写完，且同一任务短时间多 turn 会重复请求；需要并发/预算互斥和去抖。
- **新建独立的自动研判器**：会复制 `task.analyze` 的 AI 路由、规则降级、预算与状态字段锁定逻辑，长期容易漂移。
- **自动覆盖全部字段**：能获得更“完整”的卡片，但会覆盖用户手写内容；只允许状态/进度自动更新更安全。

## Consequences

- 会话结束后状态会稍晚（约 6 秒 + 分析耗时）变化，不是即时；这是为了让日志稳定。
- 自动研判仍消耗 AI 预算；预算耗尽时按既有规则降级到本地规则，不会无限重试。
- 服务端监听在插件启动时注册，改宿主代码后需要重启 DSH 才生效；客户端开关刷新页面即可看到。
- 如果任务未关联会话，或 `turn/end` 没有携带可识别的 session id，则不会自动研判。
- `autoAnalyzeOnTurnEnd` 只影响自动入口；显式「重新研判」按钮不受此开关影响。

## Verification

- `node --check client.js server/service.mjs server/store.mjs` 通过。
- `npm test` 316 tests / 316 pass。
- 新增 `tests/service.test.mjs` 用例：`turn/end` 后自动研判关联任务，手写标题保持不变，状态从 `backlog` 更新，AI 降级为 `rules`；`task.create` 默认 `backlog`，置 `in_progress` 后 `lockedFields` 不含 status。
- `tests/client.test.mjs` 断言新建任务弹窗不再有状态选择器，且 `task.create` 固定 `status:"backlog"`。
- `tests/store.test.mjs` 覆盖 `autoAnalyzeOnTurnEnd:false` 与默认 `true`；`tests/ai-models.test.mjs` 覆盖 `session/event` 订阅与停止释放。
- `npm run validate`、`check:privacy`、`check:docs`、`check:version` 全部通过。
- 插件仓库提交 `4eb3bf0 feat(super-kanban): auto re-judge linked tasks after a turn`（10 files，+113/−11）。
- 真实桌面验证待重启：当前运行中的 0.4.32 仍是旧服务端代码；重启后关联任务在 `turn/end` 约 6 秒后应自动更新状态，设置页应出现「会话结束后自动研判」开关。
