# ASSUMPTIONS — ser P0

> **⚠️ HISTORICAL — P0 decision record.** These were small calls made during P0. The
> MockKnight / MockTranscriber / real-Knight / contract-ratchet machinery described below
> **has been deleted** (SPEC §4.1): there is one role, the auditor. Kept for the record of
> what was decided and why, not as a description of current behavior.

Small calls made during P0 (per behavior policy: record, proceed). Real forks were
surfaced to the owner, not decided here.

- **MockKnight emits one floor gate** ("build produced its output artifact",
  default `answer.txt`) with a committed grader script, so R2 is exercisable
  end-to-end. The real Knight (P2, LLM) designs oracles from the goal.
- **MockTranscriber makes a complaint a human-checklist gate** carrying the user's
  words — without an LLM it cannot synthesize a command gate. The real transcriber
  (P2) constructs command gates. Checklist gates are appended (monotonic) and are
  audit-only (never executed).
- **R2 pristine mechanism = backup → overwrite-with-committed → run → finally-restore**
  (in place, no world-copy). Source files are untouched; only grader files swap.
  Documented risk: a hard crash between overwrite and restore leaves graders at their
  committed version on disk (recoverable via `git checkout`). A temp-worktree variant
  is a P1 option if the in-place swap proves fragile.
- **gatePaths are literal repo-relative paths** in P0; glob resolution is P1.
- **`--full` runs the same gate set as fast** in P0 — no expensive/semantic gates
  exist yet, so there is nothing to defer. Expensive-gate gating (DESIGN §6) is P1+.
- **Tamper is surfaced, not auto-blocking.** A grader edit is flagged loudly, but the
  verdict comes from the pristine run (blocked = a real gate failed). Editing the
  grader while the build passes is reported but does not itself fail the gate in P0.
- **CLI ratchet commits contract.yaml only.** Checklist gates carry no grader files,
  so `contractCommit` stays valid. A grader-bearing ratchet would reseal — P1.
