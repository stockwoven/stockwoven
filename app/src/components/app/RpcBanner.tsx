"use client";

import { Button } from "../ds";
import { useVault } from "./VaultData";

export function RpcBanner() {
  const { error, refresh } = useVault();
  if (!error) return null;
  return (
    <div className="banner" role="alert">
      <div>
        <p className="t-label">Devnet&apos;s RPC did not answer. Retrying every ten seconds.</p>
        <details className="t-data">
          <summary>Details</summary>
          {error}
        </details>
      </div>
      <Button variant="ghost" onClick={refresh}>
        Retry now
      </Button>
    </div>
  );
}
