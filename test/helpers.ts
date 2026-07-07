import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
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
