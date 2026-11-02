# Agent Note: 停用 GitHub CI（用户要求；失败原因已另行修掉）

Status: implemented

## Problem

2026-11-02 的 CI（run `41380944168`，提交 `532cd71`）失败，用户看到后要求"把 GitHub 的 CI/CD 关了，一直失败"。

真实原因不是基础设施：唯一失败项是当次新增的
`electron/src/market-service.test.ts` 里的 `安装过程把 pnpm 的进度翻译成人话推给窗口，并以 done 收尾`。
它把 `runtimeRoot` 指向仓库里的 `electron/runtime/dsh`——那个目录只有本地跑过
`pnpm runtime:prepare` 才存在；CI 没有准备运行时，`MarketService.#act` 在起进程前就返回
"随包运行时不可用"，断言 `result.ok === true` 失败。本地因为运行时在，一直是绿的。

## Decision

两件事分开做：

1. **修测试**（提交 `0eb015f`）：改为在临时目录自造最小运行时——建出
   `node_modules/pnpm/bin/pnpm.cjs` 与 `bin/node.exe` 两个空文件就够（这条测试注入的是假 runner，
   `#act` 只检查文件存在）。修复后 CI run `41381288455` 通过（1m 7s）。
2. **停用工作流**（用户要求）：`gh workflow disable 339072705`，现在 `gh workflow list --all`
   显示 `CI disabled_manually`。`.github/workflows/ci.yml` **保留在仓库里**，恢复只需
   `gh workflow enable 339072705`（或推送一次 `ci.yml` 的改动后手动启用）。

## Alternatives considered

- **只修测试、不动工作流**（最强理由：CI 修好后本来就绿，停用等于放弃唯一的自动门禁）。放弃原因
  是用户明确要求停用——这是他的仓库与配额，判断权在他；且交付路径（`pnpm release`）自带
  typecheck、660 条测试、打包校验、桌面/网关 smoke，日常改动不依赖 CI。
- **删掉 `ci.yml` 并提交**（最强理由：比 disabled 状态更明确，不会有人以为它在跑）。放弃原因：
  删除要等下一次推送才生效，而"停用"是立即生效的开关；文件留着，恢复成本是一行命令而不是重写工作流。

## Consequences

- **代价**：PR/推送不再有自动测试门禁；`windows-latest` 上的环境差异（正是这次暴露 "依赖本机状态"
  的那类问题）只能靠发版前的本地全量测试发现。
- **收益**：不再消耗 Actions 配额，也不会在推送后收到红色通知。
- **边界**：这是"暂停"而不是"废弃"。恢复时**不要**只 `enable` 就完事——`ci.yml` 的 pnpm/node 版本与
  测试入口要在启用前跑一遍本地等价命令（`pnpm typecheck`、`pnpm test`），确认工作流引用的路径仍然存在。
- **给未来的提醒**：测试里凡是读仓库内生成物（`runtime/`、`dist/`、`release/`）的地方，都要么自造
  最小输入，要么显式 skip——这次就是"本地有、CI 没有"的典型。
