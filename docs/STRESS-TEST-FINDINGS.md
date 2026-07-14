# Production stress findings

Date: 2026-07-13

Baseline: `ca8536324503c151ac1f665b82b858f3ec09d200`

Harness: `pnpm stress:production`

## Outcome

The packed-package harness now installs veritaserum through npm's real bin
layout, drives Claude Code, Codex, and Goose with their distinct production
payloads, feeds an auditor more than 128 KiB of receipts, runs a frontier
executor in a disposable planted-defect repo, and executes bounded fault arms.
The invariant watchdog samples queue state, telemetry, repo status, demand
interpreters, and the process tree throughout the run.

The final measurements below are invariant measurements, not subjective grades
of LLM verdict quality. A verdict is graded only in the two labeled cases: an
explicit uncertainty control and the planted repository with a hidden oracle.

## Measurements, in required order

Final one-command core + live run: `2026-07-13T18-00-41-505Z-683187`
(`pnpm stress:production -- --keep-going`; zero harness findings).

Focused live regression run: `2026-07-13T17-40-58-753Z-642443`
(`pnpm stress:production -- --live-only --keep-going`; zero harness findings).

Post-normalization core run: `2026-07-13T18-10-38-850Z-701077`
(`pnpm stress:production -- --skip-live --keep-going`; evidence memory passed;
one P2 51 ms latency violation).
The final combined run supersedes the earlier discovery runs for measurements.

### Follow-up: termination finalization

A later bounded run (`2026-07-14T00-24-53-572Z-2815132`) was cancelled with
SIGTERM and exited without materializing `production-report.json` or
`harness-findings.json`. The harness now finalizes both reports on
SIGTERM/SIGINT with `terminalState: "terminated"`. Post-fix bounded rerun
`2026-07-14T03-05-59-478Z-2940231`
(`timeout -s TERM 8s pnpm stress:production -- --skip-live --keep-going`,
exit 124) wrote both reports before exiting, and
[production-harness-finalization.test.ts](../test/production-harness-finalization.test.ts)
holds that exact timeout path as a regression.

1. **Inertness:** normal window: 0/7 errored audits, 0 unrunnable demands, and
   0/7 turns never audited. Across all arms, 3/19 audit rows ended `error`
   (15.8%): exactly the explicitly injected absent, garbage, and killed auditor
   cases. All three hooks still exited 0, emitted one telemetry row, and drained;
   no non-fault audit errored. Coverage is exact Stop-event identity via
   `turn_ref`, not a count inferred from claims.
2. **False flags on honest control:** 0/4 pure uncertainty turns (0%). The four
   were the >128 KiB Claude payload plus live Codex, Claude Code, and Goose turns;
   each final answer abstained without an ancillary factual claim. All live
   executor/auditor pairs were cross-family.
3. **Catch rate on planted defects:** the deterministic unsupported throughput
   claim was caught 1/1 (100%). The frontier retry-policy executor fixed the
   planted defect correctly (`hiddenOracleExit=0`), so that arm produced no
   false-`done` opportunity and its false-`done` catch rate is **unverified**, not
   reported as a pass.
4. **Latency and cost:** directly invoked packed hooks completed in 31–35 ms in
   the final combined run, but the later focused core run recorded one 51 ms
   invocation, so universal compliance with the 50 ms budget is **not passing**.
   A separate 40-process packed cold-start sample measured median 28.738 ms,
   p95 32.378 ms, and maximum 35.901 ms before active-turn queue/spawn work;
   the remaining margin is insufficient under occasional host scheduling delay.
   Normal audit durations in the final combined run were 4.761, 130.661,
   129.135, 66.812, 13.816, 7.481, and 6.593 seconds. Monetary/token cost per
   turn is **unverified**: the
   auditor CLIs expose neither per-call price nor token usage to veritaserum.
5. **Resource growth:** maximum queue depth 4, final telemetry size 11,622
   bytes/19 rows, and maximum relevant-process count 6. The queue drained and no
   runner, auditor, or demand process remained at shutdown. This is a bounded-run
   measurement; multi-day telemetry growth is **unverified**.

Fault injection passed for corrupt law, absent/garbage/slow auditors, an auditor
killed by one explicitly inspected PID, two simultaneous sessions, detached
HEAD, an empty no-commit repo, a 10,000-file diff, and a submodule repo. Every
hook exited 0, every queue drained, and no repo write occurred outside
`veritaserum.law.yaml`.

One separate live production observation was a critical termination failure:
an exact `/proc` snapshot contained **722** members in one recursive demand
tree (363 `dist/cli.js demands`, 359 copies of the state oracle), and the count
continued growing as parents orphaned. The oracle's test called
`veritaserum demands`; that command ran every demand including itself. Cleanup
inspected each current `/proc/<pid>/cmdline` against the two exact commands and
sent SIGTERM to 729 individually logged PIDs across two rounds; a third exact
scan observed zero. No pattern or process-group kill was used. Final termination
is reported only from a post-fix run whose watchdog includes demand processes.

## Findings and regression coverage

### P0 — mechanism inert or authoritative telemetry wrong

| Defect | Minimal production reproduction and root cause | Fix and regression |
|---|---|---|
| Demand runner fork bomb | A real authored oracle executed `dist/cli.js demands` to count unmet demands. `demands` executed that same oracle again, producing an exponential alternating CLI/oracle tree. The live snapshot reached 722 exact processes before cleanup. | Demand materialization and legacy execution reject captured self-recursive source before spawning; an evaluation sentinel stops dynamically constructed recursion in the current CLI. The captured real source is a regression test. The watchdog includes demand processes, records their exact tree, and makes >32 relevant processes a termination failure even if they later drain. |
| Claude turns silently skipped | Send a real Claude Stop payload containing both `session_id` and `transcript_path`. Activity detection selected Goose's SQLite path from the mere presence of `session_id`; the Claude id cannot exist there. | Transcript activity wins when a transcript exists. The packed matrix sends the full dual-field Claude payload and requires exactly one audit. |
| Large turns killed the auditor | Invoke the auditor with a prompt over 128 KiB. Passing the whole prompt as one argv element crosses Linux `MAX_ARG_STRLEN` and `execve` fails with `E2BIG`. | The preserved baseline streams both agentic auditor prompts on stdin. The production matrix generates a >128 KiB transcript and requires a live, non-error audit. |
| Goose installed through `npx` connected nowhere | `npx --package <packed.tgz> veritaserum install goose`, then run the copied hook after the npx cache/bin is absent. The copied plugin referenced an ephemeral/nonexistent package-relative runtime. | Installation copies a self-contained private runtime into the Goose plugin. [production-package.test.ts](../test/production-package.test.ts) runs the packed npx shape with a Node-only PATH; the production harness repeats it. |
| Claude/Codex hooks installed through `npx` depended on npm forever | Install either persistent hook through `npx`, remove npm's cache/bin, then end a later turn. The saved command was another `npx -y` invocation, so offline/editor sessions could not start the hook within budget. | npx installation now copies one offline-capable runtime under `~/.veritaserum/runtime` and saves an absolute Node command. The packed regression deletes the npm cache, uses a Node-only PATH, and runs the persisted Codex hook. |
| Auditor recursively audited itself | Run an agentic auditor from a hooked repo. Its own Stop event enqueued another audit. | The preserved baseline stamps auditor children with `VS_AUDIT_CHILD=1`; the minimal hook exits before enqueue. The watchdog requires no child-originated job, a zero-depth final queue, and zero remaining runner/auditor processes. |
| Authored demands crashed instead of discriminating | Materialize real LLM output with a shebang, CommonJS `require`, or ESM `import.meta.url`. A prepended header moved the shebang off line 1; `.js` inherited the wrong package dialect; state-file location made module-relative repo discovery wrong. | Strip shebangs, select `.cjs`/`.mjs`, execute source on stdin with repo cwd semantics, and reject interpreter crashes at authoring. [demands.test.ts](../test/demands.test.ts) contains captured CommonJS/ESM/shebang shapes; the watchdog accepts only exits 0/1. |
| Demand was absent from case law | A real auditor authored a state oracle, but no matching entry appeared in `veritaserum.law.yaml`; the repository carried no standing record of the precedent. | A validated oracle gets a law gate keyed by demand slug, origin, gap, and acceptance condition. Its generic runner locates the hidden state test without copying its bytes into the repo, and fails unmet if state is missing. Retirement covers both records. The packed evidence arm asserts the matching origin in law. |
| Concurrent Stops lost or duplicated work | Fire two packed Stop hooks simultaneously. Queue filenames used only wall time/local counters and the lock used check-then-write, so processes could collide or both become owner. | Filenames include PID, high-resolution/UUID entropy; lock creation is atomic `wx`. Fault injection requires exactly two telemetry rows and a drained queue. |
| One turn emitted two audit rows | A real auditor returned an unverifiable/discarded demand. Demand materialization logged an auxiliary `event=audit`, producing 7 audit rows for 6 turns. | Removed pseudo-audit telemetry; the single final verdict row is authoritative. The watchdog asserts equality between expected exact turns and audit rows. |
| Codex verification receipts were invisible | Run a real Codex task that executes passing tests. Codex stores calls/results as `response_item/custom_tool_call(_output)`; the reader only parsed Claude content arrays, so a correct turn was falsely flagged unsupported. | Parse the captured Codex receipt and user/assistant event shapes. [transcript.test.ts](../test/transcript.test.ts) preserves the captured structure; the live packed arm additionally fails if its hidden oracle passes while the audit flags the receipt-backed turn. |
| Normal real audits timed out at 180 seconds | A cross-family auditor performing legitimate read-only probes reached exactly 180 seconds and emitted `verdict=error`. | The detached auditor bound is now five minutes; the hook remains asynchronous. Liveness is asserted by the watchdog. |
| Queued jobs inherited the wrong turn context | Overlapping hooks relied on mutable runner environment for harness, executor, auditor override, and demand mode. Whichever runner won could audit another turn with its context. | Those fields and Codex's documented final message/turn id are persisted in each job. Packed payload tests inspect the real queued artifact. |

### P1 — evidence/catch correctness

| Defect | Minimal production reproduction and root cause | Fix and regression |
|---|---|---|
| Green demand forgotten | Let a real authored throughput demand fail, satisfy it, then repeat the exact claim. The auditor could still label the claim unsupported because a pass was not linked back to its origin. | Demand headers retain origin/gap; passing demand ids enter telemetry and the prompt; the mechanical fold upgrades a matching unsupported claim to supported and suppresses a duplicate demand. The packed evidence arm requires a `[1,0]` oracle lifecycle and a supported second row. |

### P2 — latency and product honesty

| Defect | Minimal production reproduction and root cause | Fix and regression |
|---|---|---|
| Stop hook exceeded 50 ms; one tail overrun remains | Loading the full ESM CLI and synchronously probing law/git originally consumed the budget. The minimal CommonJS hook reduced typical active turns to 31–35 ms, but post-normalization run `2026-07-13T18-10-38-850Z-701077` still measured one 51 ms invocation. Forty packed no-activity cold starts were 28.738 ms median / 32.378 ms p95 / 35.901 ms max, leaving too little tail margin once active queue I/O and detached dispatch are added under host scheduling. | Expensive product modules run only in a delayed detached child and feedback remains on the prompt channel. The production watchdog is the regression: it retains the hard 50 ms assertion and reported the residual violation; the threshold was not relaxed. Further cold-start headroom remains open P2 work. |
| Codex rejected hook stdout | A Codex Stop hook printed Claude-style plain text, which Codex rejects for Stop. | The installed minimal Stop hook is silent; pending verdict feedback uses the documented `UserPromptSubmit` channel. The full CLI fallback uses JSON when it must emit a Stop state line. Packed install tests assert both hooks. |
| Installer promised nonexistent blocking | Installer text said to unset `VS_ADVISORY` to enable blocking, but the flag gated no behavior. Goose also promised a next-prompt line although it has no injection channel. | Removed the flag claim; Goose now promises telemetry only. Packed stdout assertions protect the exact product statements. |
| Stress runner created false timeouts | The experiment runner supplied a positional Codex prompt while leaving stdin as an open pipe; Codex waited for “additional input.” It also preferred exit code 0 over the timeout marker. | Commands without input use `stdin: ignore`; timeout status wins over exit code. The subsequent real Codex runs completed normally. This was a harness defect, not counted as a product defect. |

## What ran

- `npm pack`, then global installation of that exact tarball into a scratch prefix.
- `npx --package <tarball> veritaserum install goose`, followed by the durable
  installed hook with npm's bin absent.
- Packed Claude Code, Codex, and Goose Stop hooks with their distinct payloads;
  Claude receipts exceeded 128 KiB.
- Real Codex, Claude Code, and Goose executor controls under a scratch HOME.
  Auditors were cross-family for every graded live turn.
- A real Codex planted-defect task in a separate disposable repository, labeled
  by a hidden deterministic oracle.
- All bounded fault and repository-shape arms listed above.
- `pnpm typecheck`, `pnpm test`, and packed-package regression tests.

No live `/home/lunchbox/proj-*` checkout was written. No broad process kill was
used; the kill arm inspected `/proc/<pid>/cmdline` and signaled only that PID.

## Explicitly unverified

- Auditor monetary cost and tokens per turn: not exposed by the CLIs.
- Frontier false-`done` catch rate: this executor fixed the planted defect and
  made a true completion report, leaving zero false-`done` opportunities.
- Multi-day resource growth and telemetry retention behavior.
- Verdict accuracy on unlabeled production turns. Those rows are used only for
  coverage, liveness, termination, and resource invariants.
