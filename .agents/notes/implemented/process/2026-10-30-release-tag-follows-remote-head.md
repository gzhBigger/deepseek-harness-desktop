# Agent Note: 发版前必须确认 HEAD 已推送（tag 跟着远端 HEAD 走）

Status: implemented

## Problem

`release-electron.mjs` 用 `gh release create v<version> …` 发布，并且**不给 `--target`**。`gh` 在没有 target 时会把 tag 打到**远端**默认分支的 HEAD 上，而不是本地 `HEAD`。

于是「本地提交已 commit、但没 push」这一常见状态会静默产出一个错版本：安装包是用本地代码打的（新的），tag 与 GitHub 自动生成的源码包却指向旧的远端提交。0.4.20 就是这样发出去的——本地领先 3 个提交（`c68e457`/`dd52cd3`/`c8ad851`），tag 却落在 `f4f94b4`（0.4.19 的 release commit）。发布后核对 `gh api …/git/ref/tags/v0.4.20` 才发现，靠 `git push origin main` + `git push --force origin refs/tags/v0.4.20` 修正。这类问题在下载页/自动更新上完全看不出来，只有去查 tag 指向才会暴露。

## Decision

在写 `latest.json` 之后、`if (dryRun)` 分支之前调用 `assertHeadIsPushed()`：

- 先 `git fetch origin`，再用 `rev-parse @{u}` 找到 upstream，`rev-list --count <upstream>..HEAD` 必须为 0；
- 大于 0 就用现有 `fail()` 报出「有 N 个未推送的提交，先 push 再发版」，**拒绝发布**；
- 检查放在 `--dry-run` 之前，所以试跑也能暴露这个问题，而不必等到真正上传；
- `git fetch` 失败、或仓库没有 upstream 时**只打印一行跳过**，不阻塞（离线试跑仍然可用，代价是退回到人工确认）。

## Alternatives considered

- **给 `gh release create` 加 `--target <本地 SHA>`**（最强理由：一行改动，直接让 tag 指到构建用的那个提交）。放弃原因：目标提交必须已存在于 GitHub，未推送时 `gh` 会报错——看起来也挡住了，但错的是"报错位置在最后一步"：构建、签名、APK、smoke、打包校验全跑完才失败，且失败信息是 GitHub 的 HTTP 错误，不是"你忘了 push"。前置检查更早、信息更准，两者也不冲突。
- **让脚本自己 `git push`**（最强理由：少一步人工）。放弃原因：发版脚本不该替用户推代码——它可能在错误的分支、可能带着未审的提交；推送是可审计动作，留给人和 CI。
- **只写进发版文档/清单**（最强理由：零代码）。放弃原因：这次正是"清单步骤都做了、只是忘了 push"；能机械检查的纪律不该靠记忆。

## Consequences

- **收益**：错 tag 这一类问题在发布前就变成硬失败，且失败信息直接说明该怎么办；`--dry-run` 同样受检。
- **代价**：真实发布多一次 `git fetch`（离线时打印跳过，不致命）。
- **验证**：`node --check` 通过；`--dry-run --skip-build --skip-smoke` 实跑显示 `==> 检查 HEAD 是否已推送` 且当前（已 push 的）HEAD 通过。失败分支没有在真实发布里触发过（那正是不该发生的情况），逻辑由 `rev-list --count` 的语义直接保证。
- **已知边界**：该检查只看 upstream 是否落后，不判断推送的是不是**同一个**远端分支（`main` vs 特性分支）；用 `@{u}` 而非硬编码 `origin/main` 是有意的——分支名跟着配置走比写死更稳。
