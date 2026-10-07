"use client";

import Link from "next/link";
import { SHARE_DECIMALS, VAULT, exposure, fromRaw, pct, usd, vaultValue } from "@/lib/stockwoven";
import { TickerChip } from "../ds";
import { useVault } from "./VaultData";

const NOT_LIVE = [
  { ticker: "AAPL", stock: "Apple" },
  { ticker: "NVDA", stock: "NVIDIA" },
  { ticker: "TSLA", stock: "Tesla" },
];

const Skel = ({ w }: { w: number }) => <span className="skeleton" style={{ width: `${w}ch` }} />;

export function VaultTable() {
  const { data } = useVault();
  const state = data?.state;
  const exp = state ? exposure(state) : null;

  return (
    <div className="tile tile--flush">
      <table className="table table--dense">
        <caption className="sr-only">Vaults</caption>
        <thead>
          <tr className="t-eyebrow">
            <th scope="col">Vault</th>
            <th scope="col">Stock</th>
            <th scope="col">Exposure</th>
            <th scope="col" className="num">
              Value per token
            </th>
            <th scope="col" className="num">
              Supply
            </th>
            <th scope="col" className="num">
              Your balance
            </th>
            <th scope="col" className="num">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="row--active">
            <td>
              <span className="td-label t-eyebrow">Vault</span>
              <Link href="#vault-panel" className="ticker-link">
                <TickerChip ticker={VAULT.stock} />
              </Link>
            </td>
            <td>
              <span className="td-label t-eyebrow">Stock</span>
              <span className="t-body">SpaceX</span>
            </td>
            <td>
              <span className="td-label t-eyebrow">Exposure</span>
              {exp ? (
                <span className="t-data">
                  SpaceX {pct(exp.stock)} · USDC {pct(exp.usdc)} · SOL {pct(exp.sol)}
                </span>
              ) : (
                <Skel w={20} />
              )}
            </td>
            <td className="num">
              <span className="td-label t-eyebrow">Value per token</span>
              {state ? <span className="t-data">{usd(vaultValue(state).perShare)}</span> : <Skel w={12} />}
            </td>
            <td className="num">
              <span className="td-label t-eyebrow">Supply</span>
              {state ? <span className="t-data">{fromRaw(state.supply, SHARE_DECIMALS, 2)}</span> : <Skel w={8} />}
            </td>
            <td className="num">
              <span className="td-label t-eyebrow">Your balance</span>
              <span className="t-data">{data?.user ? fromRaw(data.user.shares, SHARE_DECIMALS, 4) : "—"}</span>
            </td>
            <td className="num">
              <span className="td-label t-eyebrow">Status</span>
              <span className="t-label">Live on devnet</span>
            </td>
          </tr>
          {NOT_LIVE.map((v) => (
            <tr key={v.ticker} className="row--muted">
              <td>
                <span className="td-label t-eyebrow">Vault</span>
                <TickerChip ticker={v.ticker} muted />
              </td>
              <td>
                <span className="td-label t-eyebrow">Stock</span>
                <span className="t-body muted">{v.stock}</span>
              </td>
              <td>
                <span className="td-label t-eyebrow">Exposure</span>
                <span className="t-data muted">—</span>
              </td>
              <td className="num">
                <span className="td-label t-eyebrow">Value per token</span>
                <span className="t-data muted">—</span>
              </td>
              <td className="num">
                <span className="td-label t-eyebrow">Supply</span>
                <span className="t-data muted">—</span>
              </td>
              <td className="num">
                <span className="td-label t-eyebrow">Your balance</span>
                <span className="t-data muted">—</span>
              </td>
              <td className="num">
                <span className="td-label t-eyebrow">Status</span>
                <span className="t-label muted">Not live yet</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
