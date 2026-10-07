import { ASSETS, CP_AMM, MARKET_POOLS, POOLS, VAULT, explorer } from "@/lib/stockwoven";

const CONTRACTS = [
  { name: "Stockwoven program", address: VAULT.program },
  { name: "Vault", address: VAULT.vault },
  { name: `sw${VAULT.stock} mint`, address: VAULT.shareMint },
  ...POOLS.map((p) => ({ name: `Vault pool · ${p.label}`, address: p.pool })),
  ...MARKET_POOLS.map((p) => ({ name: `Market pool · ${p.label.replace(" (market)", "")}`, address: p.pool })),
  ...ASSETS.map((a) => ({ name: `${a.symbol} mint${a.issuer ? ` · ${a.issuer}, mock` : a.kind === "usdc" ? " · test token" : ""}`, address: a.mint })),
  { name: "Treasury", address: VAULT.treasury },
  { name: "Keeper", address: VAULT.keeper },
  ...(VAULT.lookupTable ? [{ name: "Address lookup table", address: VAULT.lookupTable }] : []),
  { name: "DAMM v2 program", address: CP_AMM },
];

export function Contracts() {
  return (
    <div className="doc-table">
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Address (devnet)</th>
          </tr>
        </thead>
        <tbody>
          {CONTRACTS.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>
                <a className="t-data doc-address" href={explorer(c.address)} target="_blank" rel="noreferrer">
                  {c.address.toBase58()}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
