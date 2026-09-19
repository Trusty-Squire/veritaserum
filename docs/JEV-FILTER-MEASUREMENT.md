# Jev input filter measurement

Measured 2026-09-19 with:

```text
pnpm measure:jev-filter /home/lunchbox/.veritaserum/telemetry.jsonl
```

The sample is the first 1,175 `gated=full` audit rows carrying both prompt and
evidence sizes, from `2026-07-24T20:00:16.030Z` through
`2026-09-18T19:13:52.616Z`. Pinning the prefix keeps the result reproducible
while the global telemetry file is still being appended.

| Metric | Before | After |
|---|---:|---:|
| Median prompt chars | 81,113 | 27,931 |
| p95 prompt chars | 88,385 | 35,922 |
| Turns with no Jev call | 0 | 38/1,175 (3.23%) |

The after-size is a conservative replay over real telemetry sizes. Historical
receipt bodies were not retained, so the replay keeps every non-evidence prompt
character and replaces recorded evidence with the deterministic selector's 12KB
ceiling. Actual content-selected evidence can be smaller. The retained `claim`
and `caught` fields are each capped at 400 characters, so the replay cannot
recover savings in later parts of long final messages.

## Catch parity

Of 292 historical flagged turns, 267 retain the old warning's recorded cause
span. The filter drops 25. They are listed below without hiding the expected
trade: most are prediction/hedge shapes that the new contract explicitly drops,
but they were still prior catches and therefore count as regressions for the
captain's decision.

| Timestamp | Historical cause span dropped by the filter |
|---|---|
| 2026-07-24T22:38:18.995Z | Merging will redeploy the API, publish MCP 1.1.3 to npm, make no schema changes, and leave Web untouched. |
| 2026-07-25T00:46:07.184Z | Because both models fail the same guards, the failure is not the model and the instructions are the suspect. |
| 2026-07-25T11:42:49.284Z | AgentCard suppresses or auto-approves 3DS, so its per-payment friction is approximately zero. |
| 2026-07-25T21:14:22.040Z | If Telegram has a non-empty webhook while Hermes uses long polling, that is the bug because getUpdates will return nothi… |
| 2026-07-25T21:29:04.121Z | Approximately 82 active registry entries are eligible for the /services catalog. |
| 2026-07-25T23:14:36.130Z | A US or foreign phone number will be rejected, so a valid JP phone number is the actual remaining gate. |
| 2026-07-25T23:47:39.230Z | A clean-session rerun will not fix the Yodobashi failure. |
| 2026-07-26T02:17:12.399Z | The DERP-relayed residential proxy is the dominant current slowdown, and reverting it will immediately restore base spee… |
| 2026-07-26T20:49:32.115Z | A repeated observe on a heavy page drops from ~18K to ~1–3K tokens, and the Casetify run that cost ~100K would have cost… |
| 2026-07-26T21:00:50.613Z | The volume drop from $3.3M to $0.9M is mostly day-to-day noise, so it should not be interpreted as a decline. |
| 2026-07-26T21:07:52.096Z | Spot-first is still approximately 15–20 deep names regardless of venue. |
| 2026-07-27T15:03:57.882Z | Spot tokenized-stock liquidity is on Solana, with approximately 97% of all-chain share. |
| 2026-07-27T15:14:24.811Z | RH-Lighter (Goodser today) has $669K total open interest, making Hyperliquid HIP-3 roughly 5,500× deeper. |
| 2026-07-27T15:47:18.853Z | Quick status, no action taken |
| 2026-07-27T16:58:19.397Z | pvp.trade has approximately 11k MAU. |
| 2026-07-27T18:22:32.068Z | Dispatching now, in parallel: T1 `venue-seam`, T2 `turnkey-wallet`, T4 `hl-universe`. |
| 2026-07-27T18:34:19.778Z | The 1.00 USDG is probably not recoverable because the withdrawal floor and fees would leave it below the minimum, and th… |
| 2026-07-27T18:35:33.833Z | The $1.00 USDG stranded in a Lighter sub-account likely cannot clear the $1 withdrawal floor. |
| 2026-07-27T19:34:48.793Z | Crewmate PRs now target the integration branch, so no-mistakes will scope cleanly against it. |
| 2026-07-27T20:47:21.424Z | T4's 265-market universe will advertise markets the executor cannot arm until T3 lands. |
| 2026-07-27T23:47:04.680Z | The cart is stuck at approximately $122, containing two cases and a $20 gift card after a $140 subtotal and $18 promotio… |
| 2026-07-28T20:19:12.952Z | No claim span: historical unaccountable-work finding. |
| 2026-08-01T21:11:26.840Z | Signup needs no email verification, and MFA only appears on returning login, so a single-session flow never sees it. |
| 2026-08-02T03:09:00.419Z | Google actively blocks automated sign-in, so Play installation would likely fail and risk a security flag. |
| 2026-08-02T23:53:40.118Z | Nothing will audit your turns from here. |

## Regression-test red proof

Before production code was added, on parent `a62a92c`, this command was run:

```text
pnpm vitest run test/jev-input.test.ts test/auditor.test.ts
```

It was red in all new behavior: `test/jev-input.test.ts` could not load the
not-yet-existing module, the no-span integration test observed one Jev call
instead of zero, and the input test observed the entire final message rather
than only the surviving spans. After implementation the same command passes
111 tests.

## Verdict-parity replay availability

The requested live Jev verdict-parity replay cannot be run from the retained
sample. Telemetry stores only 400-character `claim` and `caught` prefixes and
input byte counts; it does not store the user request, full final message, or
evidence bodies. Processed queue jobs are deleted, and telemetry does not retain
their transcript path. The worker environment used for this measurement also
has no `TYPESAFE_API_KEY`.

Sending the retained prefixes with empty or invented evidence would measure a
different request, so no calls were made and no outcome was estimated. Thus the
same-choice, silent-loss, opposite-direction-flip, and material-confidence-change
counts are **not measured**, not zero. Historical confidence was not retained
either. The same limitation prevents the requested unfiltered replay of all 38
no-span turns.

The complete row-by-row availability manifest is reproducible with:

```text
pnpm measure:jev-filter /home/lunchbox/.veritaserum/telemetry.jsonl --verdict-parity-manifest
```

It names all 267 filtered-input candidates and all 38 no-span candidates by
timestamp, recorded verdict, and retained sentence/prefix. Every row is marked
`INPUT+KEY`; the full manifest is also attached to the PR as a comment so the
unmeasured rows are explicit rather than collapsed into a percentage.
