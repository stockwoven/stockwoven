"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import {
  SESSIONS,
  SESSION_NAME,
  SESSION_ORDER,
  SessionKey,
  Tape,
  TapeStock,
  WINDOWS,
  WindowKey,
  bucketTime,
  cheaperThanNaive,
  issuerSavings,
  premiumSpread,
  rowsIn,
  scopeOf,
  tapeRows,
  volumeOf,
} from "@/lib/tape";
import { Button } from "../ds";
import { LearnMore } from "../LearnMore";
import { bps, count, dateTime, day, issuerColor, percent, price, usd } from "./format";
import { PremiumChart, VolumeChart } from "./MarketCharts";

const PAGE = 40;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`markets:${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`markets:${k}`, v);
    } catch {}
  },
};

function Seg<K extends string>({ label, items, value, onPick }: { label: string; items: readonly { key: K; label: string }[]; value: K; onPick: (k: K) => void }) {
  return (
    <div className="filter">
      <span className="t-eyebrow muted" id={`seg-${label}`}>
        {label}
      </span>
      <div className="seg" role="group" aria-labelledby={`seg-${label}`}>
        {items.map((it) => (
          <button key={it.key} type="button" className="t-label" aria-pressed={it.key === value} onClick={() => onPick(it.key)}>
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Figure({ label, value, unit, note }: { label: ReactNode; value: ReactNode; unit?: ReactNode; note?: ReactNode }) {
  return (
    <div className="figure">
      <dt className="t-eyebrow muted">{label}</dt>
      <dd className="t-data-lg">
        {value}
        {unit && <span className="t-data muted"> {unit}</span>}
      </dd>
      {note && <dd className="t-data muted figure__note">{note}</dd>}
    </div>
  );
}

const Token = ({ sym, issuer, plain }: { sym: string; issuer: string; plain?: boolean }) => (
  <span className="tok">
    <i className="tok__dot" style={{ background: issuerColor(issuer) }} />
    <span className="t-data">{sym}</span>
    {!plain && <span className="t-body muted"> {issuer}</span>}
  </span>
);

/** p10–p90 whisker, p25–p75 box and median tick, on a scale shared by the rows of one stock. */
function Strip({ q, lo, hi, color }: { q: (number | null)[]; lo: number; hi: number; color: string }) {
  const w = 200;
  const h = 22;
  const x = (v: number) => 6 + ((v - lo) / (hi - lo)) * (w - 12);
  const [p10, p25, med, p75, p90] = q as number[];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`p10 ${bps(p10)}, p25 ${bps(p25)}, median ${bps(med)}, p75 ${bps(p75)}, p90 ${bps(p90)} bps`}>
      <line x1={x(0)} x2={x(0)} y1={2} y2={h - 2} style={{ stroke: "var(--text-subtle)" }} />
      <line x1={x(p10)} x2={x(p90)} y1={h / 2} y2={h / 2} strokeWidth={2} strokeLinecap="round" style={{ stroke: color }} />
      <rect x={x(p25)} y={5} width={Math.max(2, x(p75) - x(p25))} height={h - 10} rx={3} strokeWidth={1.5} style={{ fill: color, fillOpacity: 0.22, stroke: color }} />
      <line x1={x(med)} x2={x(med)} y1={3} y2={h - 3} strokeWidth={2} style={{ stroke: "var(--text)" }} />
    </svg>
  );
}

export function Markets() {
  const [tape, setTape] = useState<Tape | null>(null);
  const [failed, setFailed] = useState(false);
  const [win, setWin] = useState<WindowKey>("30");
  const [ses, setSes] = useState<SessionKey>("all");
  const [stockKey, setStockKey] = useState("SPCX");
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    fetch("/data/tape.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((t: Tape) => {
        setTape(t);
        const hash = decodeURIComponent(location.hash.slice(1));
        const saved = store.get("stock");
        const pick = [hash, saved].find((u) => u && t.stocks.some((s) => s.u === u));
        if (pick) setStockKey(pick);
        const w = store.get("win");
        if (WINDOWS.some((x) => x.key === w)) setWin(w as WindowKey);
        const s = store.get("ses");
        if (SESSIONS.some((x) => x.key === s)) setSes(s as SessionKey);
      })
      .catch(() => setFailed(true));
  }, []);

  const scope = useMemo(() => tape && scopeOf(tape, win, ses), [tape, win, ses]);
  const stock = tape?.stocks.find((s) => s.u === stockKey) ?? tape?.stocks[0];

  const pickStock = (u: string) => {
    setStockKey(u);
    setShown(PAGE);
    store.set("stock", u);
    history.replaceState(null, "", `#${u}`);
  };

  if (failed) {
    return (
      <div className="banner" role="alert">
        <div>
          <p className="t-label">Could not load the market tape.</p>
          <p className="t-data">Reload the page to try again.</p>
        </div>
      </div>
    );
  }
  if (!tape || !scope || !stock) {
    return (
      <section className="tile">
        <span className="skeleton" style={{ width: "40%", height: "1.6em" }} />
        <span className="skeleton" style={{ width: "100%", height: 240 }} />
      </section>
    );
  }

  const scopeLabel = `${WINDOWS.find((w) => w.key === win)!.label} · ${SESSIONS.find((s) => s.key === ses)!.label.toLowerCase()}`;
  const end = bucketTime(tape, tape.window.n);
  const startTime = bucketTime(tape, 0);
  const d = tape.decision;

  return (
    <>
      <p className="t-body muted markets-lede">
        Every 15 minutes a tokenized stock traded on Solana: its price per real share, the fair value (the stock, or its perp off-hours) and the volume. {day.format(startTime)} to {day.format(end)},{" "}
        {tape.stocks.length} stocks, {tape.stocks.reduce((a, s) => a + s.tokens.length, 0)} tokens. <LearnMore href="/docs/markets" />
      </p>

      <div className="verdicts">
        <div className="verdict">
          <span className={`verdict__state t-eyebrow ${d.issuerPillar ? "is-yes" : "is-no"}`}>{d.issuerPillar ? "✓ Pays" : "✕ Doesn't pay"}</span>
          <p className="t-body">
            <b>Choosing the issuer.</b> The cheapest token saved {bps(d.excessRegular)} bps over the placebo in market hours and {bps(d.excessOff)} off-hours, on {d.positiveDays} of {d.days} days.
          </p>
        </div>
        <div className="verdict">
          <span className={`verdict__state t-eyebrow ${d.timingPillar ? "is-yes" : "is-no"}`}>{d.timingPillar ? "✓ Pays" : "✕ Doesn't pay"}</span>
          <p className="t-body">
            <b>Choosing the hour.</b> Prices drift {Math.round(d.offNormMedian)} bps from normal off-hours against {Math.round(d.regularNormMedian)} bps in market hours ({bps(d.timingExcess, 1)} bps).
          </p>
        </div>
      </div>

      <nav className="filters" aria-label="Filters">
        <Seg label="Range" items={WINDOWS} value={win} onPick={(k) => { setWin(k); setShown(PAGE); store.set("win", k); }} />
        <Seg label="Hours" items={SESSIONS} value={ses} onPick={(k) => { setSes(k); setShown(PAGE); store.set("ses", k); }} />
      </nav>

      <Overview tape={tape} scope={scope} scopeLabel={scopeLabel} selected={stock.u} onPick={pickStock} />
      <StockDetail tape={tape} stock={stock} scope={scope} scopeLabel={scopeLabel} win={win} ses={ses} shown={shown} onMore={() => setShown((n) => n + PAGE)} onPick={pickStock} />
    </>
  );
}

function Overview({ tape, scope, scopeLabel, selected, onPick }: { tape: Tape; scope: ReturnType<typeof scopeOf>; scopeLabel: string; selected: string; onPick: (u: string) => void }) {
  let total = 0;
  let off = 0;
  const pooled: number[] = [];
  const placebo: number[] = [];
  const rows = tape.stocks.map((st) => {
    let v = 0;
    let o = 0;
    for (const t of st.tokens) {
      const vol = volumeOf(tape, t, rowsIn(tape, t, scope));
      v += vol.total;
      o += vol.off;
    }
    total += v;
    off += o;
    // The naive token's premium: tokens of one stock trade at different offsets, so pooling them blurs both.
    const naive = st.tokens.find((t) => t.sym === st.naive) ?? st.tokens[0];
    const spread = st.ref === "none" ? null : premiumSpread(naive, rowsIn(tape, naive, scope));
    const savings = st.comparable.length > 1 ? issuerSavings(st, scope) : null;
    if (savings) {
      pooled.push(...savings.savings);
      placebo.push(...savings.placebo);
    }
    return { st, v, o, spread, savings };
  });
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const saved = avg(pooled);
  const noise = avg(placebo);

  return (
    <section className="tile" aria-labelledby="overview-title">
      <div className="tile__head">
        <h2 id="overview-title" className="t-heading-sm">
          All stocks.
        </h2>
        <span className="t-eyebrow muted">{scopeLabel}</span>
      </div>
      <dl className="figures figures--3">
        <Figure label="Volume" value={usd(total)} note={`${tape.stocks.length} stocks`} />
        <Figure label="Off-hours" value={percent(total ? off / total : null)} unit="of volume" note="pre, after, overnight, weekend" />
        <Figure label="Choosing the issuer" value={saved == null ? "—" : bps(saved - (noise ?? 0))} unit="bps" note={saved == null ? "no comparisons in range" : `${saved.toFixed(1)} bps saved, ${noise?.toFixed(1)} in the placebo`} />
      </dl>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Stocks table">
        <table className="table table--dense markets-table">
          <caption className="sr-only">Stocks in range. Choose one to see its tape.</caption>
          <thead>
            <tr className="t-eyebrow">
              <th scope="col">Stock</th>
              <th scope="col">Tokens</th>
              <th scope="col" className="num">Volume</th>
              <th scope="col" className="num">Off-hours</th>
              <th scope="col" className="num">Usual token premium</th>
              <th scope="col" className="num">Spread (IQR)</th>
              <th scope="col" className="num">Issuer savings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ st, v, o, spread, savings }) => (
              <tr key={st.u} className={st.u === selected ? "row--active" : undefined}>
                <td>
                  <span className="td-label t-eyebrow">Stock</span>
                  <button type="button" className="stock-link t-label" aria-pressed={st.u === selected} onClick={() => onPick(st.u)}>
                    {st.u}
                    {st.kind === "private" && <span className="muted"> · pre-IPO</span>}
                  </button>
                </td>
                <td>
                  <span className="td-label t-eyebrow">Tokens</span>
                  <span className="toks">
                    {st.tokens.map((t) => (
                      <Token key={t.sym} sym={t.sym} issuer={t.issuer} />
                    ))}
                  </span>
                </td>
                <td className="num">
                  <span className="td-label t-eyebrow">Volume</span>
                  <span className="t-data">{usd(v)}</span>
                </td>
                <td className="num">
                  <span className="td-label t-eyebrow">Off-hours</span>
                  <span className="t-data">{percent(v ? o / v : null)}</span>
                </td>
                <td className="num">
                  <span className="td-label t-eyebrow">Usual token premium</span>
                  <span className="t-data">{spread ? `${bps(spread.med)} bps` : "no fair value"}</span>
                </td>
                <td className="num">
                  <span className="td-label t-eyebrow">Spread</span>
                  <span className="t-data">{spread && spread.p75 != null && spread.p25 != null ? `${Math.round(spread.p75 - spread.p25)} bps` : "—"}</span>
                </td>
                <td className="num">
                  <span className="td-label t-eyebrow">Issuer savings</span>
                  {savings && savings.mean != null ? (
                    <span className="t-data">{bps(savings.mean - (savings.placeboMean ?? 0))} bps</span>
                  ) : (
                    <span className="t-data muted">{st.comparable.length > 1 ? "no data" : "one issuer"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-body muted">
        Premium: the usual token&apos;s price per share against fair value, median in bps. Spread: p25 to p75. Issuer savings: how much less the cheapest issuer&apos;s token cost, minus the placebo.{" "}
        <LearnMore href="/docs/markets#reading-the-numbers" />
      </p>
    </section>
  );
}

function StockDetail({
  tape,
  stock,
  scope,
  scopeLabel,
  win,
  ses,
  shown,
  onMore,
  onPick,
}: {
  tape: Tape;
  stock: TapeStock;
  scope: ReturnType<typeof scopeOf>;
  scopeLabel: string;
  win: WindowKey;
  ses: SessionKey;
  shown: number;
  onMore: () => void;
  onPick: (u: string) => void;
}) {
  const hasRef = stock.ref !== "none";
  const vols = stock.tokens.map((t) => volumeOf(tape, t, rowsIn(tape, t, scope)));
  const total = vols.reduce((a, v) => a + v.total, 0);
  const off = vols.reduce((a, v) => a + v.off, 0);
  const comparable = stock.comparable.length > 1;
  const savings = comparable ? issuerSavings(stock, scope) : null;
  const odd = hasRef ? stock.tokens.filter((t) => !t.units) : [];
  // 4 h medians over 30 days, 1 h over 7, 15 min over one; volume per day, hour, 15 min.
  const lineBin = win === "30" ? 16 : win === "7" ? 4 : 1;
  const barBin = win === "30" ? 96 : win === "7" ? 4 : 1;

  const sessions = SESSION_ORDER.filter((c) => SESSIONS.find((s) => s.key === ses)!.test(c));
  const dist = stock.tokens.flatMap((t) =>
    sessions
      .map((c) => {
        const rows = rowsIn(tape, t, scope, c);
        const s = premiumSpread(t, rows);
        return { t, c, n: rows.length, vol: volumeOf(tape, t, rows).total, s };
      })
      .filter((r) => r.n > 0),
  );
  const ends = dist.flatMap((r) => (r.s.n ? [r.s.p10!, r.s.p90!] : []));
  const lo = Math.min(0, ...ends) - 5;
  const hi = Math.max(0, ...ends) + 5;

  const rows = tapeRows(tape, stock, scope);

  return (
    <section className="tile" aria-labelledby="stock-title">
      <div className="tile__head">
        <h2 id="stock-title" className="t-heading-sm">
          {stock.u} tape.
        </h2>
        <div className="seg seg--wrap" role="group" aria-label="Stock">
          {tape.stocks.map((s) => (
            <button key={s.u} type="button" className="t-label" aria-pressed={s.u === stock.u} onClick={() => onPick(s.u)}>
              {s.u}
            </button>
          ))}
        </div>
      </div>

      <dl className="figures figures--4">
        <Figure label="Volume" value={usd(total)} note={scopeLabel} />
        <Figure label="Off-hours" value={percent(total ? off / total : null)} unit="of volume" />
        {comparable && savings ? (
          <>
            <Figure
              label="Choosing the issuer"
              value={savings.mean == null ? "—" : bps(savings.mean - (savings.placeboMean ?? 0))}
              unit="bps"
              note={savings.mean == null ? "no comparisons in range" : `${savings.mean.toFixed(1)} saved, ${savings.placeboMean?.toFixed(1)} placebo`}
            />
            <Figure label={`Cheaper than ${stock.naive}`} value={percent(cheaperThanNaive(stock, scope))} unit="of the time" note={`${stock.naive} is the usual pick`} />
          </>
        ) : hasRef ? (
          (() => {
            const naive = stock.tokens.find((t) => t.sym === stock.naive) ?? stock.tokens[0];
            const s = premiumSpread(naive, rowsIn(tape, naive, scope));
            return (
              <>
                <Figure label={`${naive.sym} premium`} value={bps(s.med)} unit="bps" note="median against fair value" />
                <Figure label="Spread (IQR)" value={s.p75 != null && s.p25 != null ? Math.round(s.p75 - s.p25) : "—"} unit="bps" note="p25 to p75" />
              </>
            );
          })()
        ) : (
          <Figure label="Fair value" value="None" note="pre-IPO: no listed stock or perp" />
        )}
      </dl>

      <div className="chart-block">
        <div className="tile__head">
          <h3 className="t-label">
            {hasRef ? "Premium over fair value, bps" : "Price per token, USD"} · median of {lineBin === 16 ? "4 h" : lineBin === 4 ? "1 h" : "15 min"}
          </h3>
          <Legend tokens={stock.tokens.filter((t) => !hasRef || t.units)} band />
        </div>
        <PremiumChart tape={tape} stock={{ ...stock, tokens: stock.tokens.filter((t) => !hasRef || t.units) }} scope={scope} size={lineBin} />
        {odd.length > 0 && (
          <p className="t-body muted">
            {odd.map((t) => t.sym).join(" and ")} {odd.length > 1 ? "are" : "is"} left out: one token is not one share of {stock.u}, so its premium doesn&apos;t compare. Its trades are in the tape.
          </p>
        )}
      </div>

      <div className="chart-block">
        <div className="tile__head">
          <h3 className="t-label">Volume per {barBin === 96 ? "day" : barBin === 4 ? "hour" : "15 minutes"}, USD</h3>
          <Legend tokens={stock.tokens} />
        </div>
        <VolumeChart tape={tape} stock={stock} scope={scope} size={barBin} />
      </div>

      <div>
        <div className="tile__head">
          <h3 className="t-label">By token and session</h3>
          <span className="t-eyebrow muted">p10 · p25–p75 · median · p90</span>
        </div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Premium by token and session">
          <table className="table table--dense markets-table">
            <caption className="sr-only">Premium distribution of each token in each session</caption>
            <thead>
              <tr className="t-eyebrow">
                <th scope="col">Token</th>
                <th scope="col">Session</th>
                <th scope="col" className="num">Trading intervals</th>
                <th scope="col" className="num">Volume</th>
                <th scope="col" className="num">Median</th>
                <th scope="col" className="num">Spread</th>
                <th scope="col">Premium distribution, bps</th>
              </tr>
            </thead>
            <tbody>
              {dist.map(({ t, c, n, vol, s }) => (
                <tr key={t.sym + c}>
                  <td>
                    <span className="td-label t-eyebrow">Token</span>
                    <Token sym={t.sym} issuer={t.issuer} />
                  </td>
                  <td>
                    <span className="td-label t-eyebrow">Session</span>
                    <span className="t-body">{SESSION_NAME[c]}</span>
                  </td>
                  <td className="num">
                    <span className="td-label t-eyebrow">Intervals</span>
                    <span className="t-data">{count(n)}</span>
                  </td>
                  <td className="num">
                    <span className="td-label t-eyebrow">Volume</span>
                    <span className="t-data">{usd(vol)}</span>
                  </td>
                  <td className="num">
                    <span className="td-label t-eyebrow">Median</span>
                    <span className="t-data">{s.n ? `${bps(s.med)} bps` : "—"}</span>
                  </td>
                  <td className="num">
                    <span className="td-label t-eyebrow">Spread</span>
                    <span className="t-data">{s.n && s.p75 != null && s.p25 != null ? `${Math.round(s.p75 - s.p25)} bps` : "—"}</span>
                  </td>
                  <td>
                    <span className="td-label t-eyebrow">Distribution</span>
                    {!hasRef ? (
                      <span className="t-data muted">no fair value</span>
                    ) : !t.units ? (
                      <span className="t-data muted">not one share</span>
                    ) : s.n ? (
                      <Strip q={[s.p10, s.p25, s.med, s.p75, s.p90]} lo={lo} hi={hi} color={issuerColor(t.issuer)} />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="tile__head">
          <h3 className="t-label">Tape</h3>
          <span className="t-eyebrow muted">
            {count(rows.length)} intervals · {scopeLabel}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="t-body muted">No trades in this range.</p>
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Tape">
            <table className="table table--dense markets-table">
              <caption className="sr-only">Every 15-minute interval this stock&apos;s tokens traded in, newest first</caption>
              <thead>
                <tr className="t-eyebrow">
                  <th scope="col">Time</th>
                  <th scope="col">Session</th>
                  <th scope="col">Token</th>
                  <th scope="col" className="num">Price per share</th>
                  <th scope="col" className="num">Fair value</th>
                  <th scope="col" className="num">Premium</th>
                  <th scope="col" className="num">Volume</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(({ token: t, k, bucket, cheapest }) => {
                  const premium = t.x[k] == null ? null : t.x[k]! / 10;
                  return (
                    <tr key={t.sym + bucket}>
                      <td>
                        <span className="td-label t-eyebrow">Time</span>
                        <span className="t-data nowrap">{dateTime.format(bucketTime(tape, bucket))}</span>
                      </td>
                      <td>
                        <span className="td-label t-eyebrow">Session</span>
                        <span className="t-body">{SESSION_NAME[tape.sess[bucket]]}</span>
                      </td>
                      <td>
                        <span className="td-label t-eyebrow">Token</span>
                        <span className="tok-cell">
                          <Token sym={t.sym} issuer={t.issuer} plain />
                          {cheapest && (
                            <span className="cheapest t-eyebrow" title="The cheapest token per share in this interval">
                              Cheapest
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="num">
                        <span className="td-label t-eyebrow">Price per share</span>
                        <span className="t-data">{price(t.p[k])}</span>
                      </td>
                      <td className="num">
                        <span className="td-label t-eyebrow">Fair value</span>
                        <span className="t-data">{hasRef ? price(t.f[k]) : "—"}</span>
                      </td>
                      <td className="num">
                        <span className="td-label t-eyebrow">Premium</span>
                        {premium == null ? (
                          <span className="t-data">—</span>
                        ) : (
                          <span className="premium">
                            <span className="t-data">{bps(premium, 1)} bps</span>
                            <span className="premium__bar" aria-hidden="true">
                              <i
                                style={{
                                  width: `${Math.min(1, Math.abs(premium) / 150) * 50}%`,
                                  [premium < 0 ? "right" : "left"]: "50%",
                                  background: premium < 0 ? "var(--div-neg)" : "var(--div-pos)",
                                }}
                              />
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <span className="td-label t-eyebrow">Volume</span>
                        <span className="t-data">{usd(t.v[k])}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown < rows.length && (
          <Button variant="secondary" onClick={onMore}>
            Show {Math.min(PAGE, rows.length - shown)} more
          </Button>
        )}
      </div>
    </section>
  );
}

function Legend({ tokens, band }: { tokens: TapeStock["tokens"]; band?: boolean }) {
  return (
    <span className="legend">
      {tokens.map((t) => (
        <span key={t.sym} className="legend__key t-body">
          <i className="legend__line" style={{ background: issuerColor(t.issuer) }} />
          {t.sym}
        </span>
      ))}
      {band && (
        <span className="legend__key t-body">
          <i className="legend__band" />
          Market hours
        </span>
      )}
    </span>
  );
}
