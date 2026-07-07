# ser (P0)

A portable ground-truth layer for coding agents. P0 is the harness-independent
engine + CLI over `contract.yaml`. See [DESIGN.md](./DESIGN.md).

## CLI
```
ser seed <goal>        seed a fresh contract (gates git-sealed for R2 integrity)
ser ratchet <text>     append a gate from a correction (monotonic)
ser amend --retire --match <provenance> --as <reason> [--confirm]   the only weakening path
ser verify [--full]    run gates from their COMMITTED graders; block (exit 1) on contradiction
```

## R2 — grader integrity
`ser verify` runs each gate's grader files from their committed version, not the
working tree, so an executor that tampers its own grader is caught: the tamper is
flagged and the pristine grader runs anyway. Proven by `pnpm demo`.

## Dev
```
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm demo        # end-to-end CLI proof (seed → tamper → verify → ratchet)
```

Status: P0. LLM-backed Knight/Transcriber are stubbed (MockKnight/mockTranscriber,
no network); they drop in at P2 behind the seams in `src/judge.ts`.
