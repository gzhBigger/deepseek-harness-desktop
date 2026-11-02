# Agent Note: 插件市场显示已装版本 + README 预览（含图片）

Status: implemented

## Problem

市场列表只回答「这里能装到哪个版本」：卡片上的 `item.version` / `entry.version` 来自目录，**已经装了什么版本**只在「已安装的插件」视图里能看到。用户在自己的 profile 里同时装了若干插件后，回到市场列表看到一堆版本号，无法判断哪个是他现在跑的。

第二个缺口是读 README：插件页在 GitHub 上，图片也在 GitHub 上，而市场窗口的 CSP 是 `default-src 'none'`——页面自己发不出任何请求，也不该把任意作者的 HTML 塞进 DOM（这条约束由 `market-ui.test.ts` 的静态检查守着）。所以「给插件加一个 README 预览」不是加一个 `<iframe>` 的事，它需要新的 IPC 面、新的网络出口和一套不碰 HTML 的渲染方式。

## Decision

**版本**：`MarketService.installed()` 读 `profile/node_modules/<name>/package.json` 的 `version` 字段，把结果随 `items` 一起交给窗口；列表卡片写成「已装 vX · 最新 vY」。不解析 `dependencies` 里的 spec——那里可能是 `^1.2.0`、`github:owner/repo` 或 `link:` 本地路径，只有落盘 manifest 说得出「我装的是哪个版本」。

**README**：新增 `market:readme` 通道，主进程侧由 `electron/src/market-readme.ts` 实现，返回**白名单节点树**而不是 HTML：

```ts
type ReadmeNode = { text: string } | { tag: string; children?: ReadmeNode[]; href?; src?; alt?; language?; className? }
```

窗口用 `createElement`/`createTextNode` 还原（`buildReadmeNodes`），因此市场页仍然**没有 innerHTML**，CSP 仍是 `default-src 'none'`，图片只认 `data:image/…`（CSP 的 `img-src 'self' data:` 已经允许）。

取数顺序与边界：

- **来源**：目录条目/依赖 spec 能解析出 GitHub 仓库就先读 `raw.githubusercontent.com/<owner>/<repo>/HEAD/{README.md,readme.md,README.markdown,Readme.md}`；否则退回 npm packument 的 `readme` 字段（`/registry.npmjs.org/<name>/<version>`，再退 `/…/<name>`）。
- **图片**：README 里的相对路径按仓库 raw 前缀解析；只接受 **https 公网主机**（`isPublicHttpUrl` 拒绝 localhost、`.local`/`.internal`、IPv4 私网/回环/链路本地/CGNAT、IPv6 回环与 `fe80::`/`fc00::/7`），取回后转 data URL。这道闸是为了不让任意 README 把主进程当成内网探测器（`169.254.169.254` 那类地址是真实存在的手法）。
- **上限**：README 512 KiB、单图 2 MiB、单次预览最多 12 张图/合计 8 MiB；超限或取不到 → 降级成 `[图片：alt]` 文字，**不报错**。
- **缓存**：`MarketService` 按 `name@version|url|spec` 记忆 10 分钟，列表与已安装视图各点一次不会重复打 GitHub/npm。
- **Markdown 子集**：标题、段落、列表（含缩进嵌套）、引用、代码块、表格、分割线、行内代码/强调/链接/图片。
- **内嵌 HTML**：README 里的 HTML 不是当纯文本，而是由 `htmlNodes()` 走同一套白名单节点树（解析器在 `market-readme.ts`，仍然没有任何 HTML 字符串进入页面）。规则：
  - 认识的标签才建节点（`p/div/h1-h6/ul/ol/li/blockquote/pre/code/strong/em/del/hr/br/a/img/table*/span/details/summary/figure/figcaption/kbd/sub/sup`，`b/i/s/strike` 归一到 `strong/em/del`）；
  - 不认识的标签**原样保留成文字**，所以 `<T>`、`<https://example.com>` 不会被吞；`script/style/iframe/object/svg/form/input/video…` 整段丢弃（连内容）；
  - 属性只收 `href`（http(s)/mailto/#，相对地址按 base 解析）、`src`（https、`data:image/{png,jpeg,gif,webp,avif}` 或按 base 解析成 https 的相对路径；不收 svg）、`alt`、`align`、`width/height/colspan/rowspan`（1–2000 的整数）、`open`；`on*`、`style`、`class`、`id` 一律不进节点树；
  - 块级容器（`details/div/blockquote/li/td/th/figure`）里的文本如果像 markdown（表格、列表、标题、围栏、引用），再走一层 `renderMarkdown`，所以 `<details>` 展开里的表格照常渲染；深度上限 2 层防递归。
  - 排版细节：`.readme-body img` 改为 `display: inline-block`（原 `block` 让 `<p align="center">` 里的徽章居中失效）；`details/summary/figure/figcaption/kbd` 有独立样式。

## Alternatives considered

- **引入 `marked` + `DOMPurify`**（最强理由：成熟、边界齐全、我们少写几百行解析）。放弃原因：两个包都要进 `dependencies` 并过供应链校验，bundle 变大，而 `DOMPurify` 的产物本身就是 HTML 字符串——它防的是 XSS，不是「页面不解析 HTML」这条更窄的约束；我们的节点树在结构上就不可能注入。
- **主进程返回 HTML 字符串，页面用 innerHTML 渲染**（最强理由：渲染端几行代码）。放弃原因：现有 `market-ui.test.ts` 明确禁止页面出现 `innerHTML`/`fetch`，而这正是市场页的安全姿态；放宽它等于把「消毒是否彻底」变成一次性人工判断，漏一处就是任意作者可在壳窗口里执行脚本。
- **让页面直接加载远程图片**（最强理由：零额外代码，`<img src>` 而已）。放弃原因：要把 CSP 的 `img-src` 放成 `https:`，README 里任意图床都能看到用户 IP、做跟踪像素，也破坏「页面不联网」的姿态；且相对路径图片仍然解析不了。
- **继续把 README 里的 HTML 当纯文本**（最强理由：实现零成本、结构上绝对安全，`<script>` 只是一串字符）。放弃原因：真实插件的 README 大量用 `<p align="center"><img>` 放徽章、用 `<details>` 折叠长内容，当文本显示时预览页出现一堆裸标签——用户直接反馈「页面中的一些 html 没法渲染」。安全可以用白名单解析保住，可读性不能。
- **只显示纯文本 README，不内联图片**（最强理由：完全不用碰网络与 CSP）。放弃原因：用户明确要图片预览，而 README 的价值一半在截图/示例图。

## Consequences

- **收益**：列表一行同时给出「已装」与「最新」；README 与图片在壳内直接可看，不用跳浏览器（手机/窄窗口上尤其省事）。实测三个真实插件：`dsh-genui` 23 KB README / 3 张图、`dsh-status-rotator` 66 KB（npm 来源）/ 5 张图均正常渲染。
- **代价**：打开预览会真的去 GitHub/npm 下载（有上限、有 10 分钟缓存）；npm 来源的 README 没有仓库基准，相对路径图片解析不了，只能降级成文字——这是来源本身的限制，不是可修的 bug。
- **约束**：`market-readme.ts` 是唯一允许抓 README 的地方，新增来源（如 GitLab）必须同时扩 `parseGithubRepo` 与 `isPublicHttpUrl` 的判断，不能绕过公网主机检查。
- **测试**：`market-readme.test.ts` 15 条（节点树形状、内嵌 HTML 的居中/徽章/details/figure/实体、`script` 整段丢弃、未知标签保留成文字、危险属性不进节点树、相对链接/图片解析、私网拒绝、GitHub/npm 两条来源、缺图降级）；`market-ui.test.ts` 继续守着「页面不 fetch、不 innerHTML、脚本引用的 id 都存在」。`tsc --noEmit` 干净，整仓 665 条（657 通过、8 跳过）。
- **未覆盖**：没有对真实 README 的排版做逐像素评审；`scripts/preview-market.mjs` 现在直接用真实 `renderMarkdown` 生成示例节点（`#readme` 自动打开对话框），截图覆盖居中徽章、`<details>` 里的表格、`<br>`/`<kbd>`、`figure`。仍未做「README 特别大/图片特别多」的真实站点压力测试（上限逻辑由单测覆盖）。
- **HTML 解析器的边界**：不是完整 HTML5 解析器，不纠正错配的闭合标签（多余的闭合直接忽略、未闭合的按嵌套处理），不处理 `<table>` 里的隐式 `<tbody>`，也不支持 `<picture>/<source>` 的响应式选图——`source` 被丢弃、内部的 `img` 保留。这些在 README 场景里够用，遇到更复杂的页面应当另立方案而不是继续加分支。
