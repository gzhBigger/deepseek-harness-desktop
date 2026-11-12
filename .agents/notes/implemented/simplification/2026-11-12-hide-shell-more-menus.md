# Agent Note: 桌面端隐藏侧栏「更多」与会话视图「…」

Status: implemented

## Problem

DSH 的侧栏面板列表在存在「未固定面板」时会自动渲染一个「更多」菜单；会话顶部的视图标签在存在溢出视图时会自动渲染一个「…」菜单。两者都由宿主按「有入口动作」自动挂载，没有配置开关。

桌面壳的面板集合是固定的，用户也不需要从这里进入其他面板；这两个入口只增加噪音，并让侧栏/标签栏看起来比实际能力更复杂。用户明确要求去掉它们。

## Decision

由桌面壳自己的 client 插件 `electron/resources/dsh-desktop-shell/client.js` 注入一段**只属于桌面壳**的样式，而不是修改 DSH 运行时：

```css
[class*="panelList"] > [class*="moreAnchor"] { display: none !important; }
[data-conversation-tabs] + [class*="viewsMoreAnchor"] { display: none !important; }
```

- 选择器用 CSS Modules 类名后缀（`panelList` / `moreAnchor`）和稳定的 `data-conversation-tabs` 属性做结构匹配，不依赖中文 aria-label。
- 侧栏只隐藏 `panelList` 的直接子项，不动设置页等其他位置的「更多」。
- 会话只隐藏紧跟在 `[data-conversation-tabs]` 后面的 `viewsMoreAnchor`，不碰右上角的 `headerMenuButton`（「更多操作」）。
- 样式在 `apply(ctx)` 时插入 `document.head`，元素已存在则复用；注入失败只告警，不影响 DSH 启动。
- 不写 profile、不改用户配置、不修改 `app.asar` 里的 DSH bundle。

## Alternatives considered

**直接改 DSH 上游 bundle**：最彻底，但会把桌面壳绑死在某个 DSH 版本的内部 DOM 上；每次升级运行时都要重新打补丁，且改的是 vendored 代码，难以审查和回滚。否决。

**给 DSH 上游加一个「隐藏更多菜单」配置**：语义最干净，但需要改上游宿主并等版本；当前需求是桌面壳自己的界面精简，不应该把桌面偏好塞进通用 Web UI。否决。

**删除整个侧栏面板列表或整个视图标签栏**：能达到「没有更多」，但会把正常入口一起删掉，超出用户要求。否决。

**用 JS 直接移除 DOM 节点**：能生效，但宿主重新渲染后节点会回来，还要处理 MutationObserver；CSS 方案对重渲染天然生效，成本更低。否决。

## Consequences

收益：桌面端侧栏和会话标签栏只保留实际可用的入口；不修改 DSH 安装包，升级运行时不会丢；样式只影响桌面壳，浏览器里的 DSH 不受影响。

代价：未固定面板和溢出视图在桌面端变得不可达。这符合当前桌面壳的固定面板集合，但如果以后需要从「更多」进入临时面板，必须改这段样式或恢复入口。选择器依赖上游 CSS Modules 后缀和 `data-conversation-tabs`，上游改结构时样式会静默失效；届时应以真实 DOM 探测为准更新选择器，而不是放宽到全局 `[class*="moreAnchor"]`。

## Verification

- `node --check electron/resources/dsh-desktop-shell/client.js` 通过。
- `npm test`（桌面壳）665 tests / 657 pass / 8 skipped / 0 fail。
- 用 dev 壳加载真实 DSH 页面（`DSH_DESKTOP_PROFILE=dsh-desktop`，CDP 9222）检查：
  - `#dsh-desktop-ui-trim` 存在；
  - 侧栏 `.hHd-Xa_moreAnchor` 的 computed `display` 为 `none`；
  - 打开会话后 `[data-conversation-tabs]` 的兄弟 `.wSkVaW_viewsMoreAnchor` 的 computed `display` 为 `none`，标签栏只剩「对话 / 轨迹 / 画廊 / 上下文」。
- 截图：`C:\Users\gzh33\AppData\Roaming\ai.deepseek.dsh-desktop\browser-screenshots\ui-trim-2026-11-12.png`。
