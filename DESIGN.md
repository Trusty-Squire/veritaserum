# plumb — a portable ground-truth layer for coding agents

> Working name. A plumb line is the physical ground-truth reference for "true":
> you hang it, and reality tells you what's vertical. This is that, for agent claims.

## 0. One sentence

**A lie-detector-and-referee that clips onto the coding agent you already use, so the
agent cannot say "done" until reality agrees — and remembers your corrections forever.**

You prompt normally. plumb turns your request into checkable "done" conditions, refuses
to let the agent end a turn on a false claim, and turns every complaint you make into a
permanent check. It rides the harness's existing hooks; you learn nothing.

## 1. Why this exists (and why it's not a harness or a company)

- **The bottleneck is verification, not generation** — now the field's operating
  assumption. Berkeley RDI (2026) drove 8 flagship agent benchmarks to ~100% *without
  solving a single task* (SWE-bench Verified: a 10-line `conftest.py` that rewrites
  pytest results to "passed"). METR: frontier models reward-hack >30% of runs.
  Gate *integrity*, not model capability, is what gets exploited.
- **Honesty tracks verification-availability** (our experiments + goose #9708):
  models are honest about what they can check and confabulate about what they can't.
  An explicit abort option cut cheating 54%→9% (ImpossibleBench). Honest-halt works.
- **The discipline is known but hand-rolled.** The viral "LOOPS.md" field notes
  (apocryphal — no Karpathy primary source, but the ideas are SOTA-validated) describe
  contract-first / separate-roles / disk-state / restart / read-traces. They assume a
  power user hand-builds the loop. ~Nobody will. **plumb packages that discipline as
  enforcement a non-expert gets by enabling one extension.**
- **Not a harness:** OpenHands / Devin / Claude Code / goose own that surface, and
  verification is staying *in-harness* by consensus (MCP standardizes transport +
  server-trust, not output-correctness). We are a *layer* every harness plugs into.
- **Not (necessarily) a company:** it needs to work well and be adoptable, not raise.
  ser demotes to reference implementation + corpus generator.

### What plumb adds beyond the LOOPS.md discipline (the parts it omits)
1. **Oracle layer for un-testable claims** — a contract of "testable assertions" can't
   hold "is this tractable / is this abstraction right." plumb designs an independent
   check for those (anchor / certificate / metamorphic / property / consequential-use)
   or honestly abstains. *This is the open research frontier.*
2. **Anti-gaming teeth** — the naive "the contract is what gets graded" *is* the
   reward-hackable surface. plumb protects the grader from the executor
   (assertion-authority), runs the judge on a read-only snapshot, and ships
   null-solution attack tests.
3. **Durable, human-attributed ratchet** — corrections persist across iterations and
   carry the human's exact words; they never regress.
4. **Cross-vendor judge** — self-preference bias is measured (a judge is up to 50% more
   likely to pass its own model family's output), so the judge is a *different vendor*
   than the builder.

## 2. The law everything obeys

**The executor is corrected only by legible, deterministic signals it cannot edit —
never by the judge's solutions or the eval internals.**

- executor → judge: the executor's code + claims flow to the judge. ✅
- reality → executor: deterministic gate results + observed **symptoms** flow back
  ("your octopus doll doesn't move", "the pot didn't change"). ✅ — a symptom is a
  legible failure message, the semantic equivalent of `expected X, got Y`.
- judge → executor: **solutions and eval internals never flow.** ❌ (no
  teaching-to-the-test). The judge's semantic *verdict* goes to the human + the record.

This is "gates are shell commands judged by exit code, no prose evaluation" restated as
an information-flow law. It is the single invariant that makes the loop un-gameable.

## 3. Roles and their tool profiles

Three roles, three contexts, deliberately unequal power.

| Role | Read code | Run / drive | Write code | Edit gates | Output |
|---|---|---|---|---|---|
| **Executor** | ✅ | ✅ | ✅ (blast-radius) | ❌ protected | code + claims |
| **Knight** (design-time, `open`) | ✅ explore | run-to-understand | ❌ | writes *contract* only | the contract / oracle |
| **Judge** (verify-time) | reads *evidence* | ❌ (harness drives) | ❌ | ❌ | verdict + symptom |

- **Knight** designs the contract from the goal (or ingests an authoritative spec+evals
  and only gap-fills). Tool-rich on read, writes only `contract.yaml`.
- **Judge** grades a **read-only snapshot**; it only interprets captured evidence.
  A judge that can act is a second executor; a judge that can edit its criteria is not
  a judge.

## 4. Tool surface (lean — explicit ops, not auto-detected)

**Ratified R4 (2026-07-07):** the contract-mutating operations are SPLIT — never one
auto-detecting tool. Silent auto-detect can weaken the contract ("don't worry about
mobile" → retires a gate = monotonicity violation). The op is always explicit and
recorded; adapters may auto-*suggest* which op to call for a one-call UX, but they never
silently mutate.

- `contract_seed(goal)` — no contract yet → goal → contract.yaml (knight; ingest an
  authoritative spec+evals if provided, gap-fill only).
- `contract_ratchet(complaint)` — append a gate from a correction; reconcile
  (new / duplicate-repeat-signal / contradiction-surface-to-human). Append-only;
  monotonic; never weakens.
- `contract_amend(retire | scope-change)` — the ONLY weakening path. Requires human
  confirmation; recorded, not deleted (audit history). Handles requirement changes and
  gate retirement (governance, §14 R6).

`contract_verify(snapshot, claims, level)` — **the one verification.** Run the
claim-relevant gates against reality; return pass, or a confrontation with the (redacted,
§14 R5) symptom. `level=full` switches on the expensive gates at the ship transition
(§6). A read-only `contract_status()` exists for pull-convenience; not load-bearing.

Adapter UX: the harness adapter classifies the human's message and calls the right op,
requiring confirmation for `amend`. Classification is a *suggestion*; the op is the
record of truth.

## 5. Gate types

- **Deterministic gate** → the harness runs a shell command, reads the exit code.
  No LLM, no judge-agent. The bulk of verification. Carries a mandatory tamper-guard.
- **Semantic gate** → the harness *deterministically* captures evidence per the gate's
  recipe (boot with `serve`, click, screenshot → a filmstrip/output bundle); a thin
  **cross-vendor** LLM judge reads the bundle + the claim → verdict + symptom. The judge
  never drives the app (non-reproducible / gameable) — the recipe does.
- **Un-scriptable / aesthetic-gestalt** → **abstain, route to a human gate.** We do not
  fake a verdict on taste; the human is the gate by design.

## 6. Enforcement model — one blocking hook, in-band only

**Only in-band, blocking feedback changes agent behavior.** Passive injection is null
(#9708, N=200); remote CI failures get ignored because they don't interrupt the loop.
So enforcement rides the harness's **blocking Stop hook**, and nothing else is trusted
to change the agent.

At every Stop (agent yields control):
1. Run the **fast, free, deterministic** gates + extract the agent's claims.
2. **Block iff a claim is contradicted** by reality (claimed pass/done/committed, isn't).
   Honest incompleteness ("finished step 1, more to go", gates legitimately red) → allow.
   Block on airtight contradiction only; uncertainty passes (false-negatives over
   false-positives — a bad block makes the tool unusable).
3. On the Stop whose claim is **whole-task completion**, *also* run the **expensive**
   gates (integration suites / benchmarks = time-expensive; LLM-judge = money-expensive).
   Same hook, same blocking, conditionally. Genuinely multi-hour gates are the rare
   async exception, flagged explicitly.

**Ratchet capture** rides `UserPromptSubmit` (fires on the human's message, before the
agent sees it): classify "correction to the shipped contract?" → if yes, ratchet.
Reliable firing; only the classification is fuzzy.

**CI / git pre-push** runs the full contract at real ship — but as a **human/team merge
backstop**, never the agent's feedback loop (the agent ignores out-of-band signals).
The same `contract.yaml` travels with the repo, so CI runs `plumb check` with zero
extra wiring.

## 7. Durable vs disposable

- **Durable:** `contract.yaml` on disk — append-only, monotonically growing,
  human-attributed, retire only via human clutch. It is the spine that survives every
  restart. This is why state lives on disk and the human sits at its *boundary*, not
  inside the loop.
- **Disposable:** the executor's code. On failure, **rollback to the last green
  checkpoint** (git reset), then retry — *not* blind "delete the project" (SOTA:
  checkpoint-rollback-to-green is validated; full-delete is not).

## 8. The oracle layer (the hard part / open frontier)

Easy claims are solved (compile / tests / commit / grader-untampered). The unsolved
frontier — the field calls it "the hardest open problem in LLM training" — is claims a
normal test can't check: *is this tractable, is this abstraction right, does this
generalize.* The knight:
1. Detects the **load-bearing, unverifiable** claims (Phase-3 result: a clean model
   does this ~94% from the taxonomy).
2. Designs an **independent** check — anchor (same engine on a tiny known-answer
   instance), certificate (checking cheaper than solving: residual / best-response),
   metamorphic (invariants under known transforms), property-based, held-out,
   measured-extrapolation — with **constants recomputable-or-cited, never quoted**.
3. Or, if none exists, **abstains honestly** and pulls the earliest consequential-use
   check forward (route to human).

plumb's standing research problem: *for a claim with no obvious test, reliably design a
trustworthy independent check — and reliably know the boundary where you can't, so you
escalate instead of faking it.* Making (1) reliable at the tail, (2) un-foolable once
designed, (3) calibrated about when to abstain.

## 9. Distribution — harness capability matrix (researched 2026-07-07)

**Universal finding (all 5 harnesses): MCP is pull-only; enforcement is ALWAYS the
command-hook layer.** The verifier must be a shell/CLI check the hook runs (`plumb
verify`), never an MCP tool the model chooses to call. MCP is the pull-side surface;
the CLI is the enforcement door. This holds on every target.

| Harness | Turn-end veto | Human-msg hook | Judge isolation | Install | **Tier** |
|---|---|---|---|---|---|
| **goose** | Stop → `{"decision":"block"}` (source-verified) | `UserPromptSubmit` | subagent | plugin bundles `hooks/hooks.json`, one enable | **hard-block** |
| **Claude Code** | `Stop` exit 2 / `decision:"block"` + reason | `UserPromptSubmit` | fresh-context **subagent** (own model) | **plugin bundles hooks+subagent+MCP**, `claude /plugin install` | **hard-block** (best install) |
| **Codex CLI** (v0.142) | `Stop` force-continue (`reason`→next prompt) | `UserPromptSubmit` | subagent | `codex plugin add` from marketplace; **hook-trust** (ship managed hook) | **hard-block** |
| **Cursor** | ✗ `stop` can't veto — false msg already shown; `followup_message` auto-relaunch (loop≤5) | `beforeSubmitPrompt` (can block) | — | `.cursor/hooks.json` (commit) or Customize; **fail-open → set `failClosed`** | **soft-block** |
| **opencode** (v1.17.4) | ✗ no turn-end veto exists; `session.idle` is observe-only, post-hoc; `tool.execute.before` vetoes one tool only | `chat.message` | — | npm plugin / `.opencode/plugin/` drop-in | **soft-block** |

**Headline: 3 of 5 are hard-block (goose, Claude Code, Codex); 2 are soft-block
(Cursor, opencode).** The false-"done" promise is real on the first three; on the last
two it degrades to *detect-and-relaunch* (the false claim surfaces briefly, then plumb
re-injects a correction turn). Corrects an earlier assumption that codex was the weak
case — it is not.

### Two adapter archetypes (the whole per-harness surface)
- **Archetype A — hard-block** (goose, Claude Code, Codex): bundle a plugin that wires
  `Stop → plumb verify` (block on contradiction) + `user-message → plumb ratchet`. Same
  shape; only the config format differs (`hooks.json` / `settings.json` / `hooks.toml`)
  and the trust/managed-hook detail (Codex).
- **Archetype B — soft-block / auto-reprompt** (Cursor, opencode): observe turn-end
  (`session.idle` / `stop`) → `plumb verify` → on fail, re-inject a correction turn
  (`client.session.prompt` / `followup_message`). The verifier CLI is identical; only
  delivery differs (re-prompt instead of veto). Set `failClosed` on Cursor.

### Beachhead
**Claude Code** (largest base, single-plugin bundle = cleanest install) and **goose**
(open, warm channel via #9708, source-verified) are the primary targets; **Codex** a
strong third. Cursor/opencode ship as the degraded auto-reprompt mode — honestly
labeled, still valuable, not the launch claim.

### Judge cross-vendor note
On Claude Code a *subagent* judge is same-vendor (self-preference bias). The judge must
be an **external call to a non-Claude model**, not a Claude subagent — the subagent is
fine for the *knight* (design) but not the verdict *judge*.

The "magic moment" auto-trigger: enforcement auto-fires via the Stop hook (no user
action). Auto-*seed* (starting the contract on a build goal) rides the human-message
hook — not a `/command` the user must learn. (CLAUDE.md is advisory context, does NOT
auto-trigger; confirmed.)

## 10. Anti-gaming teeth (mapped to the attacks)

| Attack | Tooth |
|---|---|
| grader rewrite (`conftest.py`) | assertion-authority (verdict from protected files) + blast-radius-pre-write membrane |
| vacuous / reward-hacked solution | `gate-attack` null-solution suite (vacuous-pass, guard-tamper) + tamper-guard-mandatory |
| judge tamper / prompt-injection via code | judge on read-only snapshot; gates read-only to judge |
| judge rubber-stamp / self-preference | adversarial + abstaining + frozen-list judge; **cross-vendor**; no panel |
| false completion | block-on-contradiction; honest-halt (`gate_exhausted` default) |
| spend as a hiding place | budget hard stops |

## 11. Scope fence (building any of this is drift)

- Not a general-purpose harness. Not a UI. Not a company.
- No learned/trained verifiers — deliberate bet on deterministic + auditable +
  human-attributable gates (trained verifiers get gamed too; this is the watch-item to
  revisit, not to build now).
- No prose evaluation in the verdict path, ever.

## 12. Build plan (phased, evidence-gated)

- **P0 — extract the engine.** Lift from ser (harness-independent already): intake +
  gate registry + contract-file + ratchet + suite runner + salvage-first parsing. Wrap
  as a CLI (`plumb open|verify|check`) over `contract.yaml`. Kill the regex-that-
  interprets-claims; make interpretation the thin judge.
- **P1 — goose adapter.** Plugin bundling `hooks/hooks.json` → Stop (`plumb verify`,
  block on contradiction) + UserPromptSubmit (ratchet). One-command install.
- **P2 — MCP wrapper.** Same engine behind `contract_open` / `contract_verify` for
  tool-call hosts + Claude Code subagent judge.
- **P3 — the decisive A/B.** Same harness, same model, **plumb on vs off**, on
  organically-failing tasks. Endpoint: post-done surprises (defects surviving an
  endorsed "done") ↓, false-block ≤5%. This is the only chart that matters.
- **P4 — oracle layer hardening.** The frontier work of §8, gated on P3.

## 13. Success contract (how we know it works)

- Seeded-defect corpus: mechanical + **shared-error** (wrong code + matching wrong
  test) defects — catch/pass per class.
- Honest-completion replay: false-block rate.
- Pressure / impossible-task battery: unlabeled confabulations reaching the user.
- Label-calibration audit: sampled `oracle-verified` vs `coherence-only` tags checked
  by hand/oracle.
- Production truth via the ratchet: every post-done complaint = a revealed false-pass,
  auto-logged. The layer's own use generates its eval data.
- Kill conditions pre-registered per phase; false-pass ≫ false-block >
  missed-but-honestly-labeled.

## 14. Review outcomes (plan-eng-review 2026-07-07, Fable + codex/gpt-5.5 cross-model)

Two independent reviews (this session + a codex outside-voice pass) converged on the
same top risks. Decisions taken:

- **[R1] Enforcement is TIERED, and the claim must be too.** Ship a harness capability
  matrix: `hard-block` (goose Stop) / `soft-block` (opencode veto) / `advisory` /
  `unsupported` (codex today). "The agent cannot say done" is promised ONLY for
  hard-block adapters; others get an explicit degraded mode + a weaker user-facing
  claim. Fixes the #1 risk (over-claimed uniformity) both models named.
- **[R2] Grader integrity = pristine-git + hostile-build sandbox.** Gates commit at
  seed; verify runs them from their committed version (`git checkout <commit> -- <gate
  paths>`), against working-tree code-under-test — tamper is inert AND detected (a diff
  on a gate path is a gaming signal). NOT sufficient alone: gate execution is treated as
  hostile — external trusted `plumb` binary, clean env, fixed PATH, command + writable-
  dir allowlists — because the executor can stage the world (`package.json`, fixtures,
  PATH) it can't edit directly.
- **[R3] Ship-gate trigger uses explicit lifecycle states, not inferred prose.**
  Contract state ∈ {`working`, `ready_for_review`, `done`, `ship`}. Expensive gates key
  off state transitions + strong proxies (final turn after edits, no pending tool calls,
  attempted commit/push), never prose alone. `plumb check --full` is a REQUIRED
  pre-push/CI gate, not merely a backstop.
- **[R4] Split the contract API:** `contract_seed` / `contract_ratchet` /
  `contract_amend|retire`. Adapters may auto-SUGGEST the op; the op is always recorded
  explicitly; retirements/contradictions/requirement-changes need confirmation or a high
  confidence threshold. Reverses the earlier "one auto-detecting tool" call — silent
  auto-detect can weaken the contract (monotonicity violation).
- **[R5] Symptoms are a data-loss-prevention problem, not a principle.** Per-gate-type
  symptom schemas with redaction rules + max granularity; adversarial tests where the
  executor tries to infer hidden gates from symptoms; gates that can't emit a useful
  symptom without leaking the test are marked `coarse-failure-only` / `human-visible-only`.
- **[R6] Contract governance against rot.** Each gate carries scope, branch/product
  version, rationale, last-seen-failure, cost tier, flake rate. Ratchets are append-only
  in AUDIT HISTORY, not necessarily always-active in enforcement; a retirement workflow
  exists. Prevents stale/contradictory gates blocking forever.
- **[R7] Sequencing risk accepted, watched.** The oracle layer (the true differentiator
  vs the LOOPS.md commodity) is P4/last; P0-P3 risk shipping "LOOPS.md as a plugin."
  Mitigation: pull a minimal oracle case (the anchor pattern) into P0 so the MVP is
  differentiated, not just enforced.

## GSTACK REVIEW REPORT

| Run | Reviewer | Status | Findings |
|---|---|---|---|
| 1 | Fable (in-session) | complete | 5 ranked (P1×2, P2×2, P3-bundle) + Step-0 scope clean |
| 2 | codex / gpt-5.5 (outside voice) | complete | 7 ranked; single-biggest-risk = enforcement portability |

Cross-model convergence on: enforcement tiering (both #1), grader integrity, ship-gate
trigger, contract-open fragility. Codex-unique adds absorbed: symptoms-leak-solutions
(R5), contract-rot governance (R6), environment-sandbox strengthening of R2.

VERDICT: **design sound, claim over-scoped.** The architecture is right; the promise
("can't say done") must be scoped to hard-block harnesses, and four boundaries the doc
asserted (grader integrity, ship trigger, symptom leakage, contract governance) need to
be *designed*, not stated. All folded into §14 as P0/P1 requirements. Proceed to build
with R1-R6 as gating requirements; R7 as a watch-item.

**R4 RATIFIED (owner, 2026-07-07):** contract API split into seed / ratchet /
amend-retire (§4 updated). amend is the only weakening path, human-confirmed.

NO UNRESOLVED DECISIONS
