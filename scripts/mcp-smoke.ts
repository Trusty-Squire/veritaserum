/**
 * Live MCP smoke: spawn the BUILT server (node dist/mcp.js) as a real stdio process
 * and drive it with a real MCP client over stdio. Hermetic (MockKnight, no LLM).
 * Proves the server works as a real MCP harness, not just the in-memory unit test.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

const serverPath = resolve(import.meta.dirname, "../dist/mcp.js");
const dir = await mkdtemp(join(tmpdir(), "ser-mcpsmoke-"));
await execa("git", ["init", "-q"], { cwd: dir });
await execa("git", ["config", "user.email", "m@m.m"], { cwd: dir });
await execa("git", ["config", "user.name", "m"], { cwd: dir });
await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env, SER_MOCK_KNIGHT: "1" } as Record<string, string>,
});
const client = new Client({ name: "smoke", version: "1" });
await client.connect(transport);

const t = (r: unknown) => ((r as { content?: { text?: string }[] }).content ?? []).map((x) => x.text ?? "").join("\n");
try {
  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((x) => x.name).join(", ")}`);

  console.log("seed:   " + t(await client.callTool({ name: "contract_seed", arguments: { goal: "toy", dir } })));
  await writeFile(join(dir, "answer.txt"), "42\n");
  const ok = await client.callTool({ name: "contract_verify", arguments: { dir } });
  console.log(`verify(built): ${t(ok)}  [isError=${ok.isError ?? false}]`);
  await rm(join(dir, "answer.txt"), { force: true });
  const bad = await client.callTool({ name: "contract_verify", arguments: { dir } });
  console.log(`verify(broken): ${t(bad)}  [isError=${bad.isError}]`);
  console.log("status: " + t(await client.callTool({ name: "contract_status", arguments: { dir } })));
} finally {
  await client.close();
  await rm(dir, { recursive: true, force: true });
}
console.log("\nMCP SMOKE OK");
