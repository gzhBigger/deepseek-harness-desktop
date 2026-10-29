# Agent Note: 手机首屏瘦身——把引导插画搬出 settings-account bundle

Status: implemented

## Problem

2026-10-29 用户反馈「手机访问页面加载很慢」。查下来首屏的大头不是业务逻辑，而是一张 **从不打开的设置页**：

- DSH 的模块装载器把每个客户端模块的**完整源码**放进启动批次（`packages/client/modules`：
  "Exact build artifact included in the startup batches"）。实测随包 `dsh` 的启动批次有 75 个模块、
  11.12 MiB（gzip 后 4.20 MiB），其中 `@deepseek-ai/dsh-client-ui-settings-account/lib/client.js`
  一个文件就占 3.26 MiB。
- 该文件里 3.19 MiB 是 8 张 onboarding 插画的 `data:image/webp;base64,…`。上游用 tsdown 的
  dataurl 插件把它们内联进产物；插画只在「设置 → 状态卡」里通过 `<img src>` 出现，且只显示当前
  主题/语言的一张。
- 网关已经 gzip、现在也支持 br，但 base64 文本压完仍剩 ~0.73，手机经隧道打开页面要为此多花几秒
  （隧道本身 TLS + RTT 约 1.4–1.8 s）。

上游产物我们改不了（用户原话：「上游我们没法控制」），但**随包分发的那一份**是我们自己的构建产物。

## Decision

构建期把那 8 张图搬出 bundle，bundle 里只留同源 URL：

1. **`electron/src/onboarding-assets.ts`** —— 纯函数 + 落盘 + 校验三件事：
   - `slimSettingsAccountBundle()` 只匹配**这 8 个已知变量名**的内联 webp（SVG 图标与加载动画不动，
     它们各 ~1 KB，搬出去反而多请求），换成 `/dsh-desktop-shell/v1/onboarding/<name>-<sha8>.webp`；
     命中数 ≠ 8 直接抛错。实测 3.26 MiB → 0.21 MiB，抽出 2.29 MiB 真图。
   - `patchOnboardingAssets()` 把 webp 写到 `resources/dsh-desktop-shell/onboarding/`（该目录整体走
     `extraResources` 随安装包分发），并改写运行时树里的 bundle。
   - `assertOnboardingAssets()` 反向断言，供打包校验使用。
2. **`prepare-runtime.mjs`** 在**清单枚举之前**调用它——bundle 被改写后大小变了，清单必须记录新的那份；
   没找到内联 webp 就 `fail`（上游结构变了要人看，不能让 3 MB 静默回流）。
3. **`verify-package.mjs`** 钉住成品：`app.asar` 里的 bundle 不再含内联 webp、引用的 8 张图必须真的在
   `resources/dsh-desktop-shell/onboarding/` 下。
4. **桌面壳 web 路由**（`resources/dsh-desktop-shell/index.js`）新增
   `/dsh-desktop-shell/v1/onboarding/*.webp`：只 GET/HEAD、文件名白名单、`public, max-age=31536000, immutable`
   + ETag/304，**匿名可读**。理由：这些是页面里 `<img src>` 直接取的静态素材，若走现有的
   「sameOrigin + Cookie 回探 `GET /`」认证，一张图一次回探会把首屏请求数翻倍；认证的价值在写操作，
   静态图本来就会随页面发出去。
5. **网关压缩补 br**（`electron/src/pocket-gateway.ts`）：`chooseEncoding()` 在 `accept-encoding` 同时
   支持 br/gzip 时选 br，`BROTLI_QUALITY = 5`（≈gzip-9 的压缩率、约 1/4 的 CPU）。首屏字节越少，
   隧道上每个来回省下的绝对时间越多。

## Alternatives considered

- **等上游把插画改成独立资源**（最强理由：根治、零产物改写、不用维护变量名表）→ 弃：上游不在我们
  控制内，当前 pin 不会因我们的诉求发版；随包改写只动一份已知文件，有 `verify-package` 兜底。
- **在网关里改写 JS、把图片变成按需请求**（强理由：不碰 asar）→ 弃：bundle 由 DSH 自己的模块装载器以
  固定 URL 提供，网关要改写就得解析模块图；而且 PC 直连 `41729` 时同样慢，改不到。
- **重新压缩/缩放这 8 张图**（强理由：进一步减小总量）→ 弃：这是产品视觉素材，改图会让设置页与原设计
  偏离，单张最小也有 180 KB；先拿掉「不打开设置页也要下载」这个结构性问题。
- **用 Cloudflare Cache Rule 缓存 bundle 本身**（强理由：命中一次省掉全部字节）→ 弃：bundle 由壳按内容
  哈希生成且需要登录 cookie，缓存规则只能命中匿名静态资源；首次访问仍要下 3 MB。CF 缓存只对壳自己的
  静态资源（css/json/字体）开短 TTL，属于另一个决定。

## Consequences

- 启动批次少约 3.05 MiB（gzip 后约 2.4 MiB），手机首次打开不再为一张从不显示的插画付字节；隧道 TLS/RTT
  仍是主要固定成本。
- **约束**：`ONBOARDING_ROUTE` 在 `electron/src/onboarding-assets.ts` 与
  `resources/dsh-desktop-shell/index.js` 两处手写重复，改一处必须改两处；变量名表（8 个）跟着上游产物走，
  上游增删插画时 `prepare-runtime` 会以「数量对不上」失败，而不是静默漏搬。
- **测试**：`electron/src/onboarding-assets.test.ts` 6 条（纯函数替换、哈希稳定、数量守卫、幂等、
  落盘 + 校验、校验抓出两种回归）；`tsc --noEmit` 与整仓 640 条测试通过。
- **未覆盖**：没有手机侧真机计时（无手机端工具），只验证了载荷与路由；线上收益需用户在手机上看复访/首访
  差异。CF Cache Rule 需要用户在 Cloudflare 控制台手加（交付说明里给了规则）。
