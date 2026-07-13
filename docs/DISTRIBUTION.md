# Distribution

veritaserum ships two ways: an **npm package** (the CLI, for goose/codex/any harness) and
a **Claude Code plugin** (this same repo, installed directly — hooks, one manifest). Both
come from this one repo; nothing is built or synced by hand. There is no MCP server: the
audit is pushed at turn-end, not pulled by the executor (SPEC §4.1).

## How releases work (tag → npm)

Source of truth: `package.json`'s `version`. The pipeline is two hops
(`.github/workflows/release.yml`):

1. **`tag` job** (on push to `main`, when `src/`, `adapters/`, `.claude-plugin/`,
   `package.json`, or the lockfile changed): runs the full gate (typecheck, build, test,
   `check:plugin`); if `package.json`'s version has no matching `v<version>` git tag yet,
   creates and pushes that tag. It never publishes to npm.
2. **`publish` job** (on push of a `v*` tag — including the one the `tag` job just
   pushed, which re-triggers this same workflow): re-verifies the full gate at the exact
   tagged commit, then `npm publish`s and cuts a GitHub release.

**npm publish therefore only ever runs from a real tag push** — there is no code path
that publishes from a branch push directly. Stable versions (`0.2.0`) publish to the
`latest` npm dist-tag; prereleases (`0.2.0-rc.1`) publish to `next` and the GitHub release
is marked prerelease. A tag whose ref doesn't match `package.json`'s version (a stray
manual tag) is refused, not published. Without the `NPM_TOKEN` repo secret, both jobs
still run the full gate and skip publishing cleanly (green, not red) — releasing is
opt-in by adding that secret, everything else works unattended.

To cut a release by hand: bump `version` in `package.json`, land it on `main`; the rest is
automatic. (A maintainer can also push a matching `vX.Y.Z` tag directly — the `publish`
job runs the same way, `tag` job is just the convenience path.)

### Plugin manifest validation

`.claude-plugin/plugin.json`'s `version` must equal `package.json`'s — a plugin manifest
that drifts from the package version is silently wrong (Claude Code and npm would report
two different versions of the same release). `npm run check:plugin`
(`scripts/check-plugin.ts`) asserts this and runs in both CI (`ci.yml`, every push/PR) and
the release pipeline (both `tag` and `publish` jobs) — a version bump that forgets the
plugin manifest fails fast instead of shipping a mismatched plugin.

## How users install

### npx (any harness: goose, codex, or a manual Claude Code hook)

```
npx veritaserum install <claude-code|goose|codex>
```

Wires the `Stop` (and, for Claude Code, `UserPromptSubmit`) hook into the target
harness's own config. This is the direct-install path: it edits `~/.claude/settings.json` (or
`.claude/settings.json` with `--project`), goose's plugin directory, or a resolved codex
config snippet. See each `adapters/<harness>/README.md` for what gets touched.

### Claude Code plugin (`/plugin install`)

Once this repo is listed in a Claude Code plugin marketplace (see TODO below), install
with:

```
/plugin install veritaserum@<marketplace-name>
```

This is the richer path (SPEC.md §3 "Claude Code last"): one manifest
(`.claude-plugin/plugin.json`) wires the `Stop` and `UserPromptSubmit` hooks (pointing at
`${CLAUDE_PLUGIN_ROOT}/dist/cli.js`). That is the whole plugin — no MCP server, no skill.
Nothing to configure by hand.

### TODO: marketplace listing

Not yet done — tracked here, not silently assumed:

1. Publish (or point to) a Claude Code plugin marketplace repo/manifest that references
   this repo (`Trusty-Squire/veritaserum`) at a tagged version.
2. Verify `/plugin install veritaserum@<marketplace-name>` resolves and installs cleanly
   end-to-end (SPEC.md §6.12 "manifest install" acceptance item — not exercisable
   headlessly, needs a live Claude Code session).
3. Add the marketplace name/URL to this doc once it exists.

## The Node ≥24 floor, and why

`package.json`'s `engines.node` is `>=24`. The reason is `src/goose.ts`: reading goose's
`sessions.db` uses `node:sqlite`'s `DatabaseSync` — a zero-dependency, in-tree SQLite
client — instead of adding a native npm dependency for one read-only query path.
`node:sqlite` is stable as of Node 24; the CI and release workflows pin
`actions/setup-node`'s `node-version: 24` for exactly this reason (an older Node either
lacks `node:sqlite` entirely or only has it behind an experimental flag, and goose.ts
makes no attempt to feature-detect around that — the floor is a hard requirement, not a
soft recommendation).
