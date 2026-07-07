# ser — goose adapter (Archetype A)

Wires the ser layer into goose via bundled hooks. No manual `config.yaml` editing —
goose auto-discovers `<plugin-root>/hooks/hooks.json` for any enabled plugin.

- **`UserPromptSubmit → ser hook-prompt`** — captures the human's message; if it reads
  as a correction to the sealed contract, ratchets it into a gate. **Works today**:
  goose populates the message on this event.
- **`Stop → ser hook-stop`** — at turn-end, blocks iff the agent claimed done/pass
  while a contract gate is red (honest-incomplete passes). goose blocks on a stdout
  `{"decision":"block","reason":…}` payload.

## Install
1. Build/link ser so `ser` is on PATH: `cd <repo> && pnpm build && npm link` (or edit
   `hooks.json` to an absolute path / a `${PLUGIN_ROOT}/bin/ser` wrapper).
2. Copy this `adapters/goose/` dir into an enabled goose plugin location and enable it.
3. In your project: `ser seed "<goal>"` once to seal a contract. From then on the hooks
   verify every turn.

## Known limitation → one-line upstream fix (the P1 finding)

goose's **Stop** hook is context-free: it emits `HookContext::new(Stop, session_id)`
with **no message and no working_dir** (goose `crates/goose/src/agents/agent.rs`, both
Stop emit_blocking sites ~L1851 and ~L2570). So `hook-stop` cannot read the agent's
completion claim from the payload, and (to avoid trapping honest-incomplete work) it
therefore does **not** block on goose until the claim is available. `hook-prompt` is
unaffected — `UserPromptSubmit` already calls `.with_message(...)`.

goose *already has* the builder; the Stop site just doesn't call it. The fix is one line
at each Stop emission — the assistant text is already in scope as `output`:

```rust
// crates/goose/src/agents/agent.rs — at the Stop emit_blocking site (~L1851)
let ctx = crate::hooks::HookContext::new(
    crate::hooks::HookEvent::Stop,
    &session_config.id,
)
.with_message(output.clone())               // <-- add: the agent's final message (the claim)
.with_working_dir(working_dir.clone());     // <-- add: so the hook targets the right repo
```

With that, goose becomes full hard-block claim-gated (same as Claude Code + Codex, which
pass the last message today). This is the first ser→goose PR: trivial, additive, and it
unlocks the honest-incomplete-safe Stop block. Until it lands, ser on goose is
ratchet-capture + report; the enforcement Stop is a no-op-safe default.
