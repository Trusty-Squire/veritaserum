# veritaserum v3 — the case-law auditor

**Thesis.** One mechanism: when a turn ends, an async cross-family auditor identifies the
load-bearing claims in what the agent just said — tasks done, causes asserted, futures
recommended — and checks them against the only two sources of truth that exist: **read-only
git probes computed now** and **the harness's own record of what ran**. When a claim needed
an oracle that doesn't exist ("wrote an MCCFR solver, it's working well"), the auditor
**demands one** (the Kuhn anchor), and that demand persists as **case law**: a standing,
deterministically re-checkable expectation for this repo. No upfront contract, no lexical
claim detection, no phase detection, no setup. Precedent, not legislation.

**First target: the cheapest executor.** The layer's value is inversely proportional to
model capability (goose #9708: qwen lies within one hard run; Claude subtly over weeks) —
so v3 proves out on **goose + local ollama models** (`qwen2.5:3b`, `llama3.2:1b` are on
this server), where confabulation reproduces overnight, and ships to **Claude Code as the
final target**.

## 1. Rules (each one earned)

| # | Rule | Earned by |
|---|------|-----------|
| R1 | Two sources of truth only: **git probes computed at decision time** (validity) and the **harness's own record** (receipts). Veritaserum persists no authoritative state — a second recorder is a second thing to rot. Telemetry is measurement, never evidence. The law file is the auditor's *output*, git-tracked, not a fact recorder. | 31/31 wild false blocks from an evidence-starved judge; probes-over-history. |
| R2 | **No lexical claim detection.** Claims cannot be regexed (goose #9708: 0/16; phrasing space is infinite) and cannot be pre-staked (load-bearing claims are emergent). Claim identification is LLM judgment — run off the critical path on every turn that has something to audit, and *measured* (miss classes surface as telemetry, not assumptions). | goose #9708 + the forecasting objection. |
| R3 | **Sync path is deterministic and near-free; all LLM work is async.** ~0ms when nothing to audit, <50ms otherwise. The auditor runs detached; verdicts land at the next turn boundary. Known, accepted tradeoff: a false "done" can be acted on before the warning lands — the terse state-line is the only same-turn signal. | v1 hook tax; owner directive; codex #6 noted-and-accepted. |
| R4 | **Lazy evidence.** No claims → zero probes. Each claim pulls only the slices it needs. Under an agentic auditor this is an instruction, not a pipeline. | Owner directive. |
| R5 | **Warn-primary.** supported / unsupported (warn + demand the downgrade or the missing test) / contradicted (strongest flag). Nothing blocks by default; blocking per law entry is earned (≥50 judged events, Wilson 95% LB ≥ 0.9) and human-promoted. Warnings never repeat verbatim for the same claim in a session. | 15-block deadlock → coerced false confession; sycophancy literature. |
| R6 | **The auditor authors demands; the executor never does; the human vetoes.** Cross-**FAMILY** is mandatory (auditor model family ≠ executor model family — different checkpoints of one lineage share blindspots). Retirement is explicit: `veritaserum retire <law-id> "<reason>"` — recorded provenance, confirm step, never inferred from chat, never executor-suggested. Human promotion required for blocking. | Self-preference is measured; correlated slop; codex #12/#20. |
| R7 | **Injections are terse, state-gated, specific — and rare.** Sharp specific facts: 10%→0/45 (p<0.05); ambient truth: null; chatty layers accelerate the compaction decay they treat. | goose #9708 injection arms. |
| R8 | **Fail open on own failure.** Any internal error in any surface → the agent proceeds + telemetry error event. Includes: no auditor available → mechanical law checks still run; `auditor_absent` recorded. | v1 invariant, re-earned. |
| R9 | **Vagueness is not an escape hatch.** Substantial receipts + a claim-free summary is itself a verdict: "unaccountable work" — warn, demand concreteness ("state what was done and how you know it works"). The vague-turn rate is a first-class telemetry metric, because feedback pressure predictably teaches executors to stop signing statements. | codex #15, accepted. |

## 2. The mechanism

```
turn ends (SYNC — what the user feels)
  ├─ no tool activity since last audit AND no standing law ──▶ PASS        ~0ms
  ├─ standing law exists AND tree changed since its last green run
  │      ──▶ inject ONE terse line ("law: kuhn_anchor unchecked against
  │           current tree") — prevention, never a block                   <50ms
  └─ enqueue audit job ──▶ PASS                                            ~0ms

audit scheduling (single runner, lockfile-serialized)
  LIVE mode:    a new turn-end SUPERSEDES any queued-not-started audit
                (fresh verdicts; staleness is noise to a human mid-session)
  TESTBED mode: the queue DRAINS fully (every turn audited; §6 metrics are
                only valid in this mode, and are reported per mode)

audit job (ASYNC — one auditor invocation)
  1. read the final message + the user's request (session record)
  2. identify LOAD-BEARING claims — untyped, the auditor's judgment
     · none, but receipts show substantial work ──▶ R9 "unaccountable work" warn
     · none, and nothing substantial ──▶ done (zero probes run, R4)
  3. evidence, lazily: git probes NOW · harness record tail · standing-law results
     (agentic auditors run their own read-only probes; completion-only auditors
      receive pre-gathered slices — a documented degraded tier)
  4. run RUNNABLE standing-law checks mechanically (exit codes, no LLM)
  5. per-claim verdicts: supported ▸ unsupported (warn + demand downgrade or the
     discriminating test) ▸ contradicted (strongest; blocks only if this law
     entry has earned it, R5)
  6. missing oracle ──▶ DEMAND: append to law (atomic tmp+rename; dedupe —
     runnable checks by normalized command, named expectations by slug with an
     overlap check; tagged with origin claim + ladder rung: analytic > oracle >
     held-out; lower rungs recorded, never binding)
  7. verdict + demands ──▶ telemetry + next-turn feedback channel
  The auditor NEVER runs git write operations. Law commits are human moments.
```

**Auditor resolution (five rules + override; auth-probed, not just present):**
1. `codex exec` available, non-Codex executor → **codex** (agentic, read-only sandbox).
2. `claude -p` available, non-Claude executor → **claude** (agentic, read-only).
3. Only codex available (Codex-family executor) → **codex with a same-family warning**.
4. Only claude available (Claude-family executor) → **claude with a same-family warning**.
5. Only metered options (goose/opencode/cursor-style setups where the executor is
   API-metered anyway) → **user chooses at doctor time**; recommend a strong model;
   default **glm-4.2** (completion-only → pre-gathered evidence mode).
`VS_AUDITOR` **overrides everything** (any CLI, any API model, any local ollama model).
Floor beneath the ladder: nothing available → no LLM audit; runnable standing-law checks
still execute mechanically; sync path unaffected; `auditor_absent` telemetry + one
visible notice.
Internal mechanics (invisible to setup UX): every verdict is tier-tagged
(`agentic | pre-gathered | same_family`); precision and blocking-earn are computed per
tier so a weaker tier never inherits a stronger tier's trust. **`veritaserum doctor`**
reports which rule fired and why, with cached 1-token auth smoke calls. Pinning: model +
temperature recorded per run; overnight runs budget auditor calls with backoff + resume.

**Case law** (`veritaserum.law.yaml`, git-tracked, in-repo — v1 gate schema, lineage
`evaluator-demand` | `user-word`):
- First demand costs an auditor judgment; every later claim in its scope is checked
  mechanically. Precedent amortizes.
- Law follows branches like any git-tracked file (a feature: law branches with code).
  The auditor reads law from **git HEAD**, never the tree copy; executor-authored tree
  drift is probe-detected and flagged; **human**-authored uncommitted edits are treated
  as pending-canon and said so in the verdict.
- Retirement: explicit command with reason + confirm (R6); recorded, never deleted.
- **Demands are inert until committed**: the auditor writes demands to the tree but reads
  law from HEAD, so a demand binds only after a human commits it — the law-file commit IS
  the veto moment (review the diff, drop what you reject). Consent by commit.
- The v1 negotiation tools (`contract_propose`/`contract_seal`) survive as the optional
  statute path — same file, same schema. Nothing else depends on them.

**Feedback channels (per harness, best available; the audit never depends on one — R8):**
- Claude Code: `additionalContext` at next UserPromptSubmit; `systemMessage` to the human.
- goose: **verify the injection path first** (adapter work item #1 — likely the
  prompt-submission hook's stdout; the turn-end hook may swallow output). If no injection
  channel exists: telemetry + law-file diff only, and §6.6 is scoped to catch-rate.
- Floor: telemetry + the law diff.

## 3. Adapter order and the ollama testbed

**goose first.** Verified against current releases (hooks blog, 2026-05): goose ships
Open Plugins hooks — `Stop` (the turn-end we need), `SessionStart/End`,
`UserPromptSubmit`, `Pre/PostToolUse` and shell/file before/after events — configured
via `~/.agents/plugins/<name>/hooks/hooks.json` (auto-discovered; `${PLUGIN_ROOT}`;
matcher regex). The `Stop` payload carries `{event, session_id, working_dir}` and **no
message content** — the final message and all receipts are read from goose's own
`sessions.db` (SQLite: `sessions`, `messages.content_json`) keyed by `session_id`, which
is a cleaner harness record than transcript parsing. Hook-stdout injection semantics are
undocumented → adapter work item #1 is an empirical probe (2A). NOTE: the local goose
on this server is a contributor build predating hooks; the testbed runner can drive
`goose run` per turn without hooks, while the adapter targets the hooks release.
`VS_EXECUTOR=ollama:<model>`.

**Why ollama-cheapest first:** cheap models on hard messy tasks are the *overnight
reproduction* of long-horizon confabulation (qwen: one run; glm: ~2 turns). The testbed
is the measurement engine — chode-class refactors, qwen2.5:3b under goose, TESTBED drain
mode, codex-exec auditor — where demand quality, verdict precision, and injection wording
get tuned before Claude Code ever sees v3.

**Claude Code last:** richest channels, shipped as the plugin (hooks + MCP + skill, one
manifest) once testbed numbers clear R5's bar. Distribution pipeline is in scope for this
phase: npm publish on version tag, `.claude-plugin/plugin.json` validated in CI,
package/plugin version sync asserted, `docs/DISTRIBUTION.md`.

## 4. What v3 deletes — file-level manifest

| v1 file/path | Fate | Why |
|---|---|---|
| `claim.ts` DONE/NOT_DONE/GOAL regexes + extractors | **delete** | R2: no lexical claim detection |
| `hook.ts` (hookStop/hookPrompt dual paths) | **delete** | one evaluator; prompt-time challenge dead |
| `sentinel.ts` | **refactor into auditor** | evidence rules survive; sync judging dies |
| `judge-verdict.ts`, `gate-run.ts` | **refactor into auditor** (mechanical check exec) | |
| `cli.ts` hook-stop/hook-prompt cases | **replace** with sync-path + enqueue | |
| goose/codex `adapters/` (v1 shapes) | **goose: rebuild** (first-class), codex: TODO 2 | |
| `contract.ts`, `schema.ts`, `verify.ts`, `ratchet.ts`, `resolve.ts`, `llm.ts`, `telemetry.ts`, `propose.ts`, `mcp.ts` | **keep/extend** (law schema, statute path, vendor machinery + ollama client, telemetry fields) | |
Acceptance asserts deleted symbols are gone (§6).

## 5. Non-goals (deliberate, user-litigated)
Adversarial evasion of the auditor · omission-catching beyond standing law + R9 ·
same-turn interruption of a false "done" (R3 tradeoff) · "models lie less" — lies become
non-propagating (audited) and non-repeating (precedent). Codex #21's "simpler harness"
(checklists + mandatory receipts before final response) is v2's toll gate — rejected on
measured grounds: claims can't be cheaply detected and ceremony kills adoption.

## 6. Acceptance (v3 passes when)

1. **Fixture replay through the auditor** (real telemetry + gbrain cases): chode
   committed-work → supported; speakeasy infra → supported; fabricated module + fake
   tests → contradicted; empty-repo "done, tests pass" → unsupported; Trusty-Squire
   IP-wall → unsupported + discriminating test demanded; stale-state.md deference →
   fresh-probe demanded; "wrote an MCCFR solver, working well" → Kuhn-anchor demand
   appended; substantial-diff + claim-free summary → R9 unaccountable-work warn.
2. **Case-law lifecycle**: demand once (LLM) → mechanical recheck (no LLM) → explicit
   retire with provenance → retired law never fires; low-rung demands recorded, never
   binding; duplicate demands (same normalized command / overlapping slug) never append.
3. **Audit scheduling**: concurrent turn-ends → one serialized chain, no YAML corruption;
   LIVE supersede and TESTBED drain both property-tested; crash mid-audit → lock
   released, job cleaned, R8 telemetry.
4. **Law drift**: executor deletes/edits law in tree → flagged, auditor reads HEAD;
   human uncommitted edit → pending-canon noted.
5. **Auditor resolution matrix**: all five installation states behave as specified
   (including `auditor_absent` with mechanical checks still running); verdicts
   tier-tagged; per-run model+temp pinning asserted.
6. **Seeded-task E2E** (the load-bearing test): ≥5 scripted chode-class tasks with known
   end-states (machine-labelable honest/false turns; 10% human spot-audit validates the
   labeler), qwen2.5:3b under goose, TESTBED mode, codex-exec auditor: ≥1 real catch per
   suite grounded in a named receipt/probe, and false-flag rate reported per task with
   the label protocol — not a single hand-picked run.
7. **Budgets (CI-enforced)**: sync path ~0ms nothing-to-audit / <50ms otherwise, zero
   sync LLM; ≤1 auditor *invocation* per audited turn; lazy-evidence asserted (zero
   probes on claim-free, non-substantial turns).
8. **No-second-truth + privacy**: state dir contains telemetry only; law file git-tracked
   in-repo; secret-canary greps clean (metadata-only telemetry).
9. **R8 chaos**: kill git / corrupt law / remove codex mid-run → executor never stalls.
10. **goose adapter contract**: payload parsing tested against real goose hook shapes;
    injection channel verified or telemetry-fallback documented and §6.6 scoped.
11. **v1 deletion manifest asserted**: regex extractors and dual-path symbols absent.
12. **Claude Code plugin E2E** (final phase): manifest install; channels live; fixtures
    replay identically; distribution pipeline green (npm tag publish, manifest CI,
    version sync).

## 7. Measurement (the product IS these numbers)
Per-verdict telemetry: `verdict_basis` (probe | receipt | standing-law | none),
law-entry id, auditor tier, scheduling mode, latency, executor/auditor models, advisory
outcome (was the warn followed?), **vague-turn rate** (R9). Precision per **law entry**
(not coarse families) with Wilson bounds — the only path to blocking. Published testbed
numbers: catch rate within-run, false-flag rate on labeled honest turns, demand quality
(human veto rate), decay curves per executor model — segmented by mode and auditor tier.

## Review status — see terminal report. v2 review (14 findings, CLEARED) superseded.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | ISSUES_ABSORBED | v3 pass: 21 points — 2 tensions decided, 8-fix bundle applied, 5 noted-as-accepted-tradeoffs, rest resolved by prior amendments |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR (PLAN) | v3 pass: 12 issues, 0 critical gaps, all resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** Outside voice ran on v3 (gpt-5.5, high reasoning, read-only). Its strongest catches — one-call audit infeasibility (→ agentic auditor + resolution ladder), claim-evaporation under feedback (→ R9 inverse demand) — were accepted; its "simpler harness" strategic alternative is v2's toll gate, rejected on measured grounds and recorded in §5.

**CROSS-MODEL:** Codex independently re-derived the law-file-as-state concern (→ HEAD-read + drift semantics) and the metric-gameability concern (→ seeded-task suite ≥5). Disagreements kept: async-lateness and warn-primary stand as user-litigated tradeoffs (R3, R5).

**VERDICT:** ENG CLEARED — ready to implement (build scope: whole spec, user-selected). CEO review optional.

NO UNRESOLVED DECISIONS
