# Agent Note: 安装版 Office 预览失败——原生引擎没有完整解包

Status: implemented

## Problem

安装版 0.4.33 打开 `.docx` 时，右侧文件预览显示：

```
读取失败：Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。
```

但页面已经请求 `/api/officeKit/generation` 和 `/api/officeKit/render`，两者都返回 200；`/render` 的响应是：

```json
{"ok":false,"error":{"code":"document-render/failed","message":"Office conversion failed.","details":{"reason":"unavailable"}}}
```

所以 `remote.officeKit` 已经注册，问题不在客户端缺插件，也不在 LibreOffice 转换能力本身。仓库 runtime + 真实 profile 下同一个 docx 预览正常，只有安装版失败。

## Decision

把 `@deepseek-ai/libreoffice-kit-win32-x64` 整个包目录纳入 `PHYSICAL_TREES`，不再只解包 `bin/` 和 `sources/`。

原因：`dsh-office-kit` 的 `createEnginePackageResolver` 会把原生引擎的 `package.json` 从 ASAR 内的路径映射到 `app.asar.unpacked`，Kit 随后要读 `prebuilds.json`，并执行 `program/program`。原安装包的 `app.asar.unpacked` 里只有：

```
libreoffice-kit-win32-x64/
  bin/
  sources/
```

映射目标不存在，Kit 校验/启动失败，最终把错误降级成 `unavailable`。把 `package.json`、`prebuilds.json`、`program/`、`licenses/` 手工补进安装版后，`createConverter` 立即成功（`backend: native`、`pageCount: 1`），确认是解包不完整，而不是版本或路径配置。

同时在 `verify-package.mjs` 增加独立门禁：`libreoffice-kit-win32-x64/package.json`、`prebuilds.json`、`program/program` 必须在 `app.asar.unpacked` 中存在。这个检查不复用生成的 `physical` 列表，避免 `prepare-runtime.mjs` 再次漏掉整棵树时验证也一起失效。

## Alternatives considered

- **只补 `package.json`**：不够。补完后继续报缺 `prebuilds.json`，再补后报缺 `program/program`；这是完整引擎载荷，不是单个元数据文件。
- **让 resolver 直接读 ASAR 内的引擎**：不可行。`dsoffice.exe` 必须由操作系统执行，`program/` 下的资源也必须以物理路径存在；ASAR 内的路径不能 spawn。
- **保留 WASM 回退作为兜底**：之前为体积删除了 `libreoffice-kit-wasm`，而且 `resolveEngine` 在原生包存在时不会选 WASM；把 145 MiB 加回来只为绕过解包错误，代价和方向都不对。
- **在运行时首次使用时解包**：会把安装包变成自解压器，增加权限、失败恢复和完整性校验问题；安装包已经由 electron-builder 的 `asarUnpack` 负责这件事，修清单更直接。

## Verification

- `pnpm runtime:prepare`：运行时 33,120 文件 / 643.3 MiB；物理落盘 487 → 1,233；manifest 包含引擎全部文件。
- `cd electron && npm test`：665 tests / 657 pass / 8 skipped / 0 fail。
- `npm run package:dir`：asar 33,121 文件、物理 1,233，`verify-package.mjs` 通过；`release/win-unpacked/resources/app.asar.unpacked/.../libreoffice-kit-win32-x64` 内已有 `package.json`、`prebuilds.json`、`program/`、`licenses/`。
- 从打包后的 `app.asar` 用 resolver 调 `createConverter`：

```json
{"backend":"native","missingFonts":["Courier"],"pageCount":1}
```

- 安装版本地手工补齐同一组文件后，同一 docx 的转换也成功；重启安装版即可恢复预览。正式修复仍需重新打包/发版。

## Consequences

- 安装包体积和 `app.asar.unpacked` 文件数会增加（本次物理文件 487 → 1,233），但这是原生引擎可执行的必要条件；不增加额外的下载或运行时依赖。
- `verify-package.mjs` 现在会在打包阶段拦住“只解包 bin”的回归；如果未来更换引擎包布局，需要同步更新这三项路径。
- `prepare-runtime.mjs` 的 `PHYSICAL_TREES` 是整棵目录解包，未来加其他需要物理执行的原生包时可以复用同一机制。
- 该问题只影响安装版；仓库 runtime 直接跑时引擎目录是物理文件，所以本地开发与测试不会自然暴露这个缺口，必须依赖打包校验。
