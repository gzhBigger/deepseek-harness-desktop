# node-addon-require-builtin (DSH Desktop stand-in)

`prepare-runtime.mjs` deletes the upstream `node-addon-require-builtin` (and its platform
prebuild) from the runtime it stages, then copies this package under the same name.

Why: the upstream addon embeds a table of supported Electron builds and refuses everything else,
which tied the shell's Electron version to dsh. This package resolves the same `internal/*`
modules through `--expose-internals`, which the shell passes to the dsh child
(`electron/src/host-process.ts`).

Trade-off: the flag is process-wide, so in-process code (including plugins) can reach Node
internals. That is recorded in `.agents/notes/implemented/architecture/` together with the
decision, because it is the reason this package exists rather than just bumping the addon.
