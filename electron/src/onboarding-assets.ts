/**
 * 把 settings-account 客户端包里内联的引导插画搬出 JavaScript。
 *
 * 为什么要有这一步：`@deepseek-ai/dsh-client-ui-settings-account` 的 `lib/client.js` 把 8 张
 * onboarding 插画以 `data:image/webp;base64,…` 内联在模块顶层，整个文件 3.4 MB。DSH 的模块
 * 装载器在**页面启动批次**里就把每个模块的完整源码发给浏览器（`packages/client/modules`，
 * 注释写明 "Exact build artifact included in the startup batches"），所以手机哪怕从不打开
 * 设置页，也要先下载这 3.4 MB；经隧道时这就是好几秒。
 *
 * 我们改不了上游的打包配置，但可以在**自己的运行时准备阶段**改写随包分发的这份产物：
 * 每张 webp 落成真实文件（由 desktop-shell 的 web 路由以 immutable 缓存提供），bundle 里只留
 * 一个同源 URL。插画本身只在设置页的状态卡里出现，浏览器按 `img src` 惰性取用，且只取当前
 * 主题/语言的那一张。
 *
 * 产物形状（fileName 含内容哈希，因此可以永远缓存）：
 *   var onboarding_welcome_default = "/dsh-desktop-shell/v1/onboarding/welcome-1a2b3c4d.webp"
 *
 * 身份校验：只认**这 8 个已知变量名**的内联 webp。命中数量不等于 {@link ONBOARDING_IMAGE_COUNT}
 * 就抛错——上游换了图或换了打包方式时，宁可让构建失败，也不要静默地把 3 MB 又发回手机。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 与 `resources/dsh-desktop-shell/index.js` 的 `ROUTE` 保持同步；改一处必须改两处。 */
export const ONBOARDING_ROUTE = '/dsh-desktop-shell/v1/onboarding'

/** 上游目前内联 8 张 webp；数量对不上说明产物结构变了。 */
export const ONBOARDING_IMAGE_COUNT = 8

/** 被改写的 bundle 在运行时树里的位置（`electron/runtime/dsh` 下）。 */
const BUNDLE_RELATIVE_PATH = 'node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'

/**
 * `var onboarding_welcome_zh_dark_default = "data:image/webp;base64,…"`
 *
 * 只匹配 webp：同一文件里的 SVG（office/code 图标）只有 1 KB 上下，搬出去反而多几个请求。
 */
const IMAGE_PATTERN = /var (onboarding_[a-z0-9_]+)_default = "data:image\/webp;base64,([A-Za-z0-9+/=]+)"/gu

export interface OnboardingAsset {
  /** 变量名去掉 `onboarding_` / `_default` 后的标识，例如 `welcome-zh-dark`。 */
  readonly name: string
  /** 落盘文件名，含内容哈希，例如 `welcome-zh-dark-0f3a9c21.webp`。 */
  readonly fileName: string
  readonly bytes: Buffer
}

export interface SlimmedBundle {
  /** bundle 里是否真的有过内联插画；false 表示已经是瘦身过的（重复执行的幂等路径）。 */
  readonly patched: boolean
  readonly text: string
  readonly assets: readonly OnboardingAsset[]
  /** 被替换掉的 base64 总字节数（解出来的图片字节另见 assetBytes）。 */
  readonly removedBytes: number
  readonly assetBytes: number
}

export interface PatchResult extends Omit<SlimmedBundle, 'text' | 'assets'> {
  readonly bundlePath: string
  readonly bundleBytesBefore: number
  readonly bundleBytesAfter: number
  readonly assetCount: number
  readonly assetDirectory: string
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex').slice(0, 8)

/** 把 `onboarding_welcome_zh_dark` 变成 `welcome-zh-dark`。 */
const assetName = (symbol: string): string => symbol.replace(/^onboarding_/u, '').replace(/_/gu, '-')

/** 纯函数：抽出内联插画，把字符串换成 `ONBOARDING_ROUTE/fileName`。 */
export function slimSettingsAccountBundle(bundle: string): SlimmedBundle {
  const assets: OnboardingAsset[] = []
  let removedBytes = 0
  let assetBytes = 0

  const text = bundle.replace(IMAGE_PATTERN, (match: string, symbol: string, base64: string) => {
    const bytes = Buffer.from(base64, 'base64')
    const name = assetName(symbol)
    const fileName = `${name}-${digest(bytes)}.webp`
    assets.push({ name, fileName, bytes })
    removedBytes += match.length
    assetBytes += bytes.byteLength
    // 正则的捕获组不含 `_default` 后缀，这里必须原样补回：产品代码引用的就是完整变量名。
    return `var ${symbol}_default = "${ONBOARDING_ROUTE}/${fileName}"`
  })

  if (assets.length === 0) {
    return { patched: false, text: bundle, assets: [], removedBytes: 0, assetBytes: 0 }
  }
  if (assets.length !== ONBOARDING_IMAGE_COUNT) {
    throw new Error(
      `引导插画数量对不上：期望 ${String(ONBOARDING_IMAGE_COUNT)} 张，实际识别到 ${String(assets.length)} 张（${assets
        .map((asset) => asset.name)
        .join(', ')}）。上游产物结构变了，先核对再放行。`,
    )
  }

  return { patched: true, text, assets, removedBytes, assetBytes }
}

/**
 * 改写运行时树里的 bundle，并把插画写到桌面壳资源目录（该目录整体随安装包分发，
 * `electron-builder.config.mjs` 的 `extraResources` 已覆盖）。
 */
export function patchOnboardingAssets(options: { runtimeDir: string; shellDir: string }): PatchResult {
  const bundlePath = join(options.runtimeDir, BUNDLE_RELATIVE_PATH)
  if (!existsSync(bundlePath)) {
    throw new Error(`找不到 settings-account 的客户端包：${bundlePath}`)
  }

  const before = statSync(bundlePath).size
  const original = readFileSync(bundlePath, 'utf8')
  const slimmed = slimSettingsAccountBundle(original)
  const assetDirectory = join(options.shellDir, 'onboarding')

  if (!slimmed.patched) {
    return {
      patched: false,
      bundlePath,
      bundleBytesBefore: before,
      bundleBytesAfter: before,
      removedBytes: 0,
      assetBytes: 0,
      assetCount: 0,
      assetDirectory,
    }
  }

  mkdirSync(assetDirectory, { recursive: true })
  // 清掉上一轮的图（文件名带哈希，不清理会一直累积）。
  for (const name of readdirSync(assetDirectory)) {
    if (name.endsWith('.webp')) rmSync(join(assetDirectory, name), { force: true })
  }
  for (const asset of slimmed.assets) {
    writeFileSync(join(assetDirectory, asset.fileName), asset.bytes)
  }
  writeFileSync(bundlePath, slimmed.text, 'utf8')

  return {
    patched: true,
    bundlePath,
    bundleBytesBefore: before,
    bundleBytesAfter: statSync(bundlePath).size,
    removedBytes: slimmed.removedBytes,
    assetBytes: slimmed.assetBytes,
    assetCount: slimmed.assets.length,
    assetDirectory,
  }
}

/**
 * 校验一个（已被改写的）运行时树：bundle 里不再有内联 webp，且每张图都能在资源目录找到。
 *
 * 打包校验（`verify-package.mjs`）用它，避免「构建脚本没跑」这种静默回归。
 */
export function assertOnboardingAssets(options: { runtimeDir: string; shellDir: string }): void {
  const bundlePath = join(options.runtimeDir, BUNDLE_RELATIVE_PATH)
  if (!existsSync(bundlePath)) throw new Error(`找不到 settings-account 的客户端包：${bundlePath}`)
  const bundle = readFileSync(bundlePath, 'utf8')
  const inline = /data:image\/webp;base64,/gu.test(bundle)
  if (inline) throw new Error(`settings-account 的客户端包里仍有内联 webp：${bundlePath}（运行时瘦身没有执行？）`)

  const assetDirectory = join(options.shellDir, 'onboarding')
  const referenced = [...bundle.matchAll(new RegExp(`${ONBOARDING_ROUTE}/([a-z0-9-]+\\.webp)`, 'gu'))].map(
    (match) => match[1] ?? '',
  )
  if (referenced.length !== ONBOARDING_IMAGE_COUNT) {
    throw new Error(`bundle 里引用了 ${String(referenced.length)} 张引导插画，期望 ${String(ONBOARDING_IMAGE_COUNT)} 张`)
  }
  for (const fileName of referenced) {
    const path = join(assetDirectory, fileName)
    if (!existsSync(path)) throw new Error(`bundle 引用了不存在的插画：${path}`)
  }
}

/** `node src/onboarding-assets.ts --runtime <dir> --shell <dir> [--check]` */
function main(argv: readonly string[]): void {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const runtimeDir = value('--runtime')
  const shellDir = value('--shell')
  if (runtimeDir === undefined || shellDir === undefined) {
    process.stderr.write('用法：node src/onboarding-assets.ts --runtime <运行时树> --shell <桌面壳资源目录> [--check]\n')
    process.exit(2)
  }
  if (argv.includes('--check')) {
    assertOnboardingAssets({ runtimeDir, shellDir })
    process.stdout.write(`onboarding-assets: 校验通过（${join(shellDir, 'onboarding')}）\n`)
    return
  }
  const result = patchOnboardingAssets({ runtimeDir, shellDir })
  if (!result.patched) {
    process.stdout.write('onboarding-assets: 已经是瘦身过的产物，跳过\n')
    return
  }
  process.stdout.write(
    `onboarding-assets: ${String(result.assetCount)} 张 / ${(result.assetBytes / 1024 / 1024).toFixed(2)} MiB，` +
      `bundle ${(result.bundleBytesBefore / 1024 / 1024).toFixed(2)} → ${(result.bundleBytesAfter / 1024 / 1024).toFixed(2)} MiB\n`,
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
