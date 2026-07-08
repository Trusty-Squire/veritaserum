# TODOS

## 1. Ratchet governance (scoping, expiry, conflict handling)
- **What:** Per-gate hit/miss stats + a review command for ratcheted gates; possibly scoping/expiry.
- **Why:** Monotonic durable gates from vague human complaints accumulate "bad law" — stale corrections bind forever, conflicts pile up, nobody prunes (Codex outside-voice finding, eng review 2026-07-08).
- **Pros:** Keeps the contract trustworthy over months; the `repeats` counter already collects the needed data.
- **Cons:** Governance machinery for a single-user feature today; premature below ~10 active ratchets.
- **Context:** v1 ratchet is monotonic by design; `amend --retire` is the only weakening path (deliberately narrow). The fix is visibility (stats + review), not auto-expiry.
- **Depends on:** v2 shipped; real ratchet volume (trigger: >10 active gates).

## 2. Codex harness adapter
- **What:** Codex CLI adapter for the v3 case-law auditor. (Superseded in part, 2026-07-08: v3 inverted the order — **goose is now the FIRST adapter**, in-scope in SPEC.md §3, targeting the cheapest local ollama executors; Claude Code is the final target. Only the codex adapter remains deferred.)
- **Why:** Full harness coverage for the layer thesis; v1 config-snippet machinery exists in `adapters/codex/`.
- **Pros:** Third datapoint on adapter portability.
- **Cons:** Codex hook trust flow is interactive; lowest marginal value while goose + Claude Code cover both ends of the capability spectrum.
- **Context:** gbrain holds a "plumb harness capability matrix" entry — start there.
- **Depends on:** v3 stable on goose and Claude Code.

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
