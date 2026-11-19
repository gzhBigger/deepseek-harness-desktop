# Agent Note: 壳内 Skill 本地库与 skills.sh 市场

Status: implemented

## Problem

Skill 的管理原先分散在两处：DSH 的 profile 只认 `$DSH_HOME/skills` 和项目里的 `.dsh/skills`，而桌面壳的「MCP 与 Skills」窗口只能给外部目录建链接。用户想先在壳里维护一份 Skill 源文件，再按需发布到全局或某个项目；同时希望像插件市场一样浏览 skills.sh，而不是在浏览器里手工找安装命令。

插件 `dsh-mcp-skill-manager` 已经验证过全局/项目 Skill 链接和 skills.sh 公开搜索接口，但市场如果继续留在插件里，壳的窗口就仍然只是链接编辑器；用户明确要求市场属于壳，而不是某一个 profile 插件。

## Decision

壳的「MCP 与 Skills」窗口同时承担三件事：

1. **本地库**：Skill 源文件放在壳自己的配置目录 `bridgeDir()/skills`（开发态是 `ai.deepseek.dsh-desktop.dev\skills`，安装态是 `ai.deepseek.dsh-desktop\skills`）。本地库只复制目录，不执行其中的脚本；目录下必须有 `SKILL.md`，frontmatter 的 `name` / `description` 用于展示。未发布的副本可从本地库删除；仍有发布链接时删除会被拒绝，必须先取消发布。
2. **发布**：发布到全局时在 `$DSH_HOME/skills/<name>` 建 junction，发布到项目时在 `<project>/.dsh/skills/<name>` 建 junction，指向壳本地库。发布只登记 `<libraryRoot>/.publications.json`，取消发布只删登记过且 realpath 仍落在本地库里的链接；不复制、不删除源文件。
3. **市场**：第三个 tab「Skill 市场」访问 skills.sh。搜索走公开 `https://www.skills.sh/api/search?q=...&limit=...`，详情抓 `https://www.skills.sh/<owner>/<repo>/<skill>` 的服务端 HTML，解析描述、安装命令、仓库、安装量和 Stars；不在主进程里调用需要 Vercel OIDC 的 `/api/v1/*`。市场支持一键安装：安装时全局可选 `.dsh`/`.agents`，项目统一落在 `.agents/skills`（项目内不再区分 `.dsh`）。先从 GitHub 下载技能目录到临时目录，再复制进壳本地库并发布 junction；不执行第三方脚本。已安装列表按 `全部/全局/各项目` 筛选，全局再分 `.dsh`/`.agents`。

边界：

- IPC 新增 `mcpImportSkill` / `mcpPublishSkill` / `mcpUnpublishSkill` / `mcpRemoveSkillEntry` / `mcpSkillMarketSearch` / `mcpSkillMarketDetail` / `mcpSkillMarketInstall` / `mcpOpenExternal`；`openExternal` 只接受 skills.sh。已安装条目可直接删除：链接只删链接，真实目录需要强确认。市场详情使用原生 `<dialog>` 模态，而不是页面底部的展开块。
- 市场请求 15 秒超时、响应上限 2 MiB，id 必须是严格的 `owner/repo/skill`，拒绝空段、`.`、`..`。
- 导入、安装和发布都是用户显式动作；项目安装只能从 `workspaceRegistry` 的项目列表选择，不接受渲染进程传入任意项目路径。

## Alternatives considered

- **只留在 `dsh-mcp-skill-manager` 插件里**：已经实现且验证过，但市场会随 profile 插件启停而消失，源文件也不在壳的配置目录；用户明确要求做到壳里，壳的窗口才是稳定入口。放弃。
- **市场一键下载并安装（无确认）**：skills.sh 的安装命令背后是 GitHub 仓库和 `--skill` 选择，需要 clone/解压、校验 `SKILL.md`、处理 zip-slip 和脚本；无确认直接安装会把第三方正文带入上下文。因此做成显式「安装…」确认 + 作用域选择，先下载到本地库再发布，且永不执行脚本。
- **把市场安装实现成 `npx skills add` 子进程**：会受本机 Node/npx 环境、网络和交互提示影响，且无法在落盘前做文件数与符号链接检查。改为主进程用 GitHub API 下载并校验。
- **把 sitemap 的 2 万条全量索引进本地市场**：可以离线搜索，但启动和刷新成本高，且接口一变就整份失效；先用官方公开搜索，详情按需抓取。放弃全量索引。
- **让 DSH 直接读壳本地库**：需要改 DSH skill-filesystem 或把本地库塞进 profile；发布 junction 已经能复用 DSH 自己的项目/用户扫描，不需要改上游。放弃。

## Consequences

- 本地库是壳的私有数据，升级/重装壳不应清空；项目发布依赖 DSH 对 `.dsh/skills` / `.agents/skills` 的扫描，重启或刷新后生效。
- skills.sh 的公开搜索和详情 HTML 不是版本化契约，页面结构变化会让市场详情退化；已装 Skill 不受影响。
- 发布链接只建立 junction；删除本地库目录会让已发布链接失效，UI 的取消发布只负责删链接和登记。
- 全局发布/安装同时支持 `$DSH_HOME/skills`（`.dsh`）与 `~/.agents/skills`（`.agents`）；项目发布仍支持 `.dsh/skills` 与 `.agents/skills`，但市场一键安装到项目时只写 `.agents/skills`。旧 publication 没有 `root` 时按 `.dsh` 处理。
- 市场安装会先下载到本地库，再按选择发布；同一 Skill 安装到多个作用域时复用本地库副本，取消其中一个发布不影响另一个。删除本地库目录会让已有发布链接失效。
- 测试窗口里的 `msm-ui-test` 是临时验证数据，验证后已从 dev 库、全局 junction 和 publications 中清理。

## Version checks

本地库副本的来源记录在 `<libraryRoot>/.sources/<sha256(name) 前 16 位>.json`：仓库、Skill 相对路径、分支、安装时 commit、frontmatter 版本号。前端只读 `SKILL.md`，来源元数据与副本分离，删除本地副本时一起清理。

- **检查更新**：只对有来源记录的副本，逐个查询 GitHub 的 commits API（`path` + `branch`）；没有来源的旧副本明确显示「来源未记录」，不把未知当新版。
- **更新**：重新走同一条下载校验路径，先落到临时目录；只有新 commit 与记录不同才替换本地库。替换采用 staging → backup → rename，失败回滚；保留原来的发布 junction，所以全局/项目链接不需要重建。
- **为什么不自动更新**：更新会改变进入模型上下文的 Skill 正文，必须在用户点「更新」后发生；市场当前只按 commit 判断是否有新内容，不根据 `version` 字段做语义版本比较，因为没有强制的版本规范。
- **信任边界不变**：更新和安装都不执行脚本；下载仍受 500 文件 / 8 MiB 总大小 / 1 MiB 单文件限制，拒绝 symlink 与 `..`。

## Testing

- `electron/src/dsh-config.test.ts`：导入复制、重名拒绝、global/project junction、取消单个 publication 不影响另一个、非 publication 链接拒绝；作用域列表、`.agents` 根、旧 publication 缺少 `root` 的归一化；来源元数据在 `replaceLibrarySkill` 后更新、删除副本时清理。
- `electron/src/skill-market.test.ts`：详情 HTML 解析、非法 id、搜索坏行、短 query、注入 fetch 的详情读取；新增 mock GitHub 下载成功、符号链接拒绝、文件数/大小上限。
- `electron/src/mcp-ui.test.ts` / `mcp-window.test.ts`：三 tab、元素 id、bridge 方法、shell stub；新增 scope pills、本地库独立筛选、版本/更新按钮、发布/安装弹窗、`marketInstall`、`checkSkillUpdates`/`updateSkill`。
- 全量 `npm test`：76 个测试文件，677 pass / 8 skipped；`npm run typecheck`、`npm run build` 通过。
- 真实窗口：搜索 `react` 返回 58 条，详情在模态 dialog 中显示 `912.8K` / `34.5K` 和可复制的官方命令；Skills 页 scope pills 计数与分组正确，已安装卡片有删除入口；本地库导入、发布到全局 junction、取消发布均已手工验证。安装作用域为全局 `.dsh`/`.agents` + 项目 `.agents`。此前已用 `find-skills` 验证项目 `.dsh` 安装、取消发布和清理链路；项目 `.agents` 选项已在真实安装弹窗确认，但没有再实际落盘。
