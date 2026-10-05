import type { Metadata } from "next";
import { ReactNode } from "react";
import { AppHeader } from "@/components/app/AppHeader";
import { Providers } from "@/components/app/Providers";
import { VaultDataProvider } from "@/components/app/VaultData";
import "./app.css";

export const metadata: Metadata = { title: "Stockwoven app · devnet" };

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <VaultDataProvider>
        <a href="#main" className="skip-link sw-btn sw-btn--secondary">
          Skip to content
        </a>
        <AppHeader />
        <main id="main" className="wrap wrap--wide app-main">
          {children}
        </main>
      </VaultDataProvider>
    </Providers>
  );
}
