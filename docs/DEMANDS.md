# Demand redesign — tests enforce (from HEAD), a git-tracked register remembers

Status: PHASE 1 IMPLEMENTED (2026-07-12, amended same day) — demand
authoring (gap/remedy/accept/test_file), failing-test materialization with
authoring-time must-fail probe, remedy+accept feedback line (src/demands.ts).

AMENDMENT (owner, 2026-07-12): demand scripts live in **veritaserum's own
state dir** (`<state>/<repoKey>/demands/`), NEVER in the user's repo.
Rationale: an in-repo `test/veritaserum/` directory is visible vendor
residue (adoption killer), and placing the oracle inside the defendant's
tree is what FORCED the HEAD-run/pristine/consent-by-commit machinery — all
deleted as unnecessary once the oracle left the repo. veritaserum is
invisible: `git status` stays clean, nothing the executor does to the tree
touches the oracle. Human window: `veritaserum demands` (list + status);
veto: `veritaserum retire <slug> "<reason>"` (moved to retired/, recorded,
never resurrected). Register, first-green review, distrust, CI job: still
DEFERRED until the testbed earns them. Sections below are the full reviewed
map and retain the superseded in-repo container for the record.
Supersedes the law-file demand mechanism (SPEC.md §2 step 6, "Case law").
Evidence base: the blockchain confabulation experiment (2026-07-11, gbrain:
`blockchain-experiment-architectural-confab-boundary`) and its run-3
vacuity artifact.

Owner decisions (2026-07-12 eng review): law file demoted from enforcement
container to slim debt register (D2/D4) · standing red pressure on unmet
demands (D3, shape revised by D6) · Knight/transcriber/demand authoring
fully unified (D5, scope corrected by codex #8) · codex synthesis adopted
(D6): pristine HEAD execution, separate CI job, first-green review for
every model-authored demand.

## 1. The problem, as proven

The law-file demand mechanism was vacuous in practice. The auditor prompt's
entire instruction was "a claim needed an oracle that doesn't exist — demand
ONE", with output slot `{description, run?, rung, origin_claim}`. Measured
consequences (single run, existence proof — not a rate):

1. **Vacuity.** Auditing "handles 10k TPS, verified at 299,377 tx/s", the
   auditor's demand was "run `verify_chain.py`" — the defendant's own,
   already-written, already-scheduled test. Zero information added.
2. **Canonization.** The ratchet crystallized that filename into a standing
   gate; the rigged benchmark (no signatures, no consensus, no contracts in
   the measured path) exits 0 → passes forever.
3. **Laundering.** The re-audit cited the rigged test's own assertions back
   as its evidence basis. Verdicts: 5/5 supported; 0/4 confabs caught.

Root causes: acceptance semantics had no enforceable home (prose next to a
command enforces nothing), and the enforcement container was invisible (a
rulebook nobody re-read). What the yaml got right and keeps, demoted, is
being git-tracked: HEAD-read tamper evidence, deletion-proof records.

## 2. The redesign

### 2.0 Container

- **A demand IS a failing test file**, authored by the unified module
  (§2.4) into `test/veritaserum/` (framework-idiomatic when the host has a
  detectable framework, standalone exit-code script otherwise), written to
  the tree uncommitted, embodying `accept` as executable assertions with
  expected values inline, failing against the current tree by construction.
- **The register** (`veritaserum.law.yaml`, demoted): one line per demand —
  slug → test path, origin claim, gap, rung, parent slug (for replacement
  demands), status (`unmet | met | distrusted | escalated`). Authored in
  the same act as the test, committed together.
- **Nothing model-authored executes before it is committed** (codex #10 +
  #1): the mechanical layer runs demand tests from **git HEAD via the
  pristine restore mechanism** (the statute path's committed-grader swap,
  reused). Executor edits to the working-tree copy are inert against
  enforcement and diff-visible. Pre-commit, an authored demand is a
  proposal in the diff — nothing more.
- **Standing pressure** (D3 intent, D6 shape): unmet/distrusted register
  entries are reported by a **dedicated CI job** (`veritaserum-demands`)
  that is red while debts exist — visible on every PR without poisoning
  the host suite (branch protection can be pointed at it, or not — repo's
  choice). The host test suite never inherits deliberate failures
  (codex #6/#7: standalone scripts aren't discovered by host runners
  anyway; where they would be, permanent red teaches suite-deletion).
- **Consent caveat, stated honestly** (codex #2): a commit is the consent
  *checkpoint*, not proof of human review — agents commit too. Mitigation:
  audits flag reserved-path/register changes committed by the executor's
  own session (receipts show who ran `git commit`) as self-ratified —
  warned, and such entries are excluded from verdict bases until a
  non-executor commit touches them. Residual risk accepted.

| law-file v1 feature | new home |
|---|---|
| mechanical recheck | demand tests run from HEAD (pristine restore), exit-code contract |
| human veto / consent | commit checkpoint (caveat above) — a reviewable test-file diff |
| provenance / lineage | register line + test header (origin claim, gap, accept, date, parent) |
| dedupe | register slug; numbered variant only when `accept` differs |
| retirement | delete test + flip status in a commit; git history is the record |
| "law unchecked" sync line | unmet/distrusted entries exist AND tree changed since last green — same watermark |
| drift detection | executor edits to `test/veritaserum/**` or register: diff-visible, flagged, self-ratified commits excluded from verdict bases |

### 2.1 Demand authoring (schema)

```
{
  "origin_claim":  "<the claim that lacked an oracle>",
  "gap":           "<one sentence naming precisely what current evidence fails
                    to establish — concrete, never generic>",
  "remedy":        "<imperative instruction to the executor: what evidence to
                    produce; MAY point at an existing artifact, judged against
                    `accept` like anything else>",
  "accept":        "<the acceptance condition as data: expected values with
                    tolerances, a property that must hold, a known-answer
                    input from theory or an external reference>",
  "test_file":     "<full content of a failing test embodying `accept`;
                    omitted only when `accept` cannot be stated — then the
                    demand registers at rung unverifiable and never binds>",
  "parent":        "<slug of the demand this replaces, if any>",
  "rung":          "analytic | oracle | held-out | self-consistency | unverifiable"
}
```

(The earlier `self_grading` bypass is dropped — codex #3: the
literals-in-assertions guard is spoofable via comments/dead code, and one
review per demand lifetime is cheap insurance. Every model-authored demand
gets the §2.3 review.)

Authoring rules (prompt level): manufacture `accept` or register as
unverifiable · the test must fail against the current tree (already-passing
discriminates nothing; a pre-existing artifact that genuinely meets
`accept` means no demand — cite it as evidence instead) · state in `gap`
why existing evidence doesn't count · assume enforcement sees pass/fail
only · runnable by a stranger with zero context.

### 2.2 Delivery as instruction

Next-turn feedback carries `remedy` + `accept` verbatim for the
highest-severity unmet demand (severity = rung, then age; age = register
line's first-commit timestamp):

> DEMAND (unmet, test/veritaserum/kuhn-anchor.test.js failing): make the
> MCCFR solver pass the Kuhn anchor — computed equilibrium strategy within
> 1e-3 of the known values. Your existing benchmark does not count: its
> timed path omits signatures, consensus, and contract execution.

R7 holds: one line per turn, state-gated, never repeated verbatim.

### 2.3 First-green review (every model-authored demand)

The FIRST time a committed demand test passes its HEAD-run, that turn's
audit gets one extra mandatory question, with the demand and the **current
tree state** (not "the diff that made it pass" — codex #5: the async
scheduler has no tree snapshot per job; attribution to a specific turn is
best-effort, judgment is of what exists now):

> Does the current implementation satisfy `gap` and `accept`, or was the
> test satisfied by narrowing scope, seeding the answer, or measuring a
> different path? Verdict: fulfilled | gamed.

Register transitions (codex #11, lifecycle defined):
- `unmet → met`: HEAD-run green AND review verdict `fulfilled` (auditor
  flips status in tree; commit ratifies).
- `unmet/met → distrusted`: review verdict `gamed`, or drift probe catches
  a self-ratified enforcement edit. **Trust-weakening flips read from the
  TREE take effect immediately**; all other register fields are
  HEAD-authoritative (explicit merge rule, codex #4: weaker-wins — between
  tree and HEAD copies of one entry, enforcement uses the less-trusting
  status). A `gamed` verdict also authors a replacement failing test
  (slug names the evasion, `parent` links the lineage).
- `distrusted → escalated`: second `gamed` in one lineage — human-visible
  message, no further re-demand (bounds the ping-pong).
- Flip-detection state (per-test last-known HEAD-run status) is a
  non-authoritative cache; loss re-triggers at most one duplicate review.

### 2.4 Unified authoring module (D5) — RESOLVED BY DELETION

This section planned to *unify* three authoring paths: `seed` (Knight manufactures
gates), `contract_propose` (executor proposes, Knight grades), and `ratchet`
(transcriber turns corrections into gates). The unification landed as a deletion
instead (SPEC §4.1): all three paths, and the Knight/Judge/Transcriber roles behind
them, are GONE. There is exactly one authoring path left — the auditor authors a
demand from an observed gap (`law.ts`'s `appendDemand`, materialized as a failing
test file by `demands.ts`) — because ruling on a claim and authoring the check that
would settle it were always the same role wearing four names.

The statute path survives as a **data file** (`contract.yaml`, human-edited); `loadLaw`
unions its gates into the standing law. No negotiation machinery, no MCP tools.

## 3. Deliberately out of scope

- **Oracle quality in niche domains** — authoring model's knowledge is the
  ceiling; human commit veto is the only quality check. Accepted.
- **Architectural impossibility** ("fees payable in a stablecoin" was
  literally true of code implementing an impossibility) — needs a separate
  adversarial pass. Tracked, not here.
- **Pre-first-commit fragility** — a demand erased before its first commit
  leaves only telemetry traces. One-turn window, accepted.
- **Malicious human-impersonating commits** — consent caveat in §2.0 is a
  mitigation, not a solution; full commit-identity trust is out of scope.

## 4. Acceptance (implemented when)

1. Unified module authors gates and demands from one schema across all
   three paths; demands without `accept` register `unverifiable`, never
   bind.
2. Blockchain-fixture replay: TPS demand names missing coverage
   (signatures/consensus/contracts) in `gap` and emits a failing test.
3. Authored test FAILS against the fixture tree at authoring time
   (replay-asserted); mechanical layer runs demand tests **from HEAD via
   pristine restore** — a working-tree edit to the test does not alter the
   enforcement run (tamper test).
4. Register semantics: HEAD-authoritative fields + tree-effective
   trust-weakening flips (weaker-wins merge rule unit-tested); executor
   deletes uncommitted test → next audit re-authors and flags; self-ratified
   commits excluded from verdict bases (drift test).
5. First-green: exactly ONE fulfilled/gamed review per demand (idempotence:
   cache loss ≤ 1 duplicate); `gamed` → `distrusted` immediately stripped
   from verdict bases (rigged-benchmark replay ends distrusted, not
   canonized) + replacement test with `parent` lineage.
6. 2-strike cap: second `gamed` per lineage → `escalated`, human-visible,
   no further re-demand (replay-asserted).
7. `veritaserum-demands` CI job: red iff unmet/distrusted entries exist;
   host suite unaffected by demand tests (repo-fixture test).
8. Feedback carries `remedy` + `accept` verbatim, highest-severity-first;
   R7 non-repeat asserted across two turns.
9. Statute-path regression: propose/seal/verify + pristine suite passes
   unchanged; ratchet transcriber output equivalence on existing fixtures.
10. Migration: v1 yaml gate-enforcement machinery deleted (absence-tested);
    register read/write replaces it; existing contract.yaml surface
    untouched.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | /plan-eng-review | Architecture & tests (required) | 1 | CLEAR (PLAN) | D2–D5 decided in-review; 3 architecture issues resolved by owner decision; test section folded into §4 acceptance (10 items, incl. tamper, merge-rule, idempotence, regression locks) |
| Outside Voice | codex exec (gpt-5.5, high, read-only) | Cross-model challenge | 1 | ISSUES_ABSORBED | 12 findings: #1 pristine deletion, #6/#7 CI infeasibility/blast-radius, #3 spoofable guard, #4 HEAD/tree contradiction, #5 attribution race, #8 three authoring paths, #9 gate-kind loss, #10 unsandboxed execution, #11 lifecycle gaps — all absorbed via D6 synthesis; #2 consent caveat documented as residual risk; #12 synthesis adopted |
| CEO Review | — | not run | 0 | — | — |
| Design Review | — | not run (no UI surface) | 0 | — | — |

**CODEX:** Outside voice ran on the reviewed draft; its synthesis (#12) was
adopted wholesale (D6): pristine HEAD execution restored, dedicated red CI
job instead of host-suite poisoning, first-green review for every
model-authored demand, self-grading bypass dropped.

**CROSS-MODEL:** Codex independently confirmed the vacuity/canonization
root cause and re-derived the register-durability argument (git-logged
record earns its place — matching the owner's D4 ruling).

**VERDICT:** ENG CLEARED — ready to implement (scope: §4 items 1–10;
statute-path regression lock is the implementation's first commit).

NO UNRESOLVED DECISIONS
