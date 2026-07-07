# ser MCP server

The pull-side surface over the same engine as the CLI/hook path, for hosts that
prefer tool-calls. **Not the enforcement path** — MCP is pull-only, so an agent could
skip it; enforcement stays the harness Stop hook + `ser verify` CLI (DESIGN §9). This
lets an agent seed/inspect/ratchet a contract on demand.

## Tools (the split API, §4)
| Tool | Args | Effect |
|---|---|---|
| `contract_seed` | goal, dir? | author + seal a fresh contract (Knight) |
| `contract_ratchet` | complaint, dir? | append a gate (monotonic) |
| `contract_amend` | match, as, confirm, dir? | retire matching gates (needs confirm) |
| `contract_verify` | level?, dir? | run gates from committed graders; `isError` on block; semantic gates judged cross-vendor |
| `contract_status` | dir? | read-only contract summary |

## Register
Stdio server. Example (Claude Code / any MCP host):
```json
{ "mcpServers": { "ser": { "command": "ser-mcp" } } }
```
(`npm link` or install so `ser-mcp` is on PATH; or `command: "node", args:["<repo>/dist/mcp.js"]`.)

Free: authoring uses claude, semantic judging uses the cross-vendor pick, both local
subscriptions. OpenRouter is never auto-selected.
