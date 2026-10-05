"use client";

import { ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletPickerProvider } from "@/components/WalletPicker";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

// Wallets that implement the Wallet Standard (Phantom, Solflare, Backpack...) are detected
// automatically, so no adapters are listed.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletPickerProvider>{children}</WalletPickerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
