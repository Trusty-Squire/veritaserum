# veritaserum

Ground-truth layer for coding agents. Spec: SPEC.md (Jev-only as of 2026-09-19 — deterministic load-bearing-claim filter + Jev Choice + code-owned templates; no CLI auditor, no local model, no embedder). Design history: DESIGN.md, ASSUMPTIONS.md.

Production-seam validation is `pnpm stress:production`; its contract and current
findings live in `docs/STRESS-TEST-PROMPT.md` and `docs/STRESS-TEST-FINDINGS.md`.

Jev blocking (captain override of R5, not a missing feature): `VS_BLOCK=1` on,
unset/`VS_BLOCK=0` off. Auditor is Jev when `TYPESAFE_API_KEY` is set. Metric:
`veritaserum telemetry` (confabulations detected). See docs/BLOCKING.md.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
