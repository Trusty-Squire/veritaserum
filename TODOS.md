# TODOS

## 1. Ratchet governance (scoping, expiry, conflict handling) — SUPERSEDED 2026-07-13
v3 deleted the ratchet entirely (SPEC §4.1: the Transcriber and its `ratchet`/`amend`
commands are gone; the auditor is the one authoring path, and demands are retired with
`veritaserum retire`). Revisit only if a legislated-gate authoring path ever returns.
Original rationale kept below for context.

### (original)
- **What:** Per-gate hit/miss stats + a review command for ratcheted gates; possibly scoping/expiry.
- **Why:** Monotonic durable gates from vague human complaints accumulate "bad law" — stale corrections bind forever, conflicts pile up, nobody prunes (Codex outside-voice finding, eng review 2026-07-08).
- **Pros:** Keeps the contract trustworthy over months; the `repeats` counter already collects the needed data.
- **Cons:** Governance machinery for a single-user feature today; premature below ~10 active ratchets.
- **Context:** v1 ratchet is monotonic by design; `amend --retire` is the only weakening path (deliberately narrow). The fix is visibility (stats + review), not auto-expiry.
- **Depends on:** v2 shipped; real ratchet volume (trigger: >10 active gates).

## 2. Codex harness adapter — SHIPPED 2026-07-13
`veritaserum install codex` now writes the Stop + UserPromptSubmit hooks into
`~/.codex/hooks.json` directly (`src/install.ts`), and the production stress matrix
drives the packed codex hook with its real payload shape (`pnpm stress:production`).
The v1 config-snippet machinery in `adapters/codex/` was deleted with the contract
system. Remaining manual step: the user approves hook trust on codex's first run.

## 3. Hash-chained ledger (tamper detection) — SUPERSEDED 2026-07-08
v3 deleted the ledger entirely (no second source of truth); the law file is git-tracked,
so tampering is diff-visible by construction. Revisit only if authoritative veritaserum
state ever returns. Original rationale kept below for context.

### (original)
## 3-orig. Hash-chained ledger (tamper detection)
- **What:** Chain each ledger event's hash into the next; Stop verifies chain integrity, breaks are red flags.
- **Why:** SPEC.md §5 promises detection "later"; a Bash-capable agent can forge a green stamp today — chaining makes that detectable.
- **Pros:** Trust root upgrades from "agent probably won't" to "agent can't invisibly"; one hash per append.
- **Cons:** Adversarial-agent territory, outside v2's confabulation threat model; chain-break recovery paths (crash mid-append) add complexity.
- **Context:** Fold already skips corrupt lines; chaining is the natural next hardening of the 1A ledger.
- **Depends on:** 1A ledger shipped; evidence of stamp-gaming or external users.
