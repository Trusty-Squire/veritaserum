# ser — Claude Code adapter (Archetype A, hard-block **today**)

Claude Code is the cleanest hard-block target: its `Stop` hook can block (exit 2 with
a stderr reason, or a stdout `{"decision":"block","reason":…}` payload), `UserPromptSubmit`
carries the human message, and a plugin bundles hooks + subagent + MCP in one install.
Unlike goose, no upstream change is needed — the claim is reachable now.

- **`Stop → ser hook-stop`** — Claude Code hands the hook a `transcript_path` (JSONL) and
  `cwd`. `ser hook-stop` reads the last assistant message from the transcript, extracts
  the completion claim, verifies, and blocks iff the claim is contradicted by a red gate.
  Honest-incomplete passes.
- **`UserPromptSubmit → ser hook-prompt`** — the payload's `prompt` field is the human
  message; a correction to the sealed contract is ratcheted.

## Install
1. Put `ser` on PATH: `cd <repo> && pnpm build && npm link`.
2. Either **plugin** — `claude /plugin install <path-to>/adapters/claude-code` — or paste
   `settings-snippet.json`'s `hooks` into `~/.claude/settings.json`.
3. In your project: `ser seed "<goal>"` once. From then on Claude Code cannot end a turn
   claiming done while a contract gate is red.

## Why this is the P1.5a proof
This is the first end-to-end demonstration that a *real* agent genuinely can't say "done"
over a red gate — no mocked harness, no pending upstream PR. The same `ser hook-stop`
binary serves goose (post-#9968 + the working_dir PR) and codex; only the payload shape
differs, and the CLI normalizes it (`last_assistant_message` | `transcript_path` | `prompt`).

Cross-vendor note (DESIGN §9): a Claude *subagent* judge would be same-vendor
(self-preference bias). The verify-time judge must be an external non-Claude call; a
Claude subagent is fine only for the *knight* (design). P0/P1 use no LLM judge yet.
