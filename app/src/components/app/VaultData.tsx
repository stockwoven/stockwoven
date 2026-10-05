"use client";

import { ReactNode, createContext, useContext } from "react";
import { VaultData, useVaultData } from "@/lib/hooks";

type Ctx = { data: VaultData | null; error: string | null; refresh: () => void };

const VaultDataContext = createContext<Ctx>({ data: null, error: null, refresh: () => {} });

/** One poll of the pool and the wallet, shared by every app tab so switching tabs keeps the figures. */
export function VaultDataProvider({ children }: { children: ReactNode }) {
  const value = useVaultData();
  return <VaultDataContext.Provider value={value}>{children}</VaultDataContext.Provider>;
}

export const useVault = () => useContext(VaultDataContext);
