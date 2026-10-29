import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

import {
  ONBOARDING_IMAGE_COUNT,
  ONBOARDING_ROUTE,
  assertOnboardingAssets,
  patchOnboardingAssets,
  slimSettingsAccountBundle,
} from './onboarding-assets.ts'

/** 上游产物里的 8 个内联插画变量名（顺序与缩小后的观感无关，只求齐全）。 */
const SYMBOLS = [
  'onboarding_welcome',
  'onboarding_welcome_dark',
  'onboarding_welcome_zh',
  'onboarding_welcome_zh_dark',
  'onboarding_recharge',
  'onboarding_recharge_dark',
  'onboarding_recharge_zh',
  'onboarding_recharge_zh_dark',
]

const temporary: string[] = []
after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true })
})

const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-onboarding-'))
  temporary.push(directory)
  return directory
}

const base64 = (name: string): string => Buffer.from(`art-of-${name}`).toString('base64')

/** 造一份和上游同构的 bundle：8 张 webp + 必须原样保留的 SVG / 加载动画。 */
function bundleText(symbols: readonly string[] = SYMBOLS): string {
  const lines = symbols.map((symbol) => `\t\tvar ${symbol}_default = "data:image/webp;base64,${base64(symbol)}"`)
  return [
    '//#region src/client/assets/onboarding-office.svg',
    '\t\tvar onboarding_office_default = "data:image/svg+xml;base64,PHN2Zy8+"',
    ...lines,
    '//#region src/client/assets/spinner',
    '\t\tvar spinner = "_x:before{content:\\"\\";background:url(data:image/svg+xml;base64,PHN2Zy8+)"}',
    '\t\tvar src = locale === "zh" ? onboarding_welcome_zh_default : onboarding_welcome_default',
    '',
  ].join('\n')
}

const BUNDLE_RELATIVE =
  'node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'

/** 在临时目录里铺一个「运行时树 + 桌面壳资源目录」。 */
function stage(symbols?: readonly string[]): { runtimeDir: string; shellDir: string; bundlePath: string } {
  const runtimeDir = scratch()
  const shellDir = scratch()
  const bundlePath = join(runtimeDir, BUNDLE_RELATIVE)
  mkdirSync(dirname(bundlePath), { recursive: true })
  writeFileSync(bundlePath, bundleText(symbols), 'utf8')
  return { runtimeDir, shellDir, bundlePath }
}

test('每张内联 webp 都变成一个带内容哈希的同源 URL，SVG 与加载动画保持不动', () => {
  const slimmed = slimSettingsAccountBundle(bundleText())

  assert.equal(slimmed.patched, true)
  assert.equal(slimmed.assets.length, ONBOARDING_IMAGE_COUNT)
  assert.equal(slimmed.text.includes('data:image/webp'), false)
  assert.equal(slimmed.text.includes('data:image/svg+xml'), true, 'SVG 图标不搬，否则多出无谓请求')
  assert.equal(slimmed.removedBytes > slimmed.assetBytes, true, 'base64 比原图更大')

  for (const asset of slimmed.assets) {
    assert.match(asset.fileName, /^[a-z0-9-]+-[0-9a-f]{8}\.webp$/u)
    assert.equal(
      slimmed.text.includes(`= "${ONBOARDING_ROUTE}/${asset.fileName}"`),
      true,
      `${asset.name} 的引用没写进 bundle`,
    )
  }
  // 变量名本身不能变：产品代码按名字引用。
  assert.equal(slimmed.text.includes('var onboarding_welcome_zh_dark_default = "'), true)
})

test('同一张图两次得到同名文件，不同内容的图不会撞名', () => {
  const first = slimSettingsAccountBundle(bundleText())
  const second = slimSettingsAccountBundle(bundleText())
  const names = (bundle: typeof first): string[] => bundle.assets.map((asset) => asset.fileName)

  assert.deepEqual(names(first), names(second))
  const unique = new Set(names(first))
  assert.equal(unique.size, first.assets.length, '8 张图必须各有各的文件名')
})

test('数量对不上时宁可失败，也不静默把 3 MB 发回手机', () => {
  assert.throws(
    () => slimSettingsAccountBundle(bundleText(SYMBOLS.slice(0, 7))),
    /引导插画数量对不上：期望 8 张，实际识别到 7 张/u,
  )
})

test('已经瘦身过的产物是幂等的：再次执行报 patched=false，bundle 不变', () => {
  const once = slimSettingsAccountBundle(bundleText())
  const twice = slimSettingsAccountBundle(once.text)

  assert.equal(twice.patched, false)
  assert.equal(twice.text, once.text)
  assert.equal(twice.assets.length, 0)
})

test('落盘：改写 bundle、写出图片、再执行一次不重复写、校验能通过', () => {
  const { runtimeDir, shellDir, bundlePath } = stage()
  const before = statSync(bundlePath).size

  const result = patchOnboardingAssets({ runtimeDir, shellDir })

  assert.equal(result.patched, true)
  assert.equal(result.assetCount, ONBOARDING_IMAGE_COUNT)
  assert.equal(result.bundleBytesAfter < before, true)
  assert.equal(readdirSync(result.assetDirectory).length, ONBOARDING_IMAGE_COUNT)
  assert.equal(readFileSync(bundlePath, 'utf8').includes('data:image/webp'), false)

  const again = patchOnboardingAssets({ runtimeDir, shellDir })
  assert.equal(again.patched, false)
  assert.equal(again.bundleBytesAfter, result.bundleBytesAfter)

  assertOnboardingAssets({ runtimeDir, shellDir })
})

test('校验会抓出「图片没落盘」和「bundle 没瘦身」两种回归', () => {
  const { runtimeDir, shellDir, bundlePath } = stage()
  assert.throws(() => assertOnboardingAssets({ runtimeDir, shellDir }), /仍有内联 webp/u)

  const result = patchOnboardingAssets({ runtimeDir, shellDir })
  const files = readdirSync(result.assetDirectory)
  assert.equal(files.length, ONBOARDING_IMAGE_COUNT)
  rmSync(join(result.assetDirectory, files[0] ?? ''), { force: true })
  assert.throws(() => assertOnboardingAssets({ runtimeDir, shellDir }), /引用了不存在的插画/u)

  writeFileSync(bundlePath, bundleText(), 'utf8')
  assert.throws(() => assertOnboardingAssets({ runtimeDir, shellDir }), /仍有内联 webp/u)
})
