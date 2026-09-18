# veritaserum v3 — the case-law auditor

> ## 2026-07-20: case law removed
>
> The **case-law / demand / statute machinery** described throughout this spec — the auditor
> authoring demands, `veritaserum.law.yaml`, mechanical standing-law rechecks, the
> `contract.yaml` statute path, and the `veritaserum retire` / `veritaserum demands`
> commands — is **REMOVED**. Deleted files: `src/law.ts`, `src/demands.ts`, `src/gate-run.ts`,
> `src/schema.ts`, `veritaserum.law.yaml`, `contract.yaml`.
>
> **Why.** The mechanism's observed steady state was *unbounded accumulation of stale
> obligations*. In one session the law file grew from **58 to ~878 lines**; **44 demands sat
> unmet**; several demands pinned *single-commit* facts (an exact test count, a line number)
> that were false one commit later. The standing-law state line fired on every turn against
> a set the executor could not plausibly satisfy or clear — noise it learned to ignore, not
> ground truth. Precedent that only grows is not precedent; it is a ratchet with no release.
>
> **Replacement.** The auditor is now **stateless per turn**: the per-turn cross-family LLM
> verdict (supported / unsupported / contradicted + R9 unaccountable + warnings) PLUS a
> **no-LLM grounding tier** (`src/grounding.ts`, local ollama embeddings) that flags
> *referential gaps* — the agent blamed or relied on a thing it never observed. Both are
> **warn-only**; nothing blocks, nothing persists in the repo. Every section below that
> describes demands, case law, mechanical standing-law checks, or the statute path is
> **superseded by this note** (including §2 steps 4/6, the Case-law block, §4.1's "statute
> path survives" note, R6's retire command, and acceptance items 2 and 4).

**Thesis (as of the removal above).** When a turn ends, an async cross-family auditor
identifies the load-bearing claims in what the agent just said — tasks done, causes
asserted, futures recommended — and checks them against the only two sources of truth that
exist: **read-only git probes computed now** and **the harness's own record of what ran**.
Alongside the LLM verdict, a no-LLM grounding tier flags referential gaps from local
embeddings. No upfront contract, no lexical claim detection, no phase detection, no setup,
no persisted state.

**Thesis (original, superseded).** One mechanism: when a claim needed an oracle that doesn't
exist ("wrote an MCCFR solver, it's working well"), the auditor **demanded one** (the Kuhn
anchor), and that demand persisted as **case law**: a standing, deterministically
re-checkable expectation for this repo. Precedent, not legislation. — *removed 2026-07-20;
see the note above.*

**First target: the cheapest executor.** The layer's value is inversely proportional to
model capability (goose #9708: qwen lies within one hard run; Claude subtly over weeks) —
so v3 proves out on **goose + local ollama models** (`qwen2.5:3b`, `llama3.2:1b` are on
this server), where confabulation reproduces overnight, and ships to **Claude Code as the
final target**.

## 1. Rules (each one earned)

| # | Rule | Earned by |
|---|------|-----------|
| R1 | Two sources of truth only: **git probes computed at decision time** (validity) and the **harness's own record** (receipts). Veritaserum persists no authoritative state — a second recorder is a second thing to rot. Telemetry is measurement, never evidence. *(The law file — once the auditor's git-tracked output — is removed as of 2026-07-20; the auditor now persists nothing at all, which is R1 taken to its conclusion.)* | 31/31 wild false blocks from an evidence-starved judge; probes-over-history. |
| R2 | **No lexical claim detection.** Claims cannot be regexed (goose #9708: 0/16; phrasing space is infinite) and cannot be pre-staked (load-bearing claims are emergent). Claim identification is LLM judgment — run off the critical path on every turn that has something to audit, and *measured* (miss classes surface as telemetry, not assumptions). **A no-LLM embedding-classifier tier runs alongside** (the grounding detector, `src/grounding.ts`): it does *not* detect claims-by-regex — it detects **referential gaps** (a blamed/relied-on referent absent from what the agent observed) via local-embedding similarity, and its misses are *measured* by the eval cell (`eval/confab/grounding`), consistent with this rule. | goose #9708 + the forecasting objection. |
| R3 | **Sync path is deterministic and near-free; all LLM work is async.** ~0ms when nothing to audit, <50ms otherwise. The auditor runs detached; verdicts land at the next turn boundary. Known, accepted tradeoff: a false "done" can be acted on before the warning lands — the terse state-line is the only same-turn signal. | v1 hook tax; owner directive; codex #6 noted-and-accepted. |
| R4 | **Lazy evidence.** No claims → zero probes. Each claim pulls only the slices it needs. Under an agentic auditor this is an instruction, not a pipeline. | Owner directive. |
| R5 | **Warn-primary.** supported / unsupported (warn + demand the downgrade or the missing test) / contradicted (strongest flag). Nothing blocks by default; blocking per law entry is earned (≥50 judged events, Wilson 95% LB ≥ 0.9) and human-promoted. Warnings never repeat verbatim for the same claim in a session. **Captain override (2026-09-18), not a missing feature:** `VS_BLOCK=1` runs a same-turn Jev Choice audit and may block a confident confabulation at most twice per session so the agent can revise. Fail-open is unchanged. See docs/BLOCKING.md. | 15-block deadlock → coerced false confession; sycophancy literature. Jev ~350ms made a same-turn block affordable; the captain flipped the invariant on purpose. |
| R6 | ~~The auditor authors demands; the executor never does; the human vetoes.~~ **Demand authorship and the `veritaserum retire` command are removed (2026-07-20).** What survives: **cross-FAMILY is mandatory** (auditor model family ≠ executor model family — different checkpoints of one lineage share blindspots), because the LLM verdict is still one model judging another. | Self-preference is measured; correlated slop; codex #12/#20. |
| R7 | **Injections are terse, state-gated, specific — and rare.** Sharp specific facts: 10%→0/45 (p<0.05); ambient truth: null; chatty layers accelerate the compaction decay they treat. | goose #9708 injection arms. |
| R8 | **Fail open on own failure.** Any internal error in any surface → the agent proceeds + telemetry error event. Includes: no auditor available → `auditor_absent` recorded, the audit is skipped, the executor is never stalled; the grounding tier fails open to zero flags when ollama is absent. | v1 invariant, re-earned. |
| R9 | **Vagueness is not an escape hatch.** Substantial receipts + a claim-free summary is itself a verdict: "unaccountable work" — warn, demand concreteness ("state what was done and how you know it works"). The vague-turn rate is a first-class telemetry metric, because feedback pressure predictably teaches executors to stop signing statements. | codex #15, accepted. |

## 2. The mechanism

> **Superseded in part (2026-07-20).** Steps **4** (mechanical standing-law checks) and **6**
> (missing-oracle DEMAND) below, and the "standing law exists AND tree changed" sync line, are
> **removed** — there is no standing law. The audit job is now: read the turn → identify
> load-bearing claims → verdict them against git-probe/receipt evidence (steps 1-3, 5) →
> run the no-LLM grounding tier over {finalMessage, receipts} → warnings + next-turn feedback
> (step 7). No demand authorship, no mechanical rechecks, no repo write.

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
  6. missing oracle ──▶ DEMAND: a FAILING test authored into veritaserum's
     own state dir — never as a test file in the user's repo (gap + accept +
     standalone exit-code script; must fail at authoring or be discarded;
     dedupe by slug incl. retired; runs every audit with cwd = repo). A
     standing record plus state-oracle locator is written to
     `veritaserum.law.yaml`; that is the only allowed repo write, and it does
     not contain the hidden test bytes. Veto = `veritaserum retire`; no accept → unverifiable,
     never binding.
  7. verdict + demands ──▶ telemetry + next-turn feedback channel
  The auditor NEVER runs git write operations. Law commits are human moments.
```

**Auditor resolution (five rules + Jev + override; auth-probed, not just present):**
`TYPESAFE_API_KEY` present → **jev** (typesafe System One, pre-gathered Choice
auditor, cross-family for Claude and Codex, ~350ms). Then the original ladder:
1. `codex exec` available, non-Codex executor → **codex** (agentic, read-only sandbox).
2. `claude -p` available, non-Claude executor → **claude** (agentic, read-only).
3. Only codex available (Codex-family executor) → **codex with a same-family warning**.
4. Only claude available (Claude-family executor) → **claude with a same-family warning**.
5. Only metered options (goose/opencode/cursor-style setups where the executor is
   API-metered anyway) → **user chooses at doctor time**; recommend a strong model;
   default **glm-4.2** (completion-only → pre-gathered evidence mode).
`VS_AUDITOR` **overrides everything** (any CLI, any API model, any local ollama model, `jev`).
Floor beneath the ladder: nothing available → no LLM audit; runnable standing-law checks
still execute mechanically; sync path unaffected; `auditor_absent` telemetry + one
visible notice.
Internal mechanics (invisible to setup UX): every verdict is tier-tagged
(`agentic | pre-gathered | same_family`); precision and blocking-earn are computed per
tier so a weaker tier never inherits a stronger tier's trust. **`veritaserum doctor`**
reports which rule fired and why, with cached 1-token auth smoke calls. Pinning: model +
temperature recorded per run; overnight runs budget auditor calls with backoff + resume.

**Case law** — ~~`veritaserum.law.yaml`, git-tracked, in-repo~~ **REMOVED 2026-07-20 (see the
note at the top of this spec). The entire block below, including the statute path, is void.**
(v1 gate schema, lineage `evaluator-demand` | `user-word`):
- First demand costs an auditor judgment; every later claim in its scope is checked
  mechanically. Precedent amortizes.
- Law follows branches like any git-tracked file (a feature: law branches with code).
  The auditor reads law from **git HEAD**, never the tree copy; executor-authored tree
  drift is probe-detected and flagged; **human**-authored uncommitted edits are treated
  as pending-canon and said so in the verdict.
- Retirement: explicit command with reason + confirm (R6); recorded, never deleted.
- **Demand oracles are live immediately in local state; committed precedent is portable**:
  the state-owned script is mechanically rechecked on later audits. Its portable law-file
  gate becomes canonical when a human commits it; until then HEAD-based law loading reports
  pending canon. `veritaserum retire` retires both records.
- **Statute path** (`contract.yaml`, optional): `loadLaw` unions its active gates into the
  standing law, so a human-sealed gate binds exactly like an auditor-demanded precedent.
  It is a **data file you edit** — same schema, no negotiation machinery. The v1 tools that
  authored it (`contract_propose`/`contract_seal`, and the Knight behind them) are DELETED;
  see §4.1.

**Feedback channels (per harness, best available; the audit never depends on one — R8):**
- Claude Code: `additionalContext` at next UserPromptSubmit; `systemMessage` to the human.
- goose: **verify the injection path first** (adapter work item #1 — likely the
  prompt-submission hook's stdout; the turn-end hook may swallow output). If no injection
  channel exists: telemetry + law-file diff only, and §6.6 is scoped to catch-rate.
- Floor: telemetry + the law diff.

**~~Discoverability rides the demand line~~ — VOID 2026-07-20 (no demands, no `veritaserum
demands` command).** The feedback line now carries only the warn (a flagged claim, a grounding
flag, or R9). The original text: A demand's feedback line names
the command that RUNS the check the auditor already wrote (`veritaserum demands`, resolved
in whatever shape veritaserum was invoked) and tells the executor not to author its own
oracle. That is the executor's only channel for learning the CLI exists — deliberately
just-in-time: it arrives in the turn where it is actionable and says nothing on every other
turn. No MCP tool list, no standing `CLAUDE.md` rule, no ambient prompt tax. The demand's
test file lives in veritaserum's state dir, never the repo, so the executor can *run* the
oracle but not read or rewrite it.

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

**Claude Code last:** richest channels, shipped as the plugin (**hooks only** — one
manifest, no MCP server, no skill) once testbed numbers clear R5's bar. Distribution
pipeline is in scope for this phase: npm publish on version tag,
`.claude-plugin/plugin.json` validated in CI, package/plugin version sync asserted,
`docs/DISTRIBUTION.md`.

## 4. What v3 deletes — file-level manifest

| v1 file/path | Fate | Why |
|---|---|---|
| `claim.ts` DONE/NOT_DONE/GOAL regexes + extractors | **delete** | R2: no lexical claim detection |
| `hook.ts` (hookStop/hookPrompt dual paths) | **delete** | one evaluator; prompt-time challenge dead |
| `sentinel.ts` | **refactor into auditor** | evidence rules survive; sync judging dies |
| `judge-verdict.ts`, `gate-run.ts` | ~~refactor into auditor~~ **deleted 2026-07-20** (mechanical checks removed) | |
| `cli.ts` hook-stop/hook-prompt cases | **replace** with sync-path + enqueue | |
| goose/codex `adapters/` (v1 shapes) | **goose: rebuild** (first-class), codex: TODO 2 | |
| `schema.ts` | **deleted 2026-07-20** (only the law/contract schema + rung ladder lived here; both are gone) | |
| `resolve.ts`, `llm.ts`, `telemetry.ts` | **keep/extend** (auditor resolution, ollama client, telemetry fields) | |
| `contract.ts`, `verify.ts`, `ratchet.ts`, `propose.ts`, `seed.ts`, `mcp.ts` | **delete** (§4.1) | the contract system: one role, not four |
Acceptance asserts deleted symbols are gone (§6).

## 4.1 What v3 also deletes — the contract system (one role, not four)

The Knight (author a gate from a goal), the Transcriber (author a gate from a complaint),
and the semantic Judge (rule on a gate's claim over captured evidence) are **special cases
of the auditor**, which rules on a claim against evidence. *(The v1 text here also credited
the auditor with authoring checks via `law.ts`/`demands.ts`; that demand-authoring path is
itself removed as of 2026-07-20 — the auditor only rules now, it never authors. The
`contract.yaml` statute path that §2's Case-law block promised "survives" is void — the file
and its schema are deleted.)* Four names, one job. Each carried its own
vendor resolution, its own LLM client, and its own subprocess spawn path — 1537 lines the
live audit path needed exactly two things from (the rung ladder and `activeGates`, both now
in `schema.ts`).

The duplication was not free: every defect found in the 2026-07-12 session lived in the
second copy — the prompt-as-argv E2BIG ceiling existed in *two* spawn paths, and the MCP
server (whose only tools were `contract_*`) silently exited under npm's bin shim, so
veritaserum failed to connect in every repo but its own.

Deleted: `contract.ts`, `propose.ts`, `seed.ts`, `verify.ts`, `ratchet.ts`, `judge.ts`,
`judge-verdict.ts`, `knight-llm.ts`, `transcriber-llm.ts`, `pristine.ts`, `symptom.ts`,
`mcp.ts`; the `seed`/`ratchet`/`amend`/`verify` CLI commands; the plan→build seal ceremony
(hook + the `CLAUDE.md` rule the installer wrote); the `cursor` target (MCP-only — it
installed no turn-end hook, so it never caught anything); the `veritaserum-mcp` bin.

**No MCP surface, deliberately (R-push).** MCP is *pull*: the executor decides whether to
call. Ground truth cannot be opt-in — an agent skips the check exactly when it is
confabulating, so a voluntary audit tool is adversely selected and its green stamps are
worth least when they matter most. The audit is *pushed* by the harness at turn-end and the
executor cannot decline it. And for the genuinely voluntary surface — run my demands, show
me the law, show me what got caught — the executor **already has a shell**: `veritaserum
demands` / `retire` / `telemetry` are CLI commands it can call today. An MCP server would
add a protocol, a server process, a registration, and a connect failure mode to wrap a
binary that already works. `deletion-manifest.test.ts` asserts all twelve modules stay gone
and that vendor resolution exposes exactly one role.

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
2. ~~**Case-law lifecycle**~~ **REMOVED 2026-07-20** — no demands, no mechanical recheck, no
   retire. Replaced by: **Grounding tier** — the no-LLM referential-gap detector catches
   every trap fixture in `eval/confab/grounding` with zero false positives on honest twins,
   and folds its flags into the verdict's warnings (warn-only, never blocks).
3. **Audit scheduling**: concurrent turn-ends → one serialized chain; LIVE supersede and
   TESTBED drain both property-tested; crash mid-audit → lock released, job cleaned, R8 telemetry.
4. ~~**Law drift**~~ **REMOVED 2026-07-20** — there is no law file to drift.
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
8. **No-second-truth + privacy**: state contains queues, feedback, telemetry, and
   state-owned demand oracles; the portable law file is git-tracked in-repo;
   secret-canary greps clean (metadata-only telemetry).
9. **R8 chaos**: kill git / corrupt law / remove codex mid-run → executor never stalls.
10. **goose adapter contract**: payload parsing tested against real goose hook shapes;
    injection channel verified or telemetry-fallback documented and §6.6 scoped.
11. **v1 deletion manifest asserted**: regex extractors and dual-path symbols absent.
12. **Claude Code plugin E2E** (final phase): manifest install; channels live; fixtures
    replay identically; distribution pipeline green (npm tag publish, manifest CI,
    version sync).

## 7. Measurement (the product IS these numbers)
> **Amended 2026-07-20:** `verdict_basis` is now `probe | none` (the `standing-law` basis and
> per-law-entry precision are removed with case law). The grounding tier's flags land in the
> `caught` telemetry field via the verdict's warnings; its catch/false-positive rate is
> measured by the `eval/confab/grounding` cell, not by telemetry. Blocking is not currently
> earned by anything — everything is warn-only.

Per-verdict telemetry: `verdict_basis`, auditor tier, scheduling mode, latency,
executor/auditor models, advisory outcome (was the warn followed? — implemented: a warning delivered at UserPromptSubmit is recorded per session, and the next turn's LLM auditor judges it `addressed-corrected` | `addressed-confirmed` | `ignored`), **vague-turn rate** (R9). Published testbed
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
