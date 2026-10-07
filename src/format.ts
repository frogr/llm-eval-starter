// Tiny terminal formatting helpers. Colors are disabled when output isn't a
// TTY or NO_COLOR is set (https://no-color.org), so CI logs stay clean.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
};

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function usd(x: number | null): string {
  if (x === null) return "n/a";
  return `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;
}

/** Text bar for a 0..1 rate. */
export function bar(rate: number, width = 20): string {
  const filled = Math.round(rate * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Left-align columns. `rows` must be plain strings (pad before coloring). */
export function table(rows: string[][], indent = "  "): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => indent + r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
