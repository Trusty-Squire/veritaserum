# veritaserum — goose adapter (v3, SPEC.md §3 "goose first")

goose is the **first** v3 adapter — it's the cheapest place confabulation reproduces
(qwen2.5:3b under goose fabricates within a single run; SPEC.md thesis). This adapter
wires the v3 **sync path** (SPEC §2) into goose via its Open Plugins hooks; Claude Code
ships last, once testbed numbers clear the R5 bar.

## What's wired

- **`Stop → scripts/vs-stop.sh → veritaserum hook-stop`** — the only hook. At turn-end:
  a ~0ms "nothing to audit" check, a terse standing-law state line when due (never a
  block), then an async audit job enqueued and the turn released. No claim regex, no
  LLM on this path (R2/R3). See `src/cli.ts`'s `hook-stop` case for the exact steps.
- **No `UserPromptSubmit` hook.** v3 deleted the prompt-time challenge (SPEC §4), and the
  Knight that used to issue it is gone entirely (SPEC §4.1). goose also has no injection
  channel at prompt time, so the verdict reaches it via telemetry + the law diff.

## Install

goose auto-discovers `<plugin-root>/hooks/hooks.json` for any **enabled** plugin — no
`config.yaml` editing (`crates/goose/src/plugins/discovery.rs`). Two scopes:

- **User scope** (all projects): copy or symlink this directory to
  `~/.agents/plugins/veritaserum/`.
- **Project scope** (one repo): copy or symlink it to
  `<project>/.agents/plugins/veritaserum/`.

```sh
# user scope, symlinked to a repo checkout (dev/local-testbed convenience —
# picks up rebuilds without re-copying):
ln -s /path/to/veritaserum/adapters/goose ~/.agents/plugins/veritaserum

# project scope, copied (no dependency on the checkout surviving):
cp -r /path/to/veritaserum/adapters/goose <project>/.agents/plugins/veritaserum
```

Restart goose (plugin discovery runs at startup) and it's live — no `config.yaml`
edit, no enable step beyond the plugin existing on disk and not being disabled in
`plugins.enabledPlugins`/`disabledPlugins` settings.

`scripts/vs-stop.sh` resolves a global `veritaserum-hook` first, then a global
`veritaserum` (`hook-stop`), then the private runtime copied into the plugin by
`veritaserum install goose`. The private copy is deliberate: an npm-exec cache and its
bin shim may disappear as soon as installation ends, while a Goose plugin is durable.
A checkout-linked plugin can still fall back to the checkout's compiled
`dist/hook-cli.cjs`; with no resolvable runtime at all the script exits 0 — fail open
(R8), never breaking goose's turn-end.

`VS_EXECUTOR` defaults to `ollama` in `vs-stop.sh` (SPEC §3: goose + local ollama is
the first testbed target) — override it per setup, e.g. `VS_EXECUTOR=ollama:qwen2.5:3b`,
to match whatever `goose configure` has wired as the executor model.

## The Stop payload

Verified against `crates/goose/src/agents/agent.rs` (`stop_hook_context`) and
`crates/goose/src/hooks/mod.rs` (`HookContext`) in a live checkout: **today's** goose
build actually sends `last_assistant_message` + `working_dir` on `Stop`, not just
`{event, session_id, working_dir}` — an earlier limitation (a stale checkout emitting
no message at all) was fixed upstream (aaif-goose/goose#10296).

**v3 ignores `last_assistant_message` on purpose anyway.** SPEC.md §3 is explicit:
sessions.db is "a cleaner harness record than transcript parsing," and R1 (SPEC §1)
treats the harness's own record as one of exactly two sources of truth — an ephemeral
hook field is not that; the SQLite row is. So `src/cli.ts`'s `hook-stop` case only
reads `{event, session_id, working_dir}` off the payload and does everything else
(the "nothing to audit" check, and — once enqueued — the async audit's final message,
user request, and receipt tail) against `sessions.db`, via `src/goose.ts`.

## `sessions.db`

Default location: `~/.local/share/goose/sessions/sessions.db` (override with
`VS_GOOSE_SESSIONS_DB`, e.g. for a non-default `GOOSE_PATH_ROOT` or a testbed harness
running many sessions against one throwaway db). Read-only, via node:sqlite's
`DatabaseSync` (`{ readOnly: true }`) — this adapter never writes to it.

Schema (verified against a live db, not just docs):

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,              -- "user" | "assistant"
  content_json TEXT NOT NULL,      -- JSON array of content blocks
  created_timestamp INTEGER NOT NULL,  -- unix epoch SECONDS
  ...
);
```

`content_json` blocks carry a `type`: `"text"` (plain message text — both human
prompts and assistant replies), `"thinking"`, `"toolRequest"` (assistant issues a tool
call), `"toolResponse"` (the result — **rides back as `role: "user"`**, goose's own
convention, not veritaserum's). `src/goose.ts` treats `toolRequest`/`toolResponse` as
"tool activity" and skips `toolResponse` blocks when hunting for the human's actual
last request text.

`src/goose.ts` exports:
- `hasToolActivitySince(dbPath, sessionId, sinceEpochMs)` — the sync-path "nothing to
  audit" probe (SPEC §2 step 1): any tool-bearing message after the watermark?
- `readGooseSession(sessionId, dbPath?)` — `{finalAssistantMessage, userRequest,
  receiptsTail}` for the async audit job (SPEC §2 "audit job" steps 1/3). `receiptsTail`
  is the last ~40 tool call/result messages as compact text, capped at 32KB.

Both are defensive by construction: a missing db file, a missing table, or an unknown
`session_id` all degrade to `false`/`null`, never throw — a goose schema change can't
take down the sync path (R8).

## Blocking/corrective variant (`hook-stop-goose-block`)

**Proven this session, against a live goose 1.41.0 run:** goose has no
`additionalContext`-style injection channel, but a `Stop` hook that **exits 2 with a
reason on stderr BLOCKS turn-end** — goose prints "Stop hook blocked ending this
turn" and feeds the stderr text back to the agent, which then acts on it (verified
end-to-end: a Stop hook emitting "output codeword X" made DeepSeek output X). That's
a real corrective loop, not just telemetry — so this adapter ships a second, opt-in
plugin that uses it, alongside the async `hook-stop` above (which is untouched).

This is an experiment, not the v3 mechanism (SPEC §2 is explicit that the sync path
stays deterministic/near-free, R3) — it deliberately trades that budget for a
synchronous, blocking audit so the correction itself can be exercised on goose
1.41.0.

**Protocol:** `scripts/vs-stop-block.sh` execs `veritaserum hook-stop-goose-block`,
which reads the Stop payload, loads the turn from `sessions.db` (`readGooseSession`),
resolves the cross-family auditor (SPEC §2 "Auditor resolution"), and runs `audit()`
**synchronously** (an agentic auditor call, ~30-60s — expected and accepted here).
If any claim verdicts as `unsupported`/`contradicted`, or the auditor flags R9
"unaccountable work": it writes a terse correction to **stderr** (the flagged
claims + their basis + any demands, ending "Run the actual check and correct or
retract before finishing.") and **exits 2** — the goose block. Otherwise it exits 0.
A per-session block cap (`VS_BLOCK_CAP`, default 2 — checked *before* the audit
call) guarantees the loop never deadlocks: once a session has been blocked that
many times, the hook lets the turn finish regardless of verdict. Any internal
failure (missing session, auditor error, etc.) exits 0 — R8 fail-open, this
variant never blocks on its own breakage.

**Install** as its own plugin, separate from the async one:

```sh
mkdir -p ~/.agents/plugins/veritaserum-block/hooks ~/.agents/plugins/veritaserum-block/scripts
cp /path/to/veritaserum/adapters/goose/hooks/hooks-block.json ~/.agents/plugins/veritaserum-block/hooks/hooks.json
cp /path/to/veritaserum/adapters/goose/scripts/vs-stop-block.sh ~/.agents/plugins/veritaserum-block/scripts/vs-stop-block.sh
chmod +x ~/.agents/plugins/veritaserum-block/scripts/vs-stop-block.sh
```

(The source file is named `hooks-block.json`, not `hooks.json`, so it can sit next
to the async variant's `hooks/hooks.json` in this same adapter directory without
colliding — goose only auto-discovers a plugin dir's `hooks/hooks.json`, so the
copy step above renames it into place.) Restart goose; only ONE of
`veritaserum`/`veritaserum-block` should be enabled at a time, since both fire on
`Stop` for the same session.

## OPEN QUESTION: does Stop-hook stdout inject into goose's context?

**Unresolved — SPEC §2 "Feedback channels" calls this out explicitly as adapter work
item #1.** goose's hook runner (`crates/goose/src/hooks/mod.rs`) captures a command
hook's stdout for `PreToolUse`-style blocking decisions, but it's undocumented whether
`Stop` stdout is surfaced back into the conversation the way Claude Code's
`additionalContext` is. Until this is verified, this adapter assumes **no** injection
channel on `Stop` and treats the terse law-state line as best-effort console output —
useful for a human tailing goose's process, not guaranteed to reach the model. If it
turns out `Stop` stdout enters context, the terse line doubles as a same-turn nudge
(closer to R7's intent); if not, SPEC §2 says the floor is telemetry + the law diff,
which this adapter already satisfies (`veritaserum telemetry`, `veritaserum.law.yaml`
git history).

**How to probe it** (do this before relying on any Stop-hook injection):

1. Build a scratch plugin at `~/.agents/plugins/vs-probe/hooks/hooks.json`:
   ```json
   { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
     "command": "echo 'VS-PROBE-MARKER-7f3a: the turn-end hook fired.'" }] }] } }
   ```
2. Start a goose session, have it do one trivial turn (e.g. "say hi"), let it finish
   (triggers `Stop`).
3. On the *next* turn, ask the model directly: "Did you see a message containing
   VS-PROBE-MARKER-7f3a anywhere in your context?"
4. Yes → Stop stdout injects into context (upgrade the terse line's role in the
   adapter's docs/telemetry accordingly). No / model has no idea → confirmed no
   injection channel; leave the assumption above as-is and remove this open question
   once resolved either way.

Record the result in this file (replace this section) once run — do not leave the
question open indefinitely; SPEC §6.10 scopes acceptance to "verified or
telemetry-fallback documented," not both being simultaneously true.
