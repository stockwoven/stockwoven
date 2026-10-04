import { VaultData } from "@/lib/hooks";
import { COMPOUNDING_FEE_BPS, SHARE_DECIMALS, TRADE_FEE_BPS, VAULT, fromRaw, navPerShare, stockValue } from "@/lib/stockwoven";

export function Hero({ data }: { data: VaultData | null }) {
  const nav = data ? navPerShare(data.pool) : null;
  const valueA = data ? Number(data.pool.reserveA) / 10 ** VAULT.decimalsA : 0;
  const valueB = data ? Number(data.pool.reserveB) / 10 ** VAULT.decimalsB : 0;
  const holdersPct = (80 * COMPOUNDING_FEE_BPS) / 10_000;

  return (
    <section className="hero">
      <div>
        <p className="eyebrow">Intel · two issuers · one token</p>
        <p className="nav">
          1 swINTC = <span>{nav ? nav.toFixed(6) : "…"}</span>
          <br />
          shares of Intel
        </p>
        <p className="lead">
          {nav
            ? `${nav >= 1 ? "+" : ""}${((nav - 1) * 100).toFixed(4)}% since launch, earned from conversions between issuers. `
            : ""}
          Every conversion through the Meteora pool leaves a fee in its reserves, so each swINTC is backed by a little more
          stock.
        </p>
      </div>
      <div className="stats">
        <div className="stat" style={{ gridColumn: "1 / -1" }}>
          <span className="eyebrow">Pool reserves (Meteora DAMM v2)</span>
          <b>
            {valueA.toLocaleString("en-US", { maximumFractionDigits: 3 })} mINTCx ·{" "}
            {valueB.toLocaleString("en-US", { maximumFractionDigits: 3 })} mINTC
          </b>
          <div className="bar" aria-hidden>
            <i style={{ flex: valueA || 1 }} />
            <i style={{ flex: valueB || 1 }} />
          </div>
        </div>
        <div className="stat">
          <span className="eyebrow">swINTC supply</span>
          <b>{data ? fromRaw(data.shareSupply, SHARE_DECIMALS) : "…"}</b>
        </div>
        <div className="stat">
          <span className="eyebrow">Stock in pool</span>
          <b>{data ? stockValue(data.pool.reserveA, data.pool.reserveB).toFixed(3) : "…"}</b>
        </div>
        <div className="stat" style={{ gridColumn: "1 / -1" }}>
          <span className="eyebrow">Each {TRADE_FEE_BPS / 100}% conversion fee</span>
          <b>
            {holdersPct}% holders · {80 - holdersPct}% treasury · 20% Meteora
          </b>
        </div>
      </div>
    </section>
  );
}
