# Blocking (captain override of R5)

The product said, in so many words: nothing blocks. Warn-primary. Blocking is
earned per standing-law entry, on evidence, and promoted by a human. It is
never a flag you flip.

**That was an invariant, not a missing feature.** The captain overrode it on
purpose once Jev (typesafe.ai System One) made a structured verdict cheap
enough (~350ms) that a same-turn block is affordable. A block exists so the
agent can revise. It is not a deadlock.

## Install path

```
pnpm install && pnpm build && npm link
veritaserum install claude-code     # also: goose, codex
```

That wires the existing Stop hook. Blocking stays **off**.

Jev becomes the auditor when `TYPESAFE_API_KEY` is in the environment (the
same key firstmate already uses). The key is sent as an Authorization header
in process memory. It must never appear on argv, in a log, in a transcript, or
in a test fixture.

## Off switch (no code edit)

| | |
|---|---|
| **On** | `VS_BLOCK=1` (also `true` / `yes` / `on`) in the session environment |
| **Off** | unset, or `VS_BLOCK=0` (`false` / `off` / `no`) |

`VS_BLOCK=0` also disables the goose blocking plugin
(`adapters/goose/hooks/hooks-block.json`).

Cap: **2 blocks per session** (`VS_BLOCK_CAP` overrides). The captain left
once-or-twice to this change: two, because the calibration event was two turns
of the same shape in one session (the clean-tree claim, then the still-wrong PR
description). After two, the turn finishes.

Fail-open is unchanged. An outage, a malformed reply, a missing key, a timeout,
or `auditor_absent` never blocks. Only a positive, confident finding does.

Sensitivity is **low**. Honest uncertainty, judgment, fiction, reasoned
inference, and predictions are not confabulation. R9 unaccountable work stays
warn-only. The two named classes are the target: a confident claim about state
that the session's own evidence contradicts or fails to support, and a
confidently asserted diagnosis with no evidence chain.

## Detection count

```
veritaserum telemetry
```

The first summary line after the firing count is **confabulations detected**.
That is the metric. Do not substitute turns-until-a-human-is-needed.

## Cost per turn (Jev)

Measured by firstmate at roughly **350ms** for a structured Choice verdict.
A live call from this checkout against the anchor fixture (2026-09-18):

- latency: **379ms**
- model: `jev-1.13.0` (`jev-latest`)
- tokens: 883 input / 52 output
- worst case: **5s timeout**, then fail-open (no block)

Veritaserum does not price the call; the provider does. Firstmate's earlier
dispatch-resolve runs were the same order of magnitude.

The warn-only Stop hook is unchanged: ~0ms when nothing to audit, <50ms to
enqueue. Blocking is the path that waits on Jev.

## What was verified here, and what was not

**Verified in this checkout (hermetic tests, no live captain sessions):**

- Claude Code / Codex Stop: JSON `{decision:"block", reason}` on stdout
- Goose Stop: exit 2 + stderr (existing plugin path, shared cap and fail-open)
- Fail-open on a Jev outage (no TYPESAFE_API_KEY, or Jev unreachable)
- Session cap of 2
- Anchor fixture `eval/fixtures/09-preexisting-clean-tree.json` is caught by
  the pipeline
- Honest uncertainty, judgment, fiction, and reasoned inference fixtures are
  not flagged
- `TYPESAFE_API_KEY` is a header, never the request body

**Not verified here (the captain runs this himself):**

- Live Claude Code, Codex, or Goose sessions with blocking on
- Whether Jev's live Choice on the captain's own traces matches his taste
- Monetary cost on a real typesafe invoice

Do not run that evaluation in this task.
