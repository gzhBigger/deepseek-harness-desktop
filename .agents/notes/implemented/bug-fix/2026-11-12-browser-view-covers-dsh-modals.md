# Agent Note: 侧边栏浏览器盖住 DSH 弹窗

Status: implemented

## Problem

侧边栏浏览器是一个 native `WebContentsView`，Electron 把它画在所有 DOM 之上。DSH 的设置弹窗虽然通过 body portal 挂载、带全屏遮罩，并且 `z-index` 足够高，仍然只能露出浏览器旁边的一条——弹窗被原生视图从中间切断。

这不是 DSH 页面的 z-index 问题，DOM 无法盖住另一个原生 view。设置弹窗打开时，用户看不到或点不到被浏览器覆盖的那部分。

## Decision

1. **复用已有的冻结机制**，不新增第二套隐藏方式。客户端 `BrowserPanel` 检测到 DSH 弹窗出现时调用 `send({ name: 'freeze' })`；主进程 `BrowserViewManager.freeze()` 先 `capturePage()`，再 `beginFreeze(visibleState)` 并把原生视图 park 到 `BROWSER_HIDDEN_RECT`。客户端把截图渲染成 `.dsb-stage` 里的 `<img class="dsb-frozen">`，DSH 的 DOM 弹窗就能正常盖在这张静态图上。
2. **用引用计数管理冻结原因**。`freezeReasons` 是 `Set`，菜单用 `menu`，弹窗用 `modal`；只有第一个原因真正发 `freeze`，最后一个原因解除才发 `unfreeze`。原生 view 的显示/隐藏不能靠“谁最后调用谁赢”，否则关掉菜单会把弹窗期间的冻结一起解掉。
3. **异步操作串行化**。`freezeRun` 是一条 Promise 链：截图、park、恢复都按调用顺序执行；后到的 `unfreeze` 不会先于前一个 `freeze` 完成。快速开关弹窗时，避免截图完成又把已恢复的 view 冻回去。
4. **只匹配真正的模态框**：`document.querySelector('[role="dialog"][aria-modal="true"]')`。监听 `document.body` 的 `childList` / `subtree` / `attributes`，`attributeFilter` 只保留 `role` 和 `aria-modal`，用 `queueMicrotask` 合并连续的 mutation。
   - 最初把 `[data-shortcut-modal]` 也纳入选择器，dev 实机里出现约每 1.5 秒一轮的“打开/关闭”误触发；原因是有些非模态元素也带这个属性，或者属性在弹窗生命周期里反复变化。收窄到 `role` + `aria-modal` 后消失。设置弹窗仍然带 `data-shortcut-modal="settings"`，但不再依赖它。
5. **显示状态变化时清理原因**。面板 `visible !== true` 时清空 `freezeReasons` 和 `frozen`，因为宿主会 park 原生视图；否则下次显示时可能误以为还在冻结，或者把旧原因带到新页面。
6. **失活时解冻**。MutationObserver 的 cleanup 会断开 observer；如果清理时弹窗仍开着，主动 `unfreeze('modal')`，避免组件卸载后原生 view 永久停在屏幕外。

## Alternatives considered

- **把浏览器 view 的 z-index 降到 DSH 页面之下**：Electron 的原生 view 没有可参与 DOM 层叠的 z-index；`WebContentsView` 永远在 Web 内容之上。不可行。
- **用 `browser-overlay.ts` 的 native veil 盖住浏览器**：veil 也是原生 view，只能盖浏览器，不能让 DSH 的 DOM 弹窗盖上来；方向反了。
- **检测到弹窗时直接 `hide()` 浏览器**：`hide()` 会 park 原生 view，但也会丢弃冻结帧并改变“用户是否在看浏览器”的状态；弹窗关闭后需要重新判断是否显示，容易出现闪烁。冻结机制已经保留了静态帧和恢复语义，复用它更稳。
- **把 DSH 弹窗改成独立的 BrowserWindow**：这要改宿主 DSH 的弹窗渲染方式，超出桌面壳的范围，也会让所有插件弹窗都受影响。
- **在主进程里轮询页面 DOM**：主进程没有 DOM，必须通过 CDP 注入或 preload；为一个 z-order 问题引入常驻 CDP 会话，成本高于客户端 MutationObserver。

## Verification

- `node --check electron/resources/dsh-desktop-shell/client.js` 通过。
- `cd electron && npm test`：665 tests / 657 pass / 8 skipped / 0 fail。
- dev 壳实机（`DSH_DESKTOP_PROFILE=dsh-desktop`，CDP 9222）：
  - 右侧栏浏览器打开 `file:///D:/workspace/research/deepseek-harness-desktop/.tmp-modal-test.html`，点设置后 `shell.log` 出现 `[面板] DSH 弹窗打开：冻结侧栏浏览器`、`冻结视图（帧=13646B）`；
  - DOM 同时满足 `[role="dialog"][aria-modal="true"]` 和 `.dsb-frozen`；
  - 截图 `D:/workspace/research/deepseek-harness-desktop/.tmp-modal-shot-2.png`（1920×994）显示设置弹窗完整盖住浏览器区域；
  - 点设置里的「关闭」后 `.dsb-frozen` 消失，日志出现 `[面板] DSH 弹窗关闭：恢复侧栏浏览器`、`解冻视图：已恢复（rect=837×914，ok=true）`。

## Consequences

- 只要 DSH 打开真正的模态框，侧栏浏览器就变成一张静态图并 park 原生 view；弹窗关闭后恢复实时页面。弹窗期间不能滚动/点击浏览器，这是预期取舍。
- 冻结期间截图是最后一次绘制；如果页面有动画，弹窗打开瞬间会停住。对“不要让浏览器盖住弹窗”的目标来说，这是可接受的。
- 依赖 DSH 弹窗继续使用 `role="dialog"` + `aria-modal="true"`。宿主若改掉这两个语义，入口会失效；选择器集中在一处，改的时候只需同步这一行。
- 引用计数把菜单冻结和弹窗冻结解耦：菜单关闭不会解掉弹窗冻结，反之亦然。以后新增第三种冻结原因，只需再加一个 reason 字符串。
