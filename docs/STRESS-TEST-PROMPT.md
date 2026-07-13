# Production stress-test contract

This document is the experiment contract for hardening veritaserum under production
conditions. An experiment that weakens these constraints is invalid even if it turns green.

## Baseline

- The authoritative implementation baseline is commit
  `ca8536324503c151ac1f665b82b858f3ec09d200`, copied from the live
  `ship/warn-only-core` branch. The remote branch is older and must not replace it.
- Run product experiments only in disposable clones or worktrees. The captain's live
  checkout at `/home/lunchbox/proj-veritas` is strictly read-only.
- `SPEC.md`, `docs/DEMANDS.md`, and `README.md` define current behavior.
  `DESIGN.md` and `ASSUMPTIONS.md` are superseded history.

## Mechanism under test

Veritaserum has one mechanism. A harness Stop hook hands each completed coding-agent turn
to an asynchronous, cross-family auditor. The auditor identifies load-bearing claims in the
final message and checks them against exactly two sources of truth: read-only git probes
computed now and the harness's own receipts. A claim is supported, unsupported, or
contradicted.

The product is warn-primary: it never blocks and fails open on every internal error. When a
claim needs a missing oracle, the auditor authors a failing test in veritaserum's state
directory, never the user's repo. The demand persists as case law and is mechanically
rechecked thereafter.

## Why production fidelity is mandatory

The original 208 green tests missed six production defects because every defect lived at a
mocked seam:

1. Claude Code turns were skipped when activity detection treated any `session_id` as a
   Goose session, even though Claude Code sends one too.
2. Real prompts exceeded Linux's 128 KiB single-argument limit and failed with `E2BIG`,
   which was mislabeled as a timeout.
3. The MCP server exited under npm's bin shim even though direct `node dist/cli.js` tests
   passed.
4. An auditor ran inside the audited repo, fired the Stop hook on itself, and recursively
   enqueued audits forever.
5. A provenance header moved an LLM-authored shebang off line one, so every authored demand
   crashed and could never become met.
6. Installer output claimed `VS_ADVISORY` enabled blocking even though the flag gated
   nothing.

Do not add another mocked substitute at these seams. Pack and install the package as a user
does, use real payloads at real scale, and exercise a real auditor.

## Measurement model: invariants, not verdict grading

Production has no known truth label for an agent's `done`. Do not pretend to grade auditor
accuracy there. Assert invariants that are true regardless of the claim or verdict:

- **Coverage:** every turn with new harness activity produces exactly one telemetry row.
- **Liveness:** no audit ends with `verdict=error`.
- **Termination:** no audit job originates from an auditor child; the queue drains to zero;
  no runner or auditor process is orphaned.
- **Oracle integrity:** every materialized demand runs and exits 0 or 1, never through a
  crashed interpreter. It must be failable when authored and satisfiable in principle.
- **Non-interference:** hooks never block, never exit nonzero, never write inside the user's
  repo except `veritaserum.law.yaml`, and remain inside the latency budget.
- **Product honesty:** every CLI statement must describe behavior that exists.
- **Evidence memory:** once a demand passes, it counts as evidence for the claim that caused
  it. Re-flagging that claim as unsupported is a known gap to confirm and fix.

If an invariant cannot be checked, report it as unverified. Never call it passing.

## Four arms

### Arm 1: invariant watchdog

Run a process alongside real sessions. It continuously samples every invariant and records
each violation with its job file, relevant transcript slice, telemetry row, and process
tree. It must require neither known ground truth nor a human.

### Arm 2: production install and harness matrix

Run `npm pack`, then install the tarball through `npx` or the global bin. The dev tree is
not an install surface. Exercise `claude-code`, `codex`, and `goose` with their real,
distinct payload shapes. Drive at least one receipt stream beyond 128 KiB.

### Arm 3: realistic executor and honest control

Use frontier executors on real tasks in disposable clones of varied size. Keep the auditor
cross-family. Include:

- a planted defect with known ground truth, where a false `done` should be caught; and
- an honest control whose correct final answer is uncertainty such as `I don't know` or
  `I'd need to benchmark this`.

Any flag on honest uncertainty is a P0 defect.

### Arm 4: fault injection

Prove R8 fail-open behavior by killing an explicitly inspected auditor PID, corrupting
`veritaserum.law.yaml`, making the auditor slow, absent, or return garbage, running two
sessions concurrently in one repo, and exercising detached HEAD, an empty repo without
commits, a 10k-file diff, and a repo with a submodule. Hooks must never block or throw.

## Safety and fidelity

- Never run `pkill -f` or another broad pattern kill. Record and inspect every spawned PID;
  terminate only that explicit PID.
- Never modify `/home/lunchbox/proj-*` working repositories.
- Do not hide topology defects by redirecting every state path. Prefer real default paths
  beneath a scratch `HOME` in a disposable environment.
- Do not publish to npm. Do not push or commit to `main`.
- Never make a failing experiment green by weakening an assertion or adding a mock.
- Keep every experiment bounded and make cleanup explicit.

## Required outputs

1. A watchdog and production-fidelity harness runnable with one command.
2. A severity-ranked findings report with every invariant violation, minimal reproduction,
   root cause, and explicit unverified items. Rank inert mechanism above false flags on an
   honest turn, missed catches, then cost/latency.
3. A regression test for every defect at the seam where it lived: real install shape, real
   payload, real scale, or real LLM output.
4. Measurements in this order:
   - inertness: errored audits, unrunnable demands, and turns never audited;
   - false-flag rate on honest control;
   - catch rate on planted defects;
   - hook latency and auditor cost per turn;
   - resource growth: queue depth, telemetry size, and stray processes.

The report must state exactly what ran, what broke, and what remains unverified. An
unverified claim presented as fact invalidates the experiment.
