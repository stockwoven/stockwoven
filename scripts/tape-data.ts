// Builds the Markets tab's data from the execution-quality research output: every stock token's
// 15-minute tape (price per share, fair value, premium, volume), the issuer comparisons and the
// placebo. Series are indexed by bucket (0 = window start) to keep the file small.
//
//   npx tsx scripts/tape-data.ts <research>/execution-quality/data/out
//
// Writes app/public/data/tape.json.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: tsx scripts/tape-data.ts <execution-quality/data/out>");
const STEP = 900;

type Row = Record<string, string>;
const csv = (file: string): Row[] => {
  const lines = readFileSync(join(OUT, file), "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(head.map((k, i) => [k, cells[i]]));
  });
};

const summary = JSON.parse(readFileSync(join(OUT, "summary.json"), "utf8"));
const start: number = summary.window.start;
const n = Math.round((summary.window.end - start) / STEP);
const bucket = (iso: string) => Math.round((Date.parse(iso) / 1000 - start) / STEP);
const SESSION: Record<string, string> = { REGULAR: "R", PRE: "P", POST: "O", OVERNIGHT: "N", CLOSED: "C" };
const scaled = (x: string | undefined, k: number) => (x === undefined || x === "" ? null : Math.round(Number(x) * k));

const obs = csv("observations.csv");
const cmp = csv("comparisons.csv");
const plc = csv("placebo.csv");

// Session of every bucket, from whatever traded in it; the few silent buckets take the previous one.
const sess: string[] = new Array(n).fill("");
for (const r of [...obs, ...cmp, ...plc]) {
  const i = bucket(r.bucket_utc);
  if (i >= 0 && i < n) sess[i] = SESSION[r.session];
}
for (let i = 0; i < n; i++) if (!sess[i]) sess[i] = sess[i - 1] || sess[i + 1] || "C";

const stocks = summary.underlyings.map((u: any) => {
  const tokens = summary.tokens
    .filter((t: any) => t.underlying === u.underlying)
    .map((t: any) => {
      const rows = obs.filter((r) => r.underlying === u.underlying && r.symbol === t.symbol);
      // A pre-IPO wrapper may not be one share of the stock; its premium would mean nothing.
      const units = t.unitsConsistent !== false;
      return {
        sym: t.symbol,
        issuer: t.issuer,
        pool: t.poolName,
        reserve: Math.round(t.poolReserveUsd),
        units,
        i: rows.map((r) => bucket(r.bucket_utc)),
        p: rows.map((r) => scaled(r.price_per_share_usd, 100)), // cents per share
        f: rows.map((r) => scaled(r.ref_price_usd, 100)), // cents per share
        x: rows.map((r) => (units ? scaled(r.premium_bps, 10) : null)), // 0.1 bps
        v: rows.map((r) => Math.round(Number(r.volume_usd))), // USD
      };
    });
  const symIndex = (s: string) => tokens.findIndex((t: any) => t.sym === s);
  const c = cmp.filter((r) => r.underlying === u.underlying);
  const p = plc.filter((r) => r.underlying === u.underlying);
  return {
    u: u.underlying,
    kind: u.kind,
    ref: u.referenceKind,
    naive: u.naiveSymbol,
    comparable: u.comparable,
    tokens,
    cmp: { i: c.map((r) => bucket(r.bucket_utc)), s: c.map((r) => scaled(r.savings_bps, 10)), best: c.map((r) => symIndex(r.best)) },
    plc: { i: p.map((r) => bucket(r.bucket_utc)), s: p.map((r) => scaled(r.savings_bps, 10)) },
  };
});

const d = summary.decision;
const data = {
  window: { start, step: STEP, n },
  sess: sess.join(""),
  decision: {
    excessRegular: d.excessSavingsRegularBps,
    excessOff: d.excessSavingsOffHoursBps,
    regularMean: d.regular.mean,
    regularPlacebo: d.regularPlacebo.mean,
    positiveDays: d.daily.positiveDays,
    days: d.daily.days,
    timingExcess: d.excessOffHoursMedianBps,
    regularNormMedian: d.regularNorm.medianAbs,
    offNormMedian: d.offHoursNorm.medianAbs,
    issuerPillar: d.issuerPillar,
    timingPillar: d.timingPillar,
  },
  stocks,
};

const dir = new URL("../app/public/data/", import.meta.url);
mkdirSync(dir, { recursive: true });
const json = JSON.stringify(data);
writeFileSync(new URL("tape.json", dir), json);
const tokens = stocks.reduce((a: number, s: any) => a + s.tokens.length, 0);
const rows = stocks.reduce((a: number, s: any) => a + s.tokens.reduce((b: number, t: any) => b + t.i.length, 0), 0);
console.log(`app/public/data/tape.json: ${stocks.length} stocks, ${tokens} tokens, ${rows} observations, ${(json.length / 1024).toFixed(0)} KB`);
