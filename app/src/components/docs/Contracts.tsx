import { CP_AMM, VAULT, explorer } from "@/lib/stockwoven";

const CONTRACTS = [
  { name: "Stockwoven program", address: VAULT.program },
  { name: "Vault", address: VAULT.vault },
  { name: "Pool · Meteora DAMM v2", address: VAULT.pool },
  { name: "swINTC mint", address: VAULT.shareMint },
  { name: "Treasury", address: VAULT.treasury },
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
