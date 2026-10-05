// The stock-token tape behind the Markets tab: types, scoping and statistics. Pure functions over
// `public/data/tape.json`, which `scripts/tape-data.ts` builds from the execution-quality research.

/** One token's tape, one entry per 15-minute bucket it traded in. */
export type TapeToken = {
  sym: string;
  issuer: string;
  pool: string;
  reserve: number;
  /** False when one token is not one share of the stock (some pre-IPO wrappers): no premium then. */
  units: boolean;
  /** Bucket index. */
  i: number[];
  /** Price per share, cents. */
  p: (number | null)[];
  /** Fair value per share (the stock, or its perp off-hours), cents. */
  f: (number | null)[];
  /** Premium over fair value, tenths of a bps. */
  x: (number | null)[];
  /** Volume, USD. */
  v: number[];
};

export type TapeStock = {
  u: string;
  kind: "public" | "private";
  ref: string;
  /** The token most people would buy without comparing. */
  naive: string;
  /** Tokens with a comparable unit; two or more means the issuer choice is measured. */
  comparable: string[];
  tokens: TapeToken[];
  /** Cheapest issuer per bucket: savings over the naive token (0.1 bps) and the winner's index. */
  cmp: { i: number[]; s: (number | null)[]; best: number[] };
  /** The same comparison between two pools of one token, to tell savings from noise. */
  plc: { i: number[]; s: (number | null)[] };
};

export type Tape = {
  window: { start: number; step: number; n: number };
  /** Session per bucket: R regular, P pre-market, O after-hours, N overnight, C closed. */
  sess: string;
  decision: {
    excessRegular: number;
    excessOff: number;
    regularMean: number;
    regularPlacebo: number;
    positiveDays: number;
    days: number;
    timingExcess: number;
    regularNormMedian: number;
    offNormMedian: number;
    issuerPillar: boolean;
    timingPillar: boolean;
  };
  stocks: TapeStock[];
};

export const SESSION_NAME: Record<string, string> = {
  R: "Regular",
  P: "Pre-market",
  O: "After-hours",
  N: "Overnight",
  C: "Closed",
};
export const SESSION_ORDER = ["R", "P", "O", "N", "C"];

export const WINDOWS = [
  { key: "30", label: "30 days", days: 30 },
  { key: "7", label: "7 days", days: 7 },
  { key: "1", label: "Last day", days: 1 },
] as const;
export const SESSIONS = [
  { key: "all", label: "All hours", test: () => true },
  { key: "reg", label: "Market hours", test: (s: string) => s === "R" },
  { key: "off", label: "Off-hours", test: (s: string) => s !== "R" },
] as const;
export type WindowKey = (typeof WINDOWS)[number]["key"];
export type SessionKey = (typeof SESSIONS)[number]["key"];

/** Which buckets count: the last `days` of the window, in the chosen sessions. */
export type Scope = { b0: number; b1: number; inScope: (bucket: number) => boolean };

export function scopeOf(tape: Tape, win: WindowKey, ses: SessionKey): Scope {
  const days = WINDOWS.find((w) => w.key === win)!.days;
  const b1 = tape.window.n;
  const b0 = Math.max(0, b1 - (days * 86_400) / tape.window.step);
  const test = SESSIONS.find((s) => s.key === ses)!.test;
  return { b0, b1, inScope: (b) => b >= b0 && b < b1 && test(tape.sess[b]) };
}

export const bucketTime = (tape: Tape, b: number) => new Date((tape.window.start + b * tape.window.step) * 1000);

export function quantile(sorted: number[], q: number) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Row positions of a token's tape inside the scope, optionally in one session. */
export function rowsIn(tape: Tape, t: TapeToken, scope: Scope, session?: string) {
  const out: number[] = [];
  for (let k = 0; k < t.i.length; k++) {
    if (scope.inScope(t.i[k]) && (!session || tape.sess[t.i[k]] === session)) out.push(k);
  }
  return out;
}

export type Spread = { n: number; p10: number | null; p25: number | null; med: number | null; p75: number | null; p90: number | null };

/** Premium distribution (bps) over the given rows. */
export function premiumSpread(t: TapeToken, rows: number[]): Spread {
  const xs = rows.map((k) => t.x[k]).filter((x): x is number => x != null).map((x) => x / 10).sort((a, b) => a - b);
  return {
    n: xs.length,
    p10: quantile(xs, 0.1),
    p25: quantile(xs, 0.25),
    med: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    p90: quantile(xs, 0.9),
  };
}

/** Volume in the rows, and how much of it traded outside regular hours. */
export function volumeOf(tape: Tape, t: TapeToken, rows: number[]) {
  let total = 0;
  let off = 0;
  for (const k of rows) {
    total += t.v[k];
    if (tape.sess[t.i[k]] !== "R") off += t.v[k];
  }
  return { total, off };
}

/** Mean savings from buying the cheapest issuer instead of the naive token, next to the placebo's. */
export function issuerSavings(st: TapeStock, scope: Scope) {
  const pick = (series: { i: number[]; s: (number | null)[] }) => {
    const xs: number[] = [];
    for (let k = 0; k < series.i.length; k++) {
      const s = series.s[k];
      if (s != null && scope.inScope(series.i[k])) xs.push(s / 10);
    }
    return xs;
  };
  const savings = pick(st.cmp);
  const placebo = pick(st.plc);
  return { savings, placebo, mean: mean(savings), placeboMean: mean(placebo) };
}

/** Share of compared buckets where a token other than the naive one was cheapest. */
export function cheaperThanNaive(st: TapeStock, scope: Scope) {
  const naive = st.tokens.findIndex((t) => t.sym === st.naive);
  let total = 0;
  let other = 0;
  for (let k = 0; k < st.cmp.i.length; k++) {
    if (!scope.inScope(st.cmp.i[k]) || st.cmp.best[k] < 0) continue;
    total++;
    if (st.cmp.best[k] !== naive) other++;
  }
  return total ? other / total : null;
}

/** Fixed-width bins over the scope: the median of `value` and the volume of each bin. */
export function binned(t: TapeToken, scope: Scope, size: number, value: (k: number) => number | null) {
  const nb = Math.ceil((scope.b1 - scope.b0) / size);
  const values: number[][] = Array.from({ length: nb }, () => []);
  const volume = new Array<number>(nb).fill(0);
  for (let k = 0; k < t.i.length; k++) {
    if (!scope.inScope(t.i[k])) continue;
    const j = Math.floor((t.i[k] - scope.b0) / size);
    const x = value(k);
    if (x != null) values[j].push(x);
    volume[j] += t.v[k];
  }
  return {
    size,
    nb,
    median: values.map((xs) => quantile(xs.sort((a, b) => a - b), 0.5)),
    volume,
  };
}

/** Rows of the tape for one stock, newest first. */
export function tapeRows(tape: Tape, st: TapeStock, scope: Scope) {
  const cheapest = new Map<number, number>();
  for (let k = 0; k < st.cmp.i.length; k++) if (st.cmp.best[k] >= 0) cheapest.set(st.cmp.i[k], st.cmp.best[k]);
  const rows: { token: TapeToken; k: number; bucket: number; cheapest: boolean }[] = [];
  st.tokens.forEach((token, ti) => {
    for (const k of rowsIn(tape, token, scope)) {
      rows.push({ token, k, bucket: token.i[k], cheapest: st.comparable.length > 1 && cheapest.get(token.i[k]) === ti });
    }
  });
  return rows.sort((a, b) => b.bucket - a.bucket || b.token.v[b.k] - a.token.v[a.k]);
}
