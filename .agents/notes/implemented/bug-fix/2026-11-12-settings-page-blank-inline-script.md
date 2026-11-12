# Agent Note: 设置页整页空白：删除手机访问段留下非法脚本，0.4.1–0.4.23 全中

Status: implemented

## Problem

用户报告桌面壳的设置窗口打开后「内容都是空的」，但 `shell-settings.json` 里的配置本应还在。
检查确认配置没有丢：`C:\Users\gzh33\AppData\Roaming\ai.deepseek.dsh-desktop\shell-settings.json`
（449 B）包含 `service.port: 41729`、`closeBehavior: "exit"`、启用中的
`httpProxy`/`httpsProxy: "http://127.0.0.1:7890"`，且启动时已经生效。空白的是页面本身。

根因在 `electron/src/settings-ui/index.html` 的内联 `<script>`：它不是一个能解析的脚本。
提交 `f14ad52`（feat(pocket): 入口改到标题栏「手机访问」菜单，2026-10-16）把手机访问从设置页搬走时，
只删掉了表单字段和大部分逻辑，留下这些碎片：

- 一段没有函数包裹的 `try { if (pocket && pocket.error) … } catch …`，后面还多一个 `}`；
- 引用未定义的 `mode` / `domain` 的 `startPublicAccess()`；
- 两段没有外层事件监听器的 `const value = window.prompt(…)` / `if (value === null) return`，
  各自跟着落单的 `})`。

`node --check` 对这段脚本报 `SyntaxError: Unexpected token '}'`。浏览器在**执行前**就丢弃整段脚本，
所以 `api.get().then(fill)` 一次都没有跑：输入框、facts、status 全是初始 DOM。窗口本身照常加载，
`did-finish-load` 也照常触发——只等这个事件的窗口级冒烟因此看不到任何异常。

影响范围由 `git tag --contains f14ad52` 确认：`v0.4.1` 到 `v0.4.22` 全部受影响，当前 `0.4.23` 也在内。
已安装包的 `resources/app.asar` 头部记录的 `dist/settings/index.html`
SHA-256 为 `0209f232…8db9c`，与本地构建出的坏页面逐字节一致，确认用户装的就是这份。

这个缺陷能穿过 23 个版本，是因为 `settings-ui.test.ts` 只做静态字符串与 ID 检查，没有编译脚本；
而内联脚本不经过任何构建步骤，`did-finish-load` 又不代表脚本执行成功。

## Decision

1. **删掉残留片段，不重写页面。** 只保留仍有效的 `collect()`、`save()` 和启动块
   （`api.get().then(fill)`、保存/关闭/保存并重启三个监听）。修复后脚本从 5,579 字符降到 3,882 字符。
   手机访问的字段继续不回到这个页面，与 [手机访问独立窗口](../feature/2026-10-16-pocket-ui.md)
   和 [设置只留壳一处](../architecture/2026-10-12-shell-only-settings.md) 的决定一致。
2. **把「脚本能解析」变成测试。** `settings-ui.test.ts` 新增一条用例，用 `node:vm` 的 `Script`
   编译页面里提取出的内联脚本。语法错误在毫秒级失败，不依赖 Electron、窗口或任何页面加载事件。
3. **保留原有静态守卫。** 单一 `<style>`、脚本查的每个 ID 都存在、页面不自行 `fetch`、不得提交
   `pocketEnabled/pocketPort/pocketTunnel`——这些继续盯住布局与「一个设置只有一处入口」的契约。

## 为什么直到 0.4.23 才被发现

- 静态守卫能证明“ID 对得上”“没有 phone-access 字段”，证明不了脚本可以被 V8 解析。
- `did-finish-load` 只说明文档加载完成；脚本被语法错误整体丢弃时它仍然触发。
- 设置窗口是 Electron 窗口，仓库现有的截图/预览工具够不到它，日常开发很少真正打开设置页；
  这次是用 `preview-settings.mjs` 的 stub 页面才把“字段是否被填充”看见。
- 内联脚本没有构建期编译，等于把语法检查留给了运行时，而运行时失败是静默的。

## Alternatives considered

- **只在发版前手动打开一次设置页**（最强理由：零代码、零维护成本）——放弃，因为这次正是人工检查
  缺位；页面“能打开”与“字段已填充”肉眼很容易混淆，且 23 个版本都没人发现。
- **只删残留代码，不加回归测试**（最强理由：改动最小，缺陷已经修好）——放弃，因为同一类错误会随着
  下一次删段落重来；编译断言只有几行，运行成本可忽略。
- **用 Playwright/Electron 驱动打开设置窗口，断言输入框有值**（最强理由：这是真正的端到端行为，
  连 `fill()` 之外的渲染问题也能抓到）——本次不做：需要引入重依赖与窗口驱动，容易在 CI 上不稳定；
  而这次的失败是确定性的解析失败，编译断言已经精确覆盖，ID 存在性又有原守卫兜底。
- **把脚本抽成独立 `.js` 文件，让构建/类型检查编译它**（最强理由：从结构上消除内联脚本无法被
  工具链检查的问题）——本次不做：会牵动页面的 CSP 与 `loadFile` 资源路径，且其他壳页面同样是内联
  脚本，单改这一页会形成两套写法；若同类问题再出现，应一次性把所有壳页面的脚本外置。

## Testing

- 修复前 `node --check`：`SyntaxError: Unexpected token '}'`；修复后同一段脚本用 `node:vm` 编译通过。
- `cd electron && npm test`：669 项，661 pass，0 fail，8 skipped（含新增的编译用例）。
- `node build.mjs` 后 `dist/settings/index.html` 从 13,221 B / `0209f232…` 变为
  11,242 B / `08f41d49…`。
- `npm run preview:settings` 生成的 stub 页面在侧栏浏览器中打开：服务端口显示 `41729`，关闭行为选中
  「最小化到托盘」，当前状态区显示版本、端口、profile 与设置文件路径——`fill()` 确实执行了。

## Consequences

- 源码里的设置页恢复可用，配置无需迁移；`shell-settings.json` 全程未被修改。
- 已安装的 `0.4.23` 仍然是坏页面——它打包的是旧 `app.asar`，要等下一版发布并走自动更新才会修好。
- 新增的编译守卫只覆盖设置页；其他壳页面（launcher、market-ui 等）仍是内联脚本，本次没有一并外置。
  若再次出现同类整页空白，应优先考虑把所有内联脚本交给构建期编译。
- 测试数量从 668 增至 669，运行时间增加不到 1 ms。
