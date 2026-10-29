'use strict'

/**
 * Shell-owned stand-in for dsh's `node-addon-require-builtin` native addon.
 *
 * dsh calls `requireBuiltin('internal/modules/esm/loader')` (and four sibling internal modules)
 * while preparing its host — see `@deepseek-ai/dsh-app-boot`'s `internalModules()`. The upstream
 * addon reaches those modules by walking V8 internals, and refuses every Electron build that is
 * not in an embedded fingerprint table, which pinned this shell to one exact Electron release.
 *
 * Node already has a supported way to reach the same modules: `--expose-internals`. The shell
 * passes it to the dsh child process before the entry point (`electron/src/host-process.ts`),
 * so plain `require` is enough here and the Electron/V8 pair stops constraining the runtime.
 *
 * The flag is process-wide: anything loaded into the dsh process can also require `internal/*`.
 * That widening is deliberate and recorded in the note this file ships with — plugins already
 * run with filesystem and child-process access, so it changes reach, not privilege.
 */
const { createRequire } = require('node:module')

const localRequire = createRequire(__filename)

function requireBuiltin(id) {
  try {
    return localRequire(id)
  } catch (error) {
    if (typeof id === 'string' && id.startsWith('internal/')) {
      throw new Error(
        `node-addon-require-builtin (stub): cannot load ${id}. `
        + 'dsh must be started with --expose-internals before its entry point.',
        { cause: error },
      )
    }
    throw error
  }
}

exports.requireBuiltin = requireBuiltin

exports.isAllowedInternalId = (id) => typeof id === 'string' && id.startsWith('internal/')

exports.getBindingInfo = () => ({
  kind: 'stub',
  electron: process.versions.electron,
  v8: process.versions.v8,
})

/** Marker read by `prepare-runtime.mjs`; never relied on at runtime. */
exports.__dshDesktopStub = 'expose-internals'
