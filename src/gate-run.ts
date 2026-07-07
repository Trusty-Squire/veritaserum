/**
 * Run a single command gate: shell, exit 0 = pass. execa, tail-captured output.
 * Ported from proj-cs harness/gates.ts (command tier only, for P0).
 */
import { execa } from "execa";

const TAIL_BYTES = 4096;
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;

export interface GateResult {
  command: string;
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

function tail(s: string): string {
  if (s.length <= TAIL_BYTES) return s;
  return s.slice(s.length - TAIL_BYTES);
}

export async function runGate(command: string, cwd: string, timeoutMs = DEFAULT_GATE_TIMEOUT_MS): Promise<GateResult> {
  const started = Date.now();
  const r = await execa(command, {
    cwd,
    shell: true,
    reject: false,
    timeout: timeoutMs,
    all: false,
  });
  const timedOut = r.timedOut ?? false;
  return {
    command,
    passed: !timedOut && r.exitCode === 0,
    exitCode: r.exitCode ?? (timedOut ? 124 : 1),
    timedOut,
    stdoutTail: tail(r.stdout ?? ""),
    stderrTail: tail(r.stderr ?? ""),
    durationMs: Date.now() - started,
  };
}
