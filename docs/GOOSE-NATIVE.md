# Baking veritaserum into goose — native completion-gate design

Target: goose v2.0-rc tree (surveyed 2026-07-27, file:line refs from that tree).
Companion to upstream issues #9708 (the gate) and #10358 (now largely moot — see §2).
Status: design, pre-implementation. Everything below cites either a goose source fact
or a measured veritaserum result; the incident tally in §6 replaces an earlier
unmeasured "80%" claim that veritaserum itself flagged.

## 1. The seam — turn-end, in-process

Goose already has everything the gate needs at the exact right moment. In
`Agent::reply_internal` (crates/goose/src/agents/agent.rs:1847), at the three Stop
sites (:1988, :2894 blocking; :2927 non-blocking), these are live locals:

- `conversation: Conversation` — the complete session history including every
  `ToolRequest`/`ToolResponse` pair correlated by id. **This is the ledger.** No
  transcript parsing, no receipts-tail cap, no #10358 payload extension.
- `last_assistant_text: String` — the claim under audit.
- `working_dir` — where git probes run.

The block/inject machinery is also already native: `HookDecision::Deny` injects a
synthetic context message and re-runs the loop (:2004-2006), with a runaway cap
(`GOOSE_STOP_HOOK_BLOCK_CAP`, :439-448) — goose independently converged on
veritaserum's block-cap design. The gate reuses this control flow as an in-process
call instead of a subprocess plugin.

## 2. The idiomatic shape — a `CompletionInspector` beside `ToolInspector`

Goose's established middleware pattern is the `ToolInspector` trait +
`ToolInspectionManager` (tool_inspection.rs:34,56) with `is_enabled()` config
gating; `AdversaryInspector` (security/adversary_inspector.rs:271) is a working
in-core LLM-judge to mirror. The gate is the turn-end sibling:

```rust
#[async_trait]
pub trait CompletionInspector: Send + Sync {
    fn name(&self) -> &'static str;
    async fn inspect(&self, session_id: &str, final_text: &str,
                     conversation: &Conversation, working_dir: Option<&Path>)
        -> Result<CompletionVerdict>;
    fn is_enabled(&self) -> bool;
}
// CompletionVerdict: { claims: Vec<ClaimVerdict>, deliverable: Vec<Warning>,
//                      action: Warn | Deny { reason } }
```

Config surface mirrors the security classifiers (config.yaml keys, scanner.rs:71):
`COMPLETION_GATE_ENABLED`, `COMPLETION_GATE_AUDITOR_PROVIDER/MODEL`,
`COMPLETION_GATE_DELIVERY` (quiet|full), `COMPLETION_GATE_BLOCKING` (off by default).

## 3. The tiers, ported

**Tier 0 — deterministic (pure Rust, no model, runs on every turn).**
The measured heart of veritaserum's zero-false-positive layer:
- Claim-shape lexicons (completion/verification/number shapes) → the *gate*: turns
  with no claim-shaped content skip all model spend (measured: 81% of turns).
- Git probes at claim time: dirty-tree/HEAD-age vs "committed", ahead-of-upstream
  vs "pushed" — probe outranks any in-conversation receipt, and acquits too.
- **Verification freshness** (adopting the tree-digest idea from the #9708 thread):
  record tree digest when a verification command runs; compare at claim time.
  Catches verify-then-mutate and stale-artifact citation deterministically.

**Tier 1 — classifier. Deferred, honestly.** goose-local-inference serves
generative GGUF/MLX models but has no embeddings (surveyed: no embed API anywhere).
Options when wanted: the `ClassificationClient` HF-endpoint precedent
(security/classification_client.rs) or a tiny constrained-output GGUF judge. Not
needed for v1: in production, veritaserum's lexical+probe rules carried most
grounding value; embedding similarity mattered mainly for causal/attempt matching.

**Tier 2 — cross-family LLM auditor (async, gated).**
`providers::init::create(name, …)` (providers/init.rs:245) lets core code call a
*different* provider than the session's — the plumbing exists; no current inspector
uses a foreign provider (flagged: this would be the first). Fallback ladder:
foreign provider → `complete_fast` same-family (model_config.rs:110), tagged
same-family/weaker, exactly veritaserum's tier tagging. The judgment prompt ports
verbatim: the guard family (abstention / predictions / fiction / inference /
testimony / recalled-documentation), the reliance test, top-1 budget, and quote
anchoring — with budget, anchor verification, and testimony demotion enforced in
Rust post-parse, not left to model discretion (measured lesson: prose binds weakly,
code binds).

## 4. Delivery — native, and finally trivial

- Warn (default): inject the verdict as a context message for the next turn (the
  Deny-path injection machinery, without denying) and emit it as a
  `SystemNotification` content block so the human sees it in the UI. The
  `metadata_json` / `with_agent_invisible()` precedent (agent.rs:2846) marks
  auxiliary messages correctly. The entire external delivery saga — hook stdout
  semantics, systemMessage rendering, relay directives, stray routing — does not
  exist here.
- Block (opt-in): `HookDecision::Deny` + the existing cap.
- The quiet contract ships as the default deliverability predicate:
  contradicted ∨ (unsupported ∧ (specific figure ∨ completion/verification shape)).
  Derived from nine owner reactions; the suppressed classes go to telemetry.

## 5. Async + telemetry

Audit spawns via `tokio::spawn` following the `tool_pair_summarization_task`
spawn-then-join pattern (agent.rs:2827-2856) with `CancellationToken`; non-blocking
default preserves turn latency (R3). Verdicts land in sessions.db beside the
existing `usage_ledger` precedent — audit rows with verdict/delivery/anchor fields,
enabling native advisory-outcome measurement (was the warning acted on next turn).

## 6. What a native build dissolves vs keeps — the honest tally

Of the 11 incident classes hit in one week of external-install production:

Dissolved by living in-process (7): transcript-shape parsing (codex/claude formats);
receipts-tail truncation and caps; delivery-channel failures (invisible
systemMessage, relay dependence, misrouted strays); session-identity routing;
auditor self-audit recursion; cached-hook staleness / launcher drift; HTTP transport
ceilings (undici header timeout, fetch-failed retries) — goose's provider stack owns
transport.

Kept regardless of location (4): auditor judgment quality (guard compliance is
model behavior — measure it); auditor capacity/latency on local models (num_ctx-
class issues live wherever the model runs); eval/production contention on shared
local inference; and the sensitivity/taste boundary — which is why the delivery
predicate ships as configurable policy with suppression telemetry, not as opinion.

## 7. Migration of the constitution

The 22-scenario guard-compliance suite ports as the acceptance test for the native
auditor (fixture JSON is language-neutral). It is the only reason to trust any of
the judgment layer: every scenario encodes either a real production catch or a real
owner-rejected false flag. A native implementation that cannot pass it has not
implemented the gate, whatever its code says.

## 8. Upstream path

1. PR 1 (small, uncontroversial): `CompletionInspector` trait + manager + config
   keys + Tier 0 only (lexicons, git probes, freshness digests) + sessions.db
   verdict rows. Deterministic, zero model spend, zero new deps.
2. PR 2: Tier 2 auditor behind config (foreign-provider resolution + the ported
   prompt + Rust-enforced budget/anchor/testimony), delivery predicate, block mode.
3. #10358 gets closed as moot-for-native (the trace was always in memory); #9708
   gets the interim-results comment updated to point here.
