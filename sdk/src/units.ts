// Raw token units (bigint) and decimal strings. All SDK amounts are raw units, as on-chain.

/** "12.5" with 6 decimals → 12_500_000n. Throws on anything that isn't a plain non-negative decimal. */
export function toRaw(value: string | number, decimals: number): bigint {
  const text = typeof value === "number" ? value.toFixed(decimals) : value.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && !match[2])) throw new Error(`not an amount: ${value}`);
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error(`more than ${decimals} decimals: ${value}`);
  return BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals) || "0");
}

/** 12_500_000n with 6 decimals → "12.5". Exact: no floating point. */
export function fromRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
