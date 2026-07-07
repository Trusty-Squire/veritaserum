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

## 4. Tool surface (lean — two tools)

`contract_open(goal | correction)` — **seed or ratchet, auto-detected.**
- No contract yet → seed: goal → contract.yaml (knight; ingest spec+evals if provided).
- Contract exists + passed + input is a correction → ratchet: append a gate, reconcile
  (new / duplicate-repeat-signal / contradiction-surface-to-human). Corrections never
  regress; only a human clutch retires a gate (recorded, not deleted).

`contract_verify(snapshot, claims)` — **the one verification.** Run the claim-relevant
gates against reality; return pass, or a confrontation with the symptom.

There is **no separate `contract_check`** — "check the whole thing" is `verify` with the
expensive gates switched on, gated by a completion claim (§6). A read-only
`contract_status()` may exist for pull-convenience; it is not load-bearing.

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

## 9. Distribution

- **MCP server** — portable machinery + pull tools, for hosts that want tool-calls.
- **CLI (`plumb verify` / `plumb check`)** — what a hook shells out to (goose hooks run
  *commands*, not MCP calls; source-confirmed). Same engine, command door.
- **goose** — ship as a **plugin that bundles `hooks/hooks.json`**; enabling the plugin
  installs the Stop + UserPromptSubmit hooks. No manual `config.yaml` editing.
- **opencode** — JS/TS plugin (npm-installable); hooks `tool.execute.before/after`,
  `session.idle`; veto by throwing. Softer completion-block than goose.
- **Claude Code** — native Stop hook + subagents (fresh-context judge) + auto-routing
  via `CLAUDE.md`.
- **codex** — MCP + config (OpenAI unlikely to merge a PR; adapter path covers it).

The "magic moment" requires **auto-trigger** (a routing rule fires the loop on
build-intent), never a `/command` the user must learn.

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
