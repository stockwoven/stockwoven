// Number and time formats for the Markets tab. Times are the viewer's local time.

export const ISSUER_COLOR: Record<string, string> = {
  xStocks: "var(--issuer-xstocks)",
  Backpack: "var(--issuer-backpack)",
  Tessera: "var(--issuer-tessera)",
  PreStocks: "var(--issuer-prestocks)",
  Ondo: "var(--issuer-ondo)",
};
export const issuerColor = (issuer: string) => ISSUER_COLOR[issuer] ?? "var(--text-subtle)";

const fixed = (digits: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Signed basis points with a true minus sign. */
export const bps = (x: number | null | undefined, digits = 0) =>
  x == null || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${fixed(digits).format(Math.abs(x))}`;

export const usd = (x: number | null | undefined) => {
  if (x == null) return "—";
  const a = Math.abs(x);
  if (a >= 1e6) return `$${fixed(2).format(x / 1e6)}M`;
  if (a >= 1e3) return `$${fixed(1).format(x / 1e3)}K`;
  return `$${fixed(0).format(x)}`;
};

export const price = (cents: number | null | undefined) => (cents == null ? "—" : `$${fixed(2).format(cents / 100)}`);

export const percent = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`);

export const count = (x: number) => fixed(0).format(x);

export const dateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
export const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });
