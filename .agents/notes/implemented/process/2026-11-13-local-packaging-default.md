# Agent Note: 默认只本地打包，GitHub 上传改为显式 --publish

Status: implemented

## Problem

`electron/scripts/release-electron.mjs` 以前没有「只打包」模式：构建、签名、自校验、写 `latest.json` 之后一定会调用 `gh release create`。即使只是想在本机确认安装包，也要等 GitHub 建 Release、传四个资产，打包因此变慢；用户明确提出以后不要上传 GitHub，只做本地打包。

但桌面端的自动更新依赖 GitHub Release 里的 `latest.json`、安装包、签名和 APK。直接把上传代码删掉会让更新通道无法恢复，也会让「只是想发一版」时的操作路径变成重写脚本。

## Decision

`release-electron.mjs` 现在有两条明确路径：

- **默认（本地打包）**：构建 NSIS、签名、自校验、构建并检查 APK、写 `latest.json`，然后打印本地产物路径退出。不执行 `git fetch` / 未推送检查，不要求 `--notes` 或 `--yes`，也不调用 `gh`。
- **`--publish`（显式发布）**：保留原有上传路径。必须提供 `--notes`；正式版必须 `--yes`；上传前仍执行 `assertHeadIsPushed()`，失败就拒绝发布。`--dry-run` 只打印发布计划，仍会做 HEAD 检查，但不上传。

对应的 npm script：

- `pnpm release <version>`：本地打包。
- `pnpm release:publish <version> --notes "…" --yes`：显式发布到 GitHub。
- `pnpm release:dry`：发布演习，打印 `gh release create` 计划。

本地模式也会生成 `latest.json`，但它只是本地检查用的参考文件，里面仍指向 GitHub Release URL；不要把它当成线上清单。

## Alternatives considered

- **本地用现成的 `pnpm package:win`，不碰 release 脚本**（最强理由：零代码改动，命令也最短）。放弃原因：`package:win` 不跑 minisign 签名、不构建/检查 APK、不跑手机网关 smoke、不写 `latest.json`，本地产物和真正发布物不是同一套东西；用它验证等于没验证发布路径。
- **把 `gh release create` 和 `assertHeadIsPushed` 整段删掉**（最强理由：从代码上保证绝不上传，最符合「不要上传」的字面要求）。放弃原因：自动更新没有别的投递通道，删掉后将来要发版得重新实现上传、签名、资产校验和 tag 检查；保留一个显式开关，默认不触发，风险更低。
- **本地只上传 `latest.json`，不传安装包**（最强理由：清单很小，几乎不花时间）。放弃原因：清单里的 URL 指向不存在的安装包，客户端下载会失败，等于发布一个坏更新；四个资产必须一起存在。

## Consequences

- **收益**：日常打包不再产生网络上传，构建结束后立即拿到本地安装包；发布仍是显式、可审计的动作。
- **代价**：本地打包不会让任何已安装客户端收到更新。自动更新只在 `--publish` 后恢复；0.4.28 之后如果一直不加 `--publish`，线上最新版就停在 0.4.28。
- 本地可以重复打同一个版本号用于自测，但 GitHub tag 唯一；决定发布时仍要先升版本，避免把旧本地产物当新版本发出去。
- 本地 `latest.json` 的 URL 指向可能尚未创建的 Release；它只用于检查签名/字段，不要拿去替换线上清单。
- 发布路径的未推送 HEAD 检查保留；那篇旧笔记的约束仍适用于 `--publish`，不适用于默认本地模式。
- 该决定与 [发版前必须确认 HEAD 已推送](2026-10-30-release-tag-follows-remote-head.md) 相容：HEAD 检查现在只在上传路径执行。

## Verification

- `node --check electron/scripts/release-electron.mjs` 通过。
- `node scripts/release-electron.mjs 0.4.28 --skip-build --skip-smoke` 实跑：完成打包载荷校验、APK 检查、签名自校验和本地 `latest.json` 写入，打印「本地打包完成（未上传 GitHub）」后退出；没有出现「检查 HEAD 是否已推送」或 `gh release create`。
- `node scripts/release-electron.mjs 0.4.28 --publish --dry-run --notes "local dry-run verification" --skip-build --skip-smoke` 实跑：执行 HEAD 检查，打印完整的 `gh release create` 发布计划后退出；没有上传。
- 发布模式没有改变：安装包、`.sig`、`latest.json`、APK 仍作为同一个 Release 的四个资产上传；`--notes` 和 `--yes` 的安全门仍在。
