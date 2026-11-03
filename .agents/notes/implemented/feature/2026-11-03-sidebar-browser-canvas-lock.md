# Agent Note: 侧边栏浏览器锁定 1920×1080 画布

Status: implemented

## Problem

侧边栏浏览器（DSH 面板里的原生 `WebContentsView`）一直按侧栏的高宽铺满：面板量出 stage 矩形，主进程原样 `setBounds`。调试网页时这有两个问题：

- **页面拿到的是侧栏宽度**（常见 400–900px），而不是设计稿/线上桌面端的宽度。响应式断点、`grid` 列宽、`100vw` 布局全都按侧栏算，和真实桌面浏览器不一致；
- 侧栏一拖宽，页面就重新布局，量出来的「这个元素在哪、多宽」随窗口变，测试结论不可复现。

用户的原话是「有些时候我想让他保持 1920×1080 的比例，这样在调试页面的时候可以更准确……最好有一个按钮激活就是按照比例来显示，取消就是按照侧栏的高宽显示，默认是激活的」。

## Decision

1. **画布锁是偏好项，默认开启**：`BrowserPrefs.canvasLock` 写进 `browser-prefs.json`，与 `homepage` / `bookmarks` / `bookmarkBarVisible` 同一份文件、同一套 `mergeBrowserPrefs` 白名单校验。缺失字段按 `true` 解析——升级前写下的老文件不能因为少一个字段就把功能关掉。
2. **几何是纯函数**（`electron/src/browser-geometry.ts`）：
   - `canvasSurfaceRect(rect)`：在 stage 内取**最大的 16:9 矩形**，居中；上限 1920×1080，即比 1920 宽时不再放大，只留黑边。不可用矩形（`BROWSER_HIDDEN_RECT` 等）原样返回，保证「把视图停到屏幕外」的路径不被 letterbox 改写；
   - `canvasScale(width)`：`min(1, width / 1920)`，非法宽度返回 1。
3. **摆放走 `surfaceRect`**：`applyBounds` 先算 letterbox 再 `view.setBounds`，遮罩层（`syncVeil`）用同一个矩形——两者从此不可能错位。
4. **视口用 CDP 而不是 zoom**：`applyEmulation` 里画布分支调用
   `Emulation.setDeviceMetricsOverride { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, scale: 侧栏可用宽度 / 1920 }`，
   并把触摸模拟关掉、UA 恢复成桌面默认值。页面按 1920×1080 布局，Chromium 把整幅结果缩进那块矩形。
5. **缩放合并到一次 CDP 调用**：拖侧栏时每一帧都会 `applyBounds`，但只有宽度真的变了才需要重设 `scale`，所以 `scheduleCanvasScale` 用 40ms 定时器合并成一次；`appliedCanvasScale` 记住当前值，避免无谓往返。定时器在 `destroy()` 里清掉，且回调先查 `created`，防止关掉标签页后又凭空建一个视图。
6. **设备模拟优先于画布锁**：`canvasActive()` 只在 `device === 'desktop'` 且没有自定义宽高时为真。用户选了 iPhone 就是想要 390×844 的视口，再套一个 1920 画布等于第二个谎言；切回「桌面」预设（设备行里的「跟随窗口」按钮就是这条路径）画布锁自动恢复。切换设备/偏好后用 `repositionSurface()` 重新摆放，否则手机预设会继续待在画布那块 letterbox 里，直到用户拖动侧栏。
7. **面板按钮跟在设备按钮右侧**：`▭`，`data-on` 表示**当前真正生效**（开着锁但选了手机预设时不亮），title 分三种情况说明「开启 / 已锁定，点击改为铺满 / 设备模拟优先」。点击复用已有的 `setPrefs` 命令，不新增桥命令。

## Alternatives considered

- **`webContents.setZoomFactor(宽度 / 1920)`**：探针里内宽也是 1920，但 `devicePixelRatio` 变成 0.333——截图像素尺寸、`matchMedia('(resolution)')` 和 agent 的坐标换算全都跟着改，等于为了布局牺牲了「这张图就是桌面端的样子」。而且 Electron 会把 zoomFactor 按 origin 持久化到磁盘，重启/换页面后残留，必须在每次导航后重置。放弃。
- **只设 device metrics、不传 `scale`**：页面确实是 1920 宽，但画在 640 宽的视图里等于放大裁切，只能看到左上角（探针里 `innerWidth` 直接变成 5760×3240 的另一种错法）。不可用。
- **面板用 CSS 画一个 16:9 容器**：面板画不出原生视图——页面是主进程的 `WebContentsView`，CSS 只能改 stage 背景，改不了页面视口。必须有主进程参与，所以落点是几何模块 + 管理器。
- **画布锁做成硬编码、不进偏好文件**：用户明确要「取消就是按侧栏显示」，重启后还应该记得他的选择；而且「默认激活」只有持久化语义才说得清。放进 `browser-prefs.json` 的成本只是一个白名单条目。
- **给画布加额外 CDP 调用（`setWindowBounds`、`setScreenSize`）**：`screen.width` 这类值对响应式布局没有影响，只影响少数 `screen.*` 脚本；先不加，避免多一条会失败的 CDP 调用。

## Evidence

- 探针（`%TEMP%\dsh-canvas-probe`，Electron 44 + `WebContentsView`）：
  - `main2.cjs`：640×360 视图 + `setDeviceMetricsOverride{1920,1080,scale:0.3333}` → `innerWidth/innerHeight = 1920/1080`、`dpr = 1`，截图输出 1920×1080；在 DIP (600,345) 发点击，页面收到 `clientX/Y = 1800/1035`，命中右下角标记 → 输入坐标按 3× 放大，映射正确；
  - 视图 resize 到 800×450 后按 `scale = 800/1920` 重设，内宽仍是 1920×1080；
  - `main3.cjs`：`Emulation.clearDeviceMetricsOverride` 之后内宽回到当前视图尺寸（640×360 → 800×450），关掉画布锁能干净回到铺满。
  - 对照：`setZoomFactor(1/3)` 截图与 scale 版肉眼一致，但 `dpr = 0.3333`；不传 scale 会裁切。
- `electron/src/browser-geometry.test.ts`：新增 3 组断言——宽 stage（900×300 → 533×299 居中）、窄 stage（640×900 → 640×360）、超上限（2560×1440 → 1920×1080 居中）、停车矩形原样、`canvasScale` 的 1/比例/0/NaN 边界。
- `electron/src/browser-prefs.test.ts`：`canvasLock` 缺省为 true、显式 false、非布尔被拒绝、patch 只改 `canvasLock` 并进 `changed`、不影响其它字段。
- 端到端探针（`%TEMP%\dsh-canvas-integration`）：用 esbuild 把 `src/browser-view.ts` 打成 ESM，在 Electron 44 里直接驱动真的 `BrowserViewManager`（stage 900×300 @ (40,60)，窗口 1200×800）：
  - 锁定：原生视图 `{x:223,y:60,width:533,height:299}`（900×300 里居中的 16:9），页面 `innerWidth/innerHeight = 1920/1080`、`dpr = 1`，`capturePage` 输出 1920×1080；
  - `setPrefs({canvasLock:false})`：视图回到 `{x:40,y:60,width:900,height:300}`，`innerWidth = 900`；
  - 再打开：又回到 533×299 / 1920×1080；
  - 设备优先：`device:'iphone'` 时视图回铺满 900×300，视口是手机模拟（`innerWidth 980`、`dpr 3`）；`device:'desktop'` 后重新变成 533×299 / 1920×1080。
- 全量：`node scripts/run-tests.mjs` → 668 tests / 660 pass / 8 skipped / 0 fail；`npx tsc --noEmit` 通过；`node build.mjs` 通过。

## Consequences

- 打开侧栏浏览器默认就是 1920×1080 的布局，按侧栏宽度等比缩放；点 `▭` 或选任一设备预设即退出画布，页面回到「真实视口 = 视图尺寸」。
- 页面里的 `window.innerWidth`、媒体查询、`100vw` 现在恒为 1920（设备预设除外），和窗口大小无关；agent 的截图是 1920×1080 原生像素（`capturePage` 返回布局尺寸）。
- letterbox 的留白由面板背景承担，原生视图是居中的那块；想再加边框/角标的话应该在面板里读同一套几何（`canvasSurfaceRect` 是纯函数，可以直接搬进客户端），目前没加。
- 画布锁与设备模拟的优先级是「设备优先」，以后若加平板等预设，这条规则同样适用：预设一旦不是 `desktop`，画布自动让位。
- 偏好写到 `browser-prefs.json`，多侧栏标签共享同一份文件：在一个标签里切换，其它已打开的标签要等下一次 `prefs` 读取（切页/重开）才跟上——与 `bookmarkBarVisible` 现在的行为一致。
