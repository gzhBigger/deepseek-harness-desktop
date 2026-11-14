# Agent Note: Super Kanban 手动研判与归档任务清理

Status: implemented

## Problem

自动研判只在 `turn/end` 触发，用户想立刻重判某个任务时没有入口，只能等下一轮会话或改状态。任务卡右键菜单里没有手动研判项。

任务列表把归档任务混在「含归档」里，没有单独的归档视图；归档任务长期堆积后无法批量清理。

## Decision

- 任务卡右键菜单新增「重新研判」：直接调用现有 `task.analyze`（不传 `auto`），toast 显示引擎、AI 调用数、token 数或返回消息，完成后 `reload(true)`。请求进行中禁用所有任务的该菜单项，避免并发。
- 列表页新增本地「只看归档」开关：开启时只渲染 `archived === true` 的任务，并自动打开全局「含归档」；再关闭即回到全部任务。
- 多选后仅当所选任务全部已归档时显示「删除归档」；两次点击确认，逐个调用既有 `task.delete` 移入回收站，完成后清空选择并 `reload(true)`。
- 不新增服务端删除命令。之前误加的 `project.delete` / 项目页归档删除已撤回；项目归档仍按原方式在「项目 → 已归档项目」查看和恢复。

## Alternatives considered

- **在项目页删除归档项目**：最初误读了需求；项目删除会解绑任务且不可恢复，与用户实际想清理归档任务不是一回事，因此撤回。
- **新增 `task.deleteArchived` 批量接口**：现有 `task.delete` 已具备单任务删除与回收站语义；串行调用足够，避免再扩一套服务端契约。
- **把「只看归档」做成全局持久化过滤**：该入口只服务列表页清理场景，局部状态不会影响看板/待处理/时间线，也不污染现有 filters 存储。
- **直接永久删除**：复用回收站语义，误删仍可恢复。

## Consequences

- 「只看归档」是列表页局部状态，切换页面后重置；全局「含归档」保持开启，避免归档任务被隐藏。
- 删除只移动任务到回收站，不删除来源会话、项目或工作区。
- 手动研判与列表删除都是客户端行为，刷新页面即可生效；撤回 `project.delete` 只影响服务端命令，运行中的服务端需重启后才不再暴露该命令。
- 自动研判的逻辑不变；手动研判不受 `autoAnalyzeOnTurnEnd` 开关影响。

## Verification

- `node --check client.js`、`node --check server/service.mjs` 通过。
- `npm test` 317/317；新增客户端用例覆盖「只看归档」入口、`removeSelected`、`task.delete` 与 `onEnsureArchived` 接线。
- `npm run validate`、`check:privacy`、`check:docs`、`check:version` 全过。
- 插件提交 `f4d6826`（手动研判；其中项目删除部分已在后续撤回）与 `cd0e9ce feat(super-kanban): filter and delete archived tasks from the list`（列表归档筛选/批量删除，并移除项目删除）。
