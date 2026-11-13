// Compact token count for small spaces: 950, 12.4k, 1.2M. One decimal at most,
// and no trailing ".0" (12000 -> "12k"). Bad input shows as 0.
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  const whole = Math.round(count);
  if (whole < 1000) return String(whole);
  const trim = (v: number) => String(Math.round(v * 10) / 10);
  const k = Math.round((whole / 1000) * 10) / 10;
  if (k < 1000) return `${trim(k)}k`;
  return `${trim(whole / 1_000_000)}M`;
}
