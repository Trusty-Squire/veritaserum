---
name: contract-negotiation
description: Propose an optional verification contract (statute) for a goal via the veritaserum MCP tools — when to do it, how the epistemic ladder grades gates, and how sealing/veto works. Use after a design is agreed but before writing code for a goal that has a plausible independent oracle.
---

# Contract negotiation (the optional statute path)

veritaserum's main mechanism is the case-law auditor: it audits your claims after the
turn and appends demands to `veritaserum.law.yaml` when it needed an oracle that didn't
exist. That is reactive and automatic — you don't need to do anything for it.

This skill is the other, OPTIONAL path: proactively negotiating a verification contract
*before* you start coding, when the goal plausibly has a known-answer case, an
independent oracle, or a held-out test. A sealed contract (`contract.yaml`) is unioned
into the same law set the auditor reads — a statute gate and an auditor-demanded gate are
checked identically (mechanically, mercilessly, every turn).

## When to propose

- **Timing:** after the design for a goal is agreed, before you write the implementation.
  Proposing gates first (not after the fact) means the gates test the goal, not your
  finished code.
- **Trigger:** the goal has a plausible objective check — a known-answer case, a solver
  with a textbook equilibrium, a spec with a reference implementation, a property that
  holds regardless of your approach. Don't propose for goals with no independent oracle
  (say so instead — see below).
- Don't propose reflexively for every task. Trivial or exploratory work doesn't need a
  contract; the case-law auditor still covers it after the fact.

## The ladder

Every gate you propose carries a claimed rung, strongest first:

`analytic` (known-answer case, exact expected value) > `oracle` (an independent system
confirms) > `held-out` (a test you cannot see/overfit) > `self-consistency` (the work
agreeing with itself — "tests I wrote pass") > `unverifiable`.

Only the top three rungs (`analytic`, `oracle`, `held-out`) can ever bind. A cross-vendor
grader (the Knight) corrects an inflated rung and rejects self-graded or vacuous gates —
propose honestly; inflating the rung just gets it corrected and costs a round.

## The flow

1. Call `contract_propose` with the goal and your candidate gates (each with a `run`
   command or checklist text, and your claimed rung). Research known-answer cases for the
   domain first — that research IS the point of this step.
2. The grader returns accepted/rejected verdicts + a possible counter-demand (e.g. "this
   domain has a known equilibrium you're missing"). Revise and re-propose if rejected —
   max 3 rounds.
3. When gates are accepted, **ask the human to approve them in plain language.** Do not
   invent or assume approval.
4. Call `contract_seal` with the human's approval sentence **verbatim** — it becomes the
   gates' recorded provenance. Sealing is the veto moment: what you propose here is what
   binds, so only seal what the human actually said yes to.
5. If no oracle exists for this goal after 3 rounds, say so explicitly and seal with zero
   gates — `contract_seal` still records that outcome (unverifiable-but-declared beats
   silent). This is a legitimate, complete outcome, not a failure.

## After sealing

Sealed gates are binding case law from then on, run mechanically on every audited turn —
you cannot loosen or retire them yourself. Weakening a gate is `veritaserum amend
--retire` (human-confirmed) or `veritaserum retire` for auditor-demanded law; both require
an explicit reason and are recorded, never silently dropped. If a gate turns out wrong,
say so and ask the human to retire it — don't work around it.
