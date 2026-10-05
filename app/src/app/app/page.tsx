import { RpcBanner } from "@/components/app/RpcBanner";
import { VaultPanel } from "@/components/app/VaultPanel";
import { VaultStats } from "@/components/app/VaultStats";
import { VaultTable } from "@/components/app/VaultTable";

export default function VaultsPage() {
  return (
    <>
      <h1 className="t-heading-sm app-title">Vaults.</h1>
      <RpcBanner />
      <VaultTable />
      <div className="app-split">
        <VaultPanel />
        <VaultStats />
      </div>
    </>
  );
}
