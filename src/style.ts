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

/** A light banner box around a title + optional subtitle lines. */
export function banner(title: string, subtitle?: string): string {
  const rows = [bold(cyan(title)), ...(subtitle ? [dim(subtitle)] : [])];
  const w = Math.max(...rows.map(visLen)) + 2;
  const pad = (r: string): string => `${dim("│")} ${r}${" ".repeat(w - visLen(r) - 1)}${dim("│")}`;
  return [dim(`┌${"─".repeat(w)}┐`), ...rows.map(pad), dim(`└${"─".repeat(w)}┘`)].join("\n");
}
