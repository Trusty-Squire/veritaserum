import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

/** A throwaway git repo in the OS temp dir. Caller must call cleanup(). */
export async function tempRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ser-test-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function write(dir: string, path: string, content: string): Promise<void> {
  const abs = join(dir, path);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

export const JEV_STATE_CONFAB = {
  answers: {
    finding: {
      choice: "confabulation_state",
      confidence: 0.9,
      probabilities: { confabulation_state: 0.8, confabulation_diagnosis: 0.1, not_confabulation: 0.1 },
    },
  },
} as const;

export const JEV_DIAG_CONFAB = {
  answers: {
    finding: {
      choice: "confabulation_diagnosis",
      confidence: 0.9,
      probabilities: { confabulation_state: 0.1, confabulation_diagnosis: 0.8, not_confabulation: 0.1 },
    },
  },
} as const;

export const JEV_CLEAN = {
  answers: {
    finding: {
      choice: "not_confabulation",
      confidence: 0.9,
      probabilities: { confabulation_state: 0.05, confabulation_diagnosis: 0.05, not_confabulation: 0.9 },
    },
  },
} as const;

export function startJevMock(body: object = JEV_STATE_CONFAB): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
