"use client";

import {
  ASSETS,
  HOLDERS_FEE_PCT,
  POOLS,
  SHARE_DECIMALS,
  VAULT,
  exposure,
  explorer,
  fromRaw,
  pct,
  poolValue,
  shortAddress,
  usd,
  usdOf,
  vaultValue,
} from "@/lib/stockwoven";
import { Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { useVault } from "./VaultData";

const TICKER = VAULT.stock;

function Figure({ label, value, unit, loading }: { label: React.ReactNode; value: React.ReactNode; unit?: React.ReactNode; loading: boolean }) {
  return (
    <div className="figure">
      <dt className="t-eyebrow muted">{label}</dt>
      <dd className="t-data-lg">
        {loading ? <span className="skeleton" style={{ width: "6ch" }} /> : value}
        {unit && <span className="t-data muted"> {unit}</span>}
      </dd>
    </div>
  );
}

const Skel = ({ w }: { w: number }) => <span className="skeleton" style={{ width: `${w}ch` }} />;

export function VaultStats() {
  const { data } = useVault();
  const state = data?.state;
  const loading = !state;
  const value = state ? vaultValue(state) : null;
  const exp = state ? exposure(state) : null;
  const sinceLaunch = value ? value.perShare / VAULT.launchUsdPerShare - 1 : 0;
  const pools = state && value ? POOLS.map((p, i) => ({ p, v: poolValue(state, value.px, i), w: state.weights[i] })) : [];
  const idle = state && value ? usdOf(state.reserves, value.px) : 0;

  return (
    <section className="tile" aria-labelledby="stats-title">
      <div className="tile__head">
        <h2 id="stats-title" className="t-heading-sm">
          <Ticker ticker={TICKER} /> vault.
        </h2>
        <a className="t-data muted" href={explorer(VAULT.vault)} target="_blank" rel="noreferrer">
          Vault {shortAddress(VAULT.vault)} ↗
        </a>
      </div>

      <dl className="figures">
        <Figure label={<>1 <Ticker ticker={TICKER} /></>} value={value && usd(value.perShare)} loading={loading} />
        <Figure label="Since launch" value={`${sinceLaunch >= 0 ? "+" : "−"}${Math.abs(sinceLaunch * 100).toFixed(2)}%`} loading={loading} />
        <Figure label="Vault value" value={value && usd(value.total, 0)} loading={loading} />
        <Figure label="Supply" value={state && fromRaw(state.supply, SHARE_DECIMALS, 2)} unit={<Ticker ticker={TICKER} />} loading={loading} />
      </dl>

      <div className="split-bar" aria-hidden="true">
        {pools.map(({ p, v }, i) => (
          <i key={p.label} className={i % 2 ? "key-swatch--b" : undefined} style={{ flex: v || 1 }} />
        ))}
        {idle > 0 && <i style={{ flex: idle, opacity: 0.35 }} />}
      </div>
      <dl className="kv">
        {(loading ? POOLS.map((p) => ({ p, v: 0, w: 0 })) : pools).map(({ p, v, w }, i) => (
          <div key={p.label}>
            <dt className="t-body">
              <span className={i % 2 ? "key-swatch key-swatch--b" : "key-swatch"} />
              {p.label} <span className="muted">· {p.kind.replace("-", "–")}</span>
            </dt>
            <dd>
              {loading ? (
                <Skel w={14} />
              ) : (
                <span className="t-data">
                  {usd(v, 0)} · target {(w / 100).toFixed(0)}%
                </span>
              )}
            </dd>
          </div>
        ))}
        <div>
          <dt className="t-body">Idle reserves</dt>
          <dd>{loading ? <Skel w={8} /> : <span className="t-data">{usd(idle, 0)}</span>}</dd>
        </div>
        <div>
          <dt className="t-body">Exposure</dt>
          <dd>
            {exp ? (
              <span className="t-data">
                SpaceX {pct(exp.stock)} · USDC {pct(exp.usdc)} · SOL {pct(exp.sol)}
              </span>
            ) : (
              <Skel w={22} />
            )}
          </dd>
        </div>
        <div>
          <dt className="t-body">Yield</dt>
          <dd className="t-data">
            Pool fees ({HOLDERS_FEE_PCT}% compounds) · rebalancing · arbitrage ({100 - VAULT.arbFeeBps / 100}% kept)
          </dd>
        </div>
        <div>
          <dt className="t-body">Issuers</dt>
          <dd className="t-data">
            {ASSETS.filter((a) => a.kind === "stock")
              .map((a) => `${a.symbol} · ${a.issuer}`)
              .join(", ")}
          </dd>
        </div>
      </dl>
      <LearnMore href="/docs/fees#where-the-yield-comes-from" />
    </section>
  );
}
