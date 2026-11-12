# Agent Note: 卸载被「新版本冷静期」误拦（0.4.25 市场）

Status: implemented

## Problem

用户在市场点「卸载 dsh-image-gen」，窗口报：

```
卸载失败：dsh-image-gen
这个版本刚发布，被 pnpm 的「新版本冷静期」拦住了 —— 等它满 24 小时（冷静期）再装；或在 profile 的 pnpm-workspace.yaml 设置 trustLockfile: true 跳过锁文件复检
```

错误文案要求「再装」，但用户点的是**卸载**。真正失败的命令是 `pnpm remove dsh-image-gen`，报错：

```
ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED
```

pnpm 11 对 `remove` 仍会执行 `minimumReleaseAge` 解析策略：只要锁文件里最近安装过的新版本还在 24 小时窗口内，整次 remove 就会被判成策略违规。`trustLockfile: true` 只跳过锁文件复检，不覆盖这一步。`classifyPnpmFailure` 又把日志里的 `minimumReleaseAge` 当成「安装目标太新」，于是提示用户等待或去装另一个版本，方向完全错误。

## Decision

1. **卸载显式关闭冷静期策略**：`pnpmArgs('uninstall', …)` 固定追加
   `--config.minimumReleaseAge=0`。移除包不安装任何东西，关掉策略不会放宽供应链保护；这是卸载路径唯一能绕过 `remove` 复检的开关。
2. **失败文案按 action 区分**：`classifyPnpmFailure(output, code, action = 'install')` 接收真实 action；`runMarketAction` 传入 `install`/`update`/`uninstall`。卸载遇到 too-new 时提示「移除包本身不需要冷静期」，不得再出现「再装」。
3. **测试钉住参数与文案**：`market-install.test.ts` 断言 uninstall 参数含 `--config.minimumReleaseAge=0` 且分类文案区分 action；`market-github-install.test.ts` 的旧参数断言同步更新。

## Alternatives considered

- **让用户设置 `trustLockfile: true`**：这是安装路径的既有出路，但实测对 `pnpm remove` 无效，仍报同一个 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`。放弃。
- **等 24 小时后再卸载**：能过，但用户只是想移除一个插件，等待期间还会反复失败；把「卸载」变成需要等待的操作不可接受。
- **用 `pnpm install --no-lockfile` 或手动删目录**：前者不改锁文件，profile 会留下半登记状态；后者绕过 pnpm，`dsh.profile.bundles` 与 node_modules 可能不一致。都放弃。
- **全局关闭 `minimumReleaseAge`**：一次解决所有 remove，但把安装路径的冷静期保护也关掉，违背引入 pnpm 11 默认值的初衷。放弃。

## Evidence

- 临时 profile 副本实测：`remove dsh-image-gen --reporter=append-only` 报 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`；追加 `--config.minimumReleaseAge=0` 后退出码 0，`Done in 4.1s`。
- 单测：`market-install.test.ts`、`market-github-install.test.ts` 全过；整仓 `665 tests / 657 pass / 8 skipped / 0 fail`，`npm run typecheck` 与 `npm run build` 通过。
- 相关既有决策：安装路径的锁文件复检见 [pnpm 锁文件校验把错归到别的包](2026-10-24-pnpm-lockfile-verification-blames-wrong-package.md)。

## Consequences

- **收益**：卸载不再被 24 小时冷静期拦住；失败时用户看到的是「移除不需要冷静期」，而不是去重装。
- **代价**：`pnpmArgs` 的卸载分支多一个与安装路径不同的参数；以后若 pnpm 改变 `remove` 的策略行为，这个 flag 需要重新评估。
- **边界**：只关闭卸载路径的 minimumReleaseAge；`add`/`update` 仍受 24 小时保护。`trustLockfile` 的语义不变，仍只用于安装路径的锁文件复检。
