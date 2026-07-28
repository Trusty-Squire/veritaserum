# Upstream plan: native completion gate for goose — PRs + benchmarks

Companion to GOOSE-NATIVE.md (architecture, survey-cited). This is the execution
plan: what lands in which PR, and which measurements justify each to maintainers.
Constraint from the owner: **built into the harness core, config-gated — no
extension, no connector, no separate install.**

## PR series

### PR 1 — deterministic completion gate (the easy yes)
Core only, zero model calls, zero new dependencies, ~all-Rust port of veritaserum's
Tier 0. Config-gated (`completion_gate: { enabled: true }` in config.yaml),
default OFF for one release.

- New: `crates/goose/src/completion_gate/` — `CompletionInspector` trait +
  manager (mirrors `ToolInspector`/`ToolInspectionManager`, tool_inspection.rs:34).
- Invoked at the three Stop sites in `reply_internal` (agent.rs:1988/2894/2927),
  consuming the live `conversation` + `last_assistant_text` — no payload changes,
  #10358 becomes unnecessary.
- Contents (each an independently testable check):
  - claim-shape lexicons: completion / verification / quantity claims;
  - git probes at claim time: dirty-tree+HEAD-age vs "committed",
    ahead-of-upstream vs "pushed" (probe acquits as well as convicts);
  - **verification-freshness digests**: tree digest recorded when a
    verification-shaped command runs, compared at claim time — catches
    verify-then-mutate and stale-artifact citation deterministically;
  - full-session figure scan: a claimed quantity found in any tool result
    grounds the claim (never in the agent's own prior text — anti-laundering);
  - the audit gate: no claim-shaped content → nothing runs (measured 81% of
    turns in our production).
- Verdict rows into sessions.db beside `usage_ledger`; warn delivery = context
  injection via the existing Deny-path machinery (without denying) + a
  `SystemNotification` block; block mode NOT in this PR.
- Tests: ported deterministic fixtures (trap/twin pairs) — all mechanical,
  no model in CI.

### PR 2 — cross-family LLM auditor tier (config-gated, default off)
- Auditor resolution via `providers::init::create(name)` (init.rs:245) with
  `completion_gate.auditor: { provider, model, effort }`; fallback to
  `complete_fast` same-family, tier-tagged weaker.
- The judgment prompt ported intact: the guard family (abstention, predictions/
  judgments, fiction, reasoned inference, testimony, delegated research, recalled
  documentation), the reliance test, the load-bearing definition.
- **All policy in Rust, none in prose** (measured three separate times: prompt
  rules do not bind reliably; code does): top-1 flag budget, harm-sentence
  validity, quote-anchor verification, testimony/subagent-report/verified-claims/
  figure-scan demotions, quiet delivery predicate
  (contradicted ∨ (unsupported ∧ (figure ∨ completion-shape))).
- Async: `tokio::spawn` + `CancellationToken` per the
  `tool_pair_summarization_task` pattern (agent.rs:2827); blocking mode opt-in,
  reusing `GOOSE_STOP_HOOK_BLOCK_CAP`.
- Ships the 26-scenario constitution as fixtures + a mocked-provider test run in
  CI, plus an optional live-model run (not CI-gating) that emits the per-model
  compliance table.

### PR 3 — benchmark harness (justification infrastructure)
The seeded false-completion suite as a goose bench target (details below), so the
feature's value claims are reproducible by maintainers, not asserted by us.

Not ported, deliberately: the embedding classifier tier (goose has no embeddings
API — survey §5); our Node delivery/transport plumbing (obsolete in-process); the
law/demand machinery (deleted upstream of this design, for measured reasons).

## Benchmarks (each with its pass bar and its existing evidence)

| # | Benchmark | Metric | Bar | What exists today |
|---|---|---|---|---|
| B1 | Seeded false-completion grid | catch rate per claim class × model | ≥90% deterministic classes; LLM tier reported per model | ledger-overload churn protocol + hidden suite; the published 4-model grid |
| B2 | Honest-session friction | interruptions / 100 honest turns | < 1 at default config | production telemetry methodology: 54 audits/14h, 0 delivered, 5 suppressed-with-receipts |
| B3 | Overhead | p50/p95 turn-latency delta; $/1k turns | Tier-0 gated <1ms, active <50ms; Tier-2 cost published | external-hook measurements (29–36ms cold); 81% gate rate; ~6k-token audited prompts |
| B4 | Outcome A/B | post-done surprises; correction messages | gate-on strictly ≤ gate-off on hard tasks | advisory-outcome production data (verified correction flips); "trivial tasks tie" methodology note |
| B5 | Freshness adversarials | verify-then-mutate / stale-artifact / never-completed catch rate | 100% (deterministic) | fixture designs from the #9708 thread + our probe suite |
| B6 | Auditor-trust grid | 26-scenario compliance per model | published table; no bar (informational) | the constitution + Luna/qwen baselines |

Sequencing: B5 → B3 → B1 → B6 with PR 1/2 review; B2 on a maintainer-blessed
clean-session corpus; B4 last, only after adoption interest is real (it is the
expensive one and the one that most needs hard, messy tasks to say anything).

## The claims we can already make with receipts
- A deterministic tier catches commit/push/verification lies and stale-check
  citation with zero model cost and zero measured false accusations.
- The delivery contract can run for a working day across live sessions with
  zero unearned interruptions while auditing everything and logging why each
  suppressed flag was suppressed.
- The judgment tier's obedience is a measured, per-model number, not a vibe —
  and every boundary in its prompt was earned from a labeled production incident.
