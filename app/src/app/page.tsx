"use client";

import dynamic from "next/dynamic";
import { ConvertCard } from "@/components/ConvertCard";
import { Hero } from "@/components/Hero";
import { PositionCard } from "@/components/PositionCard";
import { VaultCard } from "@/components/VaultCard";
import { useVaultData } from "@/lib/hooks";
import { CP_AMM, VAULT, explorer } from "@/lib/stockwoven";

// The wallet button reads browser-only wallet state, so it renders on the client only.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

export default function Home() {
  const { data, error, refresh } = useVaultData();

  return (
    <main className="page">
      <header className="header">
        <div className="brand">
          <h1>Stockwoven</h1>
          <span className="pill accent">devnet</span>
          <span className="pill">One stock. One token.</span>
        </div>
        <WalletMultiButton />
      </header>

      {error && <div className="status err">Could not read the pool: {error}</div>}
      <Hero data={data} />

      <div className="grid">
        <VaultCard data={data} refresh={refresh} />
        <ConvertCard data={data} refresh={refresh} />
        <PositionCard data={data} refresh={refresh} />
      </div>

      <footer className="footer">
        <span>Built on Meteora DAMM v2 · compounding fees · test tokens stand in for INTCx and Backpack INTC</span>
        <nav>
          <a href={explorer(VAULT.pool)} target="_blank" rel="noreferrer">Pool</a>
          <a href={explorer(VAULT.vault)} target="_blank" rel="noreferrer">Vault</a>
          <a href={explorer(VAULT.program)} target="_blank" rel="noreferrer">Program</a>
          <a href={explorer(VAULT.shareMint)} target="_blank" rel="noreferrer">swINTC mint</a>
          <a href={explorer(CP_AMM)} target="_blank" rel="noreferrer">DAMM v2</a>
        </nav>
      </footer>
    </main>
  );
}
