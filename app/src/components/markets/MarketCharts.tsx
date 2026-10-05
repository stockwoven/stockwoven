"use client";

import { PointerEvent, ReactNode, useEffect, useRef, useState } from "react";
import { SESSION_NAME, Scope, Tape, TapeStock, TapeToken, binned, bucketTime, quantile } from "@/lib/tape";
import { bps, dateTime, day, issuerColor, time, usd } from "./format";

const M = { t: 10, r: 14, b: 26, l: 56 };

/** Width of an element, kept current. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function niceTicks(lo: number, hi: number, count = 5) {
  const span = hi - lo || 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(span / count)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** Regular-session bands and local-time ticks shared by both charts. */
function TimeFrame({ tape, scope, x, height }: { tape: Tape; scope: Scope; x: (b: number) => number; height: number }) {
  const bands: ReactNode[] = [];
  let run = -1;
  for (let b = scope.b0; b <= scope.b1; b++) {
    const regular = b < scope.b1 && tape.sess[b] === "R";
    if (regular && run < 0) run = b;
    if (!regular && run >= 0) {
      bands.push(<rect key={run} x={x(run)} y={M.t} width={Math.max(1, x(b) - x(run))} height={height - M.t - M.b} style={{ fill: "var(--band)" }} />);
      run = -1;
    }
  }
  const days = (scope.b1 - scope.b0) / 96;
  const ticks: ReactNode[] = [];
  // Local midnights (every 3 h on one day), thinned so labels keep 56px apart at any width.
  let lastX = -Infinity;
  for (let b = scope.b0; b <= scope.b1; b++) {
    const d = bucketTime(tape, b);
    const tick = days > 3 ? d.getHours() === 0 && d.getMinutes() === 0 : d.getMinutes() === 0 && d.getHours() % 3 === 0;
    if (!tick || x(b) - lastX < 56) continue;
    lastX = x(b);
    ticks.push(
      <g key={b}>
        <line x1={x(b)} x2={x(b)} y1={height - M.b} y2={height - M.b + 4} style={{ stroke: "var(--line)" }} />
        <text x={x(b)} y={height - M.b + 16} textAnchor="middle">
          {days > 3 ? day.format(d) : time.format(d)}
        </text>
      </g>,
    );
  }
  return (
    <>
      {bands}
      {ticks}
    </>
  );
}

function Tooltip({ at, children }: { at: { x: number; y: number; width: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!at || !ref.current) return;
    setLeft(Math.min(Math.max(0, at.x + 14), at.width - ref.current.offsetWidth));
  }, [at]);
  if (!at) return null;
  return (
    <div ref={ref} className="chart-tip" style={{ left, top: Math.max(0, at.y - 10) }} role="status">
      {children}
    </div>
  );
}

/** Premium over fair value per token (or price, without a fair value), as the median of each bin. */
export function PremiumChart({ tape, stock, scope, size }: { tape: Tape; stock: TapeStock; scope: Scope; size: number }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<{ j: number; y: number } | null>(null);
  const hasRef = stock.ref !== "none";
  const value = (t: TapeToken) => (k: number) => {
    const v = hasRef ? t.x[k] : t.p[k];
    return v == null ? null : hasRef ? v / 10 : v / 100;
  };
  const series = stock.tokens
    .map((t) => ({ t, bins: binned(t, scope, size, value(t)) }))
    .filter((s) => s.bins.median.some((v) => v != null));

  const W = Math.max(300, width);
  const H = 300;
  const x = (b: number) => M.l + ((b - scope.b0) / (scope.b1 - scope.b0)) * (W - M.l - M.r);
  const all = series.flatMap((s) => s.bins.median.filter((v): v is number => v != null)).sort((a, b) => a - b);
  // Clip to the 1st–99th percentile so one bad print doesn't flatten everything else.
  let lo = quantile(all, 0.01) ?? 0;
  let hi = quantile(all, 0.99) ?? 1;
  if (hasRef) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const pad = (hi - lo) * 0.08 || 1;
  const ticks = niceTicks(lo - pad, hi + pad);
  lo = Math.min(lo - pad, ticks[0]);
  hi = Math.max(hi + pad, ticks[ticks.length - 1]);
  const y = (v: number) => M.t + (1 - (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (H - M.t - M.b);
  const nb = series[0]?.bins.nb ?? 0;
  const gap = size >= 16 ? 2 : 4; // break the line across longer silences
  const center = (j: number) => x(scope.b0 + (j + 0.5) * size);

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    const j = Math.min(nb - 1, Math.max(0, Math.floor(((sx - M.l) / (W - M.l - M.r)) * nb)));
    setHover({ j, y: e.clientY - r.top });
  };

  return (
    <div className="chart" ref={ref}>
      {!series.length ? (
        <p className="t-body muted chart-empty">No trades in this range.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${hasRef ? "Premium over fair value" : "Price per token"} of ${series.map((s) => s.t.sym).join(", ")}. Every value is in the tape below.`}>
          <TimeFrame tape={tape} scope={scope} x={x} height={H} />
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} style={{ stroke: v === 0 && hasRef ? "var(--text-subtle)" : "var(--grid)" }} />
              <text x={M.l - 8} y={y(v) + 3.5} textAnchor="end">
                {hasRef ? bps(v) : `$${v.toLocaleString("en-US")}`}
              </text>
            </g>
          ))}
          {series.map(({ t, bins }) => {
            let d = "";
            let last = -99;
            bins.median.forEach((v, j) => {
              if (v == null) return;
              d += `${j - last > gap ? "M" : "L"}${center(j).toFixed(1)},${y(v).toFixed(1)}`;
              last = j;
            });
            return <path key={t.sym} d={d} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: issuerColor(t.issuer) }} />;
          })}
          {hover && (
            <>
              <line x1={center(hover.j)} x2={center(hover.j)} y1={M.t} y2={H - M.b} style={{ stroke: "var(--text-subtle)" }} />
              {series.map(({ t, bins }) => {
                const v = bins.median[hover.j];
                return v == null ? null : <circle key={t.sym} cx={center(hover.j)} cy={y(v)} r={4} strokeWidth={2} style={{ fill: issuerColor(t.issuer), stroke: "var(--surface)" }} />;
              })}
            </>
          )}
          <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      <Tooltip at={hover && { x: (center(hover.j) / W) * width, y: hover.y, width }}>
        {hover && (
          <>
            <div className="t-eyebrow muted">
              {dateTime.format(bucketTime(tape, scope.b0 + hover.j * size))} · {SESSION_NAME[tape.sess[scope.b0 + hover.j * size]]}
            </div>
            {series.map(({ t, bins }) => {
              const v = bins.median[hover.j];
              return (
                <div key={t.sym} className="chart-tip__row">
                  <span>
                    <i style={{ background: issuerColor(t.issuer) }} />
                    {t.sym}
                  </span>
                  <b className="t-data">{v == null ? "no trades" : hasRef ? `${bps(v, 1)} bps` : `$${v.toFixed(2)}`}</b>
                </div>
              );
            })}
          </>
        )}
      </Tooltip>
    </div>
  );
}

/** Volume per bin, stacked by token. */
export function VolumeChart({ tape, stock, scope, size }: { tape: Tape; stock: TapeStock; scope: Scope; size: number }) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<{ j: number; x: number; y: number } | null>(null);
  const series = stock.tokens
    .map((t) => ({ t, bins: binned(t, scope, size, () => null) }))
    .filter((s) => s.bins.volume.some((v) => v > 0));
  const W = Math.max(300, width);
  const H = 190;
  const nb = series[0]?.bins.nb ?? 0;
  const x = (b: number) => M.l + ((b - scope.b0) / (scope.b1 - scope.b0)) * (W - M.l - M.r);
  const totals = Array.from({ length: nb }, (_, j) => series.reduce((a, s) => a + s.bins.volume[j], 0));
  const ticks = niceTicks(0, Math.max(1, ...totals), 4);
  const top = Math.max(...totals, ticks[ticks.length - 1]);
  const y = (v: number) => M.t + (1 - v / top) * (H - M.t - M.b);
  const slot = (W - M.l - M.r) / Math.max(1, nb);
  const bar = Math.max(1, Math.min(24, slot - 2));

  return (
    <div className="chart" ref={ref}>
      {!series.length ? (
        <p className="t-body muted chart-empty">No volume in this range.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Volume of ${series.map((s) => s.t.sym).join(", ")}. Every value is in the tape below.`}>
          <TimeFrame tape={tape} scope={scope} x={x} height={H} />
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} style={{ stroke: v === 0 ? "var(--line)" : "var(--grid)" }} />
              <text x={M.l - 8} y={y(v) + 3.5} textAnchor="end">
                {usd(v)}
              </text>
            </g>
          ))}
          {totals.map((total, j) => {
            if (!total) return null;
            let acc = 0;
            const left = M.l + (j + 0.5) * slot - bar / 2;
            const visible = series.filter((s) => s.bins.volume[j] > 0);
            return (
              <g key={j} style={{ opacity: hover && hover.j !== j ? 0.55 : 1 }}>
                {visible.map((s, n) => {
                  const v = s.bins.volume[j];
                  const y1 = y(acc);
                  const y2 = y(acc + v);
                  const h = Math.max(0, y1 - y2 - (acc > 0 ? 2 : 0)); // 2px surface gap between segments
                  acc += v;
                  const r = n === visible.length - 1 && bar >= 6 ? Math.min(4, bar / 2, h) : 0;
                  // rounded data end, square at the baseline
                  const d = r
                    ? `M${left},${y2 + h}V${y2 + r}Q${left},${y2} ${left + r},${y2}H${left + bar - r}Q${left + bar},${y2} ${left + bar},${y2 + r}V${y2 + h}Z`
                    : `M${left},${y2}h${bar}v${h}h${-bar}Z`;
                  return <path key={s.t.sym} d={d} style={{ fill: issuerColor(s.t.issuer) }} />;
                })}
                <rect
                  x={M.l + j * slot}
                  y={M.t}
                  width={slot}
                  height={H - M.t - M.b}
                  fill="transparent"
                  onPointerMove={(e) => {
                    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                    setHover({ j, x: e.clientX - r.left, y: e.clientY - r.top });
                  }}
                  onPointerLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip at={hover && { x: hover.x, y: hover.y, width }}>
        {hover && (
          <>
            <div className="t-eyebrow muted">
              {size >= 96 ? day.format(bucketTime(tape, scope.b0 + hover.j * size)) : dateTime.format(bucketTime(tape, scope.b0 + hover.j * size))}
            </div>
            {series.map(({ t, bins }) => (
              <div key={t.sym} className="chart-tip__row">
                <span>
                  <i style={{ background: issuerColor(t.issuer) }} />
                  {t.sym}
                </span>
                <b className="t-data">{usd(bins.volume[hover.j])}</b>
              </div>
            ))}
            <div className="chart-tip__row">
              <span>Total</span>
              <b className="t-data">{usd(totals[hover.j])}</b>
            </div>
          </>
        )}
      </Tooltip>
    </div>
  );
}
