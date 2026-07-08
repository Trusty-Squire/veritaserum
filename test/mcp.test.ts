import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";

// Hermetic: MockKnight (command floor gate only → no LLM judge call).
beforeAll(() => {
  process.env.VS_MOCK_KNIGHT = "1";
});

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function connect() {
  const { buildServer } = await import("../src/mcp.js");
  const server = buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}
function textOf(r: unknown): string {
  const c = (r as { content?: { text?: string }[] }).content;
  return c?.map((x) => x.text ?? "").join("\n") ?? "";
}

describe("ser MCP server", () => {
  it("lists the split-API tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["contract_amend", "contract_propose", "contract_ratchet", "contract_seal", "contract_seed", "contract_status", "contract_verify"]);
  });

  it("seed → status → verify(pass) → verify(block) → ratchet over MCP", async () => {
    const client = await connect();
    const { dir, cleanup } = await tempRepo();
    cleanups.push(cleanup);

    const s = await client.callTool({ name: "contract_seed", arguments: { goal: "toy", dir } });
    expect(textOf(s)).toMatch(/sealed 1 gate/);

    const st = await client.callTool({ name: "contract_status", arguments: { dir } });
    expect(textOf(st)).toMatch(/active=1/);

    await writeFile(join(dir, "answer.txt"), "42\n");
    const ok = await client.callTool({ name: "contract_verify", arguments: { dir } });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toMatch(/OK —/);

    await rm(join(dir, "answer.txt"), { force: true });
    const blocked = await client.callTool({ name: "contract_verify", arguments: { dir } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toMatch(/BLOCKED/);

    const r = await client.callTool({ name: "contract_ratchet", arguments: { complaint: "must not be empty", dir } });
    expect(textOf(r)).toMatch(/added/);
  });

  it("returns tool errors gracefully (isError), does not crash the server", async () => {
    const client = await connect();
    const { dir, cleanup } = await tempRepo();
    cleanups.push(cleanup);
    await client.callTool({ name: "contract_seed", arguments: { goal: "toy", dir } });
    // re-seed an existing contract → SeedError, surfaced as isError, server stays up
    const dup = await client.callTool({ name: "contract_seed", arguments: { goal: "again", dir } });
    expect(dup.isError).toBe(true);
    expect(textOf(dup)).toMatch(/already exists/);
    // server still responsive afterward
    const st = await client.callTool({ name: "contract_status", arguments: { dir } });
    expect(textOf(st)).toMatch(/active=/);
  });

  it("amend requires confirm (weakening guard)", async () => {
    const client = await connect();
    const { dir, cleanup } = await tempRepo();
    cleanups.push(cleanup);
    await client.callTool({ name: "contract_seed", arguments: { goal: "toy", dir } });

    const dry = await client.callTool({ name: "contract_amend", arguments: { match: "floor", as: "scope change", dir } });
    expect(textOf(dry)).toMatch(/would retire.*confirm:true/s);

    const done = await client.callTool({ name: "contract_amend", arguments: { match: "floor", as: "scope change", confirm: true, dir } });
    expect(textOf(done)).toMatch(/retired 1 gate/);
    const st = await client.callTool({ name: "contract_status", arguments: { dir } });
    expect(textOf(st)).toMatch(/active=0 retired=1/);
  });
});
