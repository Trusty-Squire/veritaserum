/**
 * Minimal ANSI styling for the install CLI. TTY-gated and NO_COLOR-honored, so
 * piped/CI output is plain. No spinners, no cursor games — just color + a couple
 * of box-drawing helpers, in the spirit of a clean line-based CLI.
 */
const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;
const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const green = wrap(32, 39);
export const cyan = wrap(36, 39);
export const yellow = wrap(33, 39);
export const red = wrap(31, 39);

/** Visible width, ignoring ANSI escapes. */
function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export const check = green(bold("✓"));
export const cross = red(bold("✗"));
export const arrow = dim("→");
export const dot = dim("·");

export function ok(label: string): string {
  return `${check} ${label}`;
}
export function step(label: string): string {
  return `  ${arrow} ${label}`;
}
export function divider(w = 58): string {
  return dim("─".repeat(w));
}

// ---------------------------------------------------------------------------
// Harness-channel emphasis — NOT the TTY-gated helpers above.
//
// The warning we hand a harness's HUMAN channel (Claude Code's `systemMessage`)
// is rendered by that UI, not by our own terminal — so, unlike the install CLI,
// this must NOT be gated on process.stdout.isTTY (our stdout in the hook is a
// pipe to the harness, never a TTY). It honors NO_COLOR and a VS_NO_COLOR
// override: either set → no escapes at all.
//
// EMPIRICALLY UNVERIFIED: whether Claude Code actually renders ANSI in
// systemMessage is unknown (see cli.ts injectionFor). The design therefore never
// relies on color — callers keep an emoji marker + plain text that still reads if
// the escapes are stripped or ignored.
// ---------------------------------------------------------------------------
export function channelColorEnabled(): boolean {
  return !process.env.NO_COLOR && !process.env.VS_NO_COLOR;
}

/** Bold + a warning color, applied unconditionally (the caller gates on
 *  channelColorEnabled). yellow = warn severity, red = a contradicted verdict. */
export function emphasize(s: string, color: "yellow" | "red"): string {
  const c = color === "red" ? 31 : 33;
  return `\x1b[1m\x1b[${c}m${s}\x1b[39m\x1b[22m`;
}

/** A light banner box around a title + optional subtitle lines. */
export function banner(title: string, subtitle?: string): string {
  const rows = [bold(cyan(title)), ...(subtitle ? [dim(subtitle)] : [])];
  const w = Math.max(...rows.map(visLen)) + 2;
  const pad = (r: string): string => `${dim("│")} ${r}${" ".repeat(w - visLen(r) - 1)}${dim("│")}`;
  return [dim(`┌${"─".repeat(w)}┐`), ...rows.map(pad), dim(`└${"─".repeat(w)}┘`)].join("\n");
}
