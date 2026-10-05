"use client";

import { COMPOUNDING_FEE_BPS, SHARE_DECIMALS, TRADE_FEE_BPS, VAULT, explorer, fromRaw, navPerShare, shortAddress, stockValue } from "@/lib/stockwoven";
import { Ticker } from "../ds";
import { LearnMore } from "../LearnMore";
import { useVault } from "./VaultData";

const HOLDERS = (80 * COMPOUNDING_FEE_BPS) / 10_000;
const fmt = (v: number, digits = 2) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

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

export function VaultStats() {
  const { data } = useVault();
  const loading = !data;
  const nav = data ? navPerShare(data.pool) : 1;
  const a = data ? Number(data.pool.reserveA) / 10 ** VAULT.decimalsA : 0;
  const b = data ? Number(data.pool.reserveB) / 10 ** VAULT.decimalsB : 0;

  return (
    <section className="tile" aria-labelledby="stats-title">
      <div className="tile__head">
        <h2 id="stats-title" className="t-heading-sm">
          <Ticker ticker="INTC" /> vault.
        </h2>
        <a className="t-data muted" href={explorer(VAULT.pool)} target="_blank" rel="noreferrer">
          Pool {shortAddress(VAULT.pool)} ↗
        </a>
      </div>

      <dl className="figures">
        <Figure label="Backing per token" value={nav.toFixed(6)} unit="INTC" loading={loading} />
        <Figure
          label="Since launch"
          value={`${nav >= 1 ? "+" : "−"}${Math.abs((nav - 1) * 100).toFixed(4)}%`}
          loading={loading}
        />
        <Figure label="Stock in pool" value={data && fmt(stockValue(data.pool.reserveA, data.pool.reserveB))} unit="INTC" loading={loading} />
        <Figure label="Supply" value={data && fmt(Number(data.shareSupply) / 10 ** SHARE_DECIMALS)} unit={<Ticker ticker="INTC" />} loading={loading} />
      </dl>

      <div className="split-bar" aria-hidden="true">
        <i style={{ flex: a || 1 }} />
        <i style={{ flex: b || 1 }} />
      </div>
      <dl className="kv">
        <div>
          <dt className="t-body">
            <span className="key-swatch" />
            mINTCx <span className="muted">· xStocks, mock</span>
          </dt>
          <dd>{loading ? <span className="skeleton" style={{ width: "8ch" }} /> : <span className="t-data">{fmt(a, 3)} mINTCx</span>}</dd>
        </div>
        <div>
          <dt className="t-body">
            <span className="key-swatch key-swatch--b" />
            mINTC <span className="muted">· Backpack, mock</span>
          </dt>
          <dd>{loading ? <span className="skeleton" style={{ width: "8ch" }} /> : <span className="t-data">{fmt(b, 3)} mINTC</span>}</dd>
        </div>
        <div>
          <dt className="t-body">Conversion fee</dt>
          <dd className="t-data">
            {(TRADE_FEE_BPS / 100).toFixed(2)}% · {HOLDERS}% compounds for holders
          </dd>
        </div>
      </dl>
      <LearnMore href="/docs/fees#where-each-conversion-fee-goes" />
    </section>
  );
}
