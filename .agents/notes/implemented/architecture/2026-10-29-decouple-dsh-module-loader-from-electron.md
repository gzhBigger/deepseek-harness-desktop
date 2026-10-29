# Agent Note: 用 shell 自带的模块加载器替身，解除 Electron 与 dsh 的版本绑定

Status: implemented

## Problem

2026-10-21 的 Node.js 安全公告把 24.x 的修复版定在 24.22.1，用户看到「node 高危漏洞」的告警后要求确认随壳 node 的版本与风险。

随壳有两个 node，当时都是 24.18.1：

- **dsh 宿主**：`process.execPath` 是应用自己的 Electron，以 `ELECTRON_RUN_AS_NODE=1` 跑 dsh 入口；Electron 44.0.0 内置 Node 24.18.1。
- **`runtime/dsh/bin/node.exe`**：pnpm / package script / MCP stdio 用的真 node，`runtime-pin.json` 钉在 24.18.1。

升级第二条是常规操作；升级第一条必须换 Electron，而 Electron 被 dsh 的 `node-addon-require-builtin` 卡住：dsh 启动链（`@deepseek-ai/dsh-app-boot` 的 `internalModules()`）把 Node 内部模块（ESM/CJS loader 等）交给一个预编译 addon，addon 内嵌指纹表只接受 `43.0.0`、`44.0.0`、`44.7.0`、`45.0.0-alpha.6`。实测 Electron 44.10.0（Node 24.22.1，安全版）一启动就 `dsh: host preparation failed: node-addon-require-builtin unsupported: Unsupported/no-context`；44.7.0 虽被接受，但它的 Node 是 24.21.0，仍早于修复版。

把 addon 二进制里的 V8 串等长改成 `15.2.124.45-electron.0` 后仍被拒——匹配同时依赖 Electron 版本字段，补丁蒙混不过去。

## Decision

壳提供一个同名替身，并改走 Node 支持的 `--expose-internals`：

- `electron/runtime-overrides/node-addon-require-builtin/`：CommonJS 包，`requireBuiltin(id)` 就是 `createRequire(__filename)(id)`，保留 `isAllowedInternalId` / `getBindingInfo` 的形状；`package.json` 带 `dshRuntimeStub: true` 供构建期识别。
- `prepare-runtime.mjs`：从 staging 删掉 `node-addon-require-builtin`、它的平台预构建包与 `node-addon-native-custom-loader`，换入替身，并断言不再残留相关原生模块；替身的 `index.js` / `package.json` 计入 `critical` 哈希。V8 串只作为诊断信息写出，不再作为闸门。
- 壳启动 dsh 的三处都加 `--expose-internals`，且必须位于入口之前：`host-process.ts`（真实启动）、`dsh-runner.ts`（`--version` / `--help` / `web --help` 闸门探测）、`verify-package.mjs`（打包后 `--dump-config`）。
- `runtime-pin.json` 的 node 升到 24.22.2（10-27 的最新补丁）；`electron` 升到 44.10.0（Node 24.22.1）。
- `runtime-tree.ts` 的注释改为「替身 + manifest 里的 electron 版本仍需匹配」；构建期的白名单守卫整段删除。

## Alternatives considered

- **等上游发新版 addon**（最强理由：不 fork、走官方支持的路径，上游 `node-addon-require-builtin` 0.1.9 于 10-08 发布，dsh 的 rc.4 / alpha.2 仍依赖 `^0.1.9`）→ 弃：没有发布时间表，等待期间 dsh 宿主一直停在 Node 24.18.1，而这正是用户报告的高危面；壳与 dsh 的绑定也会继续阻碍后续 Electron 安全更新。
- **只升随包 node pin，不动 Electron** → 弃：只修 pnpm / package script 面；dsh 宿主（暴露给插件、网络、文件的那一侧）仍是 24.18.1，等于把最需要修的地方留下。
- **重建或补丁 addon**（最强理由：保留原生校验，不用进程级 flag）→ 弃：npm 只发预编译二进制，源码仓库默认分支/目录不可直接取（raw README 404），等长改 V8 串实测无效；重建后仍要对每个 Electron 重新编译与验证，维护成本高于替身。
- **让 dsh 宿主改跑随包真 node**（最强理由：一次性修掉两层 node，且不引入进程级 flag）→ 弃：运行时当前打进 ASAR，真 node 读不了 asar，要么把 dsh 树移出 asar、要么换加载方式，安装包体积/文件数/启动路径全变；dsh 还有 3 处按 `process.versions.electron` 分支，换 runtime 要逐处评估。留作后续可选项。

## Consequences

- **收益**：Electron 可独立升级，Node 安全更新不再被上游 addon 阻塞；两层 node 都到 24.22.x；闸门探测与打包校验仍覆盖 dsh 能否启动。
- **代价 / 风险**：`--expose-internals` 是进程级开关，dsh 进程内任何代码（含第三方插件）都能 `require('internal/*')`。插件本来就有 fs / child_process 权限，因此不是权限提升，但可达面变大；README 与笔记都写明这一点。
- **约束**：替身与 flag 必须成对存在。缺 flag → 启动期 `requireBuiltin` 抛带提示的错误；替身缺失或被换 → `prepare-runtime` 中止，`runtime-tree` 的 critical 哈希也会拦。上游若将来支持新 Electron，可以删替身与 flag，但必须同步改三处 spawn 与构建脚本。
- **未覆盖**：没有对官方 dsh 桌面客户端做行为对齐验证（它同样传 `--expose-internals`，见 2026-10-12 随包 node 笔记），本改动只保证本壳的启动、打包与冒烟路径；`dsh --version` / `web --help` 在 44.10.0 + 替身下的实测通过（`runtime:prepare` 的 3b 步骤）。
- **本地缓存副作用**：`electron/.runtime-build` 里原有的上游 addon 已被删掉。切回 `main` 重跑 `runtime:prepare` 时旧守卫会报「找不到 node-addon-require-builtin 的预构建二进制」，需要先 `node scripts/prepare-runtime.mjs --force` 重装 staging。`smoke.mjs` 在开发树里现在默认把 `DSH_DESKTOP_BUNDLED_RUNTIME` 指向 `runtime/dsh`，避免冒烟悄悄测到 PATH 上的全局 dsh。
- **验证记录**（本分支，2026-10-29）：`pnpm test` 640 例 / 632 通过 / 8 跳过；`node scripts/smoke.mjs cookie --isolate-home` → PASS；`pnpm package:dir` + `verify-package.mjs` 通过（asar 内 24,245 文件、critical 28、物理落盘 484、随包 node v24.22.2、pnpm 11.7.0）。壳版本随之升到 0.4.18。
