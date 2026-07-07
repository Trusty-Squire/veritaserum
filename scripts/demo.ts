/**
 * P0 success-gate demo: drives the real `ser` CLI in a throwaway git repo.
 * Proves seed → verify(pass) → tamper → verify(pristine beats tamper) → ratchet.
 * Exits 0 iff every step behaves as specified.
 */
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");
const RUNNER = resolve(import.meta.dirname, "../node_modules/.bin/tsx");

async function ser(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const r = await execa(RUNNER, [CLI, ...args], { cwd: dir, reject: false });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  return { code: r.exitCode ?? 1, out };
}

function step(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  console.log(`    ${detail.replace(/\n/g, "\n    ")}`);
  return ok;
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "ser-demo-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "d@d.d"], { cwd: dir });
  await execa("git", ["config", "user.name", "demo"], { cwd: dir });
  await execa("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  console.log(`demo repo: ${dir}\n`);

  let ok = true;

  // 1. seed
  const s = await ser(dir, ["seed", "toy: the build must produce answer.txt"]);
  ok = step("ser seed → sealed contract", s.code === 0 && /sealed contract/.test(s.out), s.out) && ok;

  // 2. build produces the artifact → verify passes
  await writeFile(join(dir, "answer.txt"), "42\n");
  const v1 = await ser(dir, ["verify"]);
  ok = step("ser verify (good build) → OK, exit 0", v1.code === 0 && /OK —/.test(v1.out), v1.out) && ok;

  // 3. TAMPER: break the build AND soften the grader to always-pass
  await rm(join(dir, "answer.txt"), { force: true });
  await mkdir(join(dir, ".ser/gates"), { recursive: true });
  await writeFile(join(dir, ".ser/gates/floor.sh"), "exit 0\n"); // naive run would PASS
  const v2 = await ser(dir, ["verify"]);
  const pristineBeatsTamper = v2.code === 1 && /BLOCKED/.test(v2.out) && /TAMPER/.test(v2.out);
  ok = step("ser verify (tampered grader, broken build) → BLOCKED + TAMPER, exit 1", pristineBeatsTamper, v2.out) && ok;

  // 4. ratchet appends a gate
  const r = await ser(dir, ["ratchet", "answers must never be empty"]);
  ok = step("ser ratchet → added, exit 0", r.code === 0 && /added/.test(r.out), r.out) && ok;

  await rm(dir, { recursive: true, force: true });
  console.log(`\n${ok ? "DEMO PASSED" : "DEMO FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
