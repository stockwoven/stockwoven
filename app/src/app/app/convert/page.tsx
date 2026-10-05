import { ConvertPanel } from "@/components/app/Panels";
import { RpcBanner } from "@/components/app/RpcBanner";
import { VaultStats } from "@/components/app/VaultStats";

export default function ConvertPage() {
  return (
    <>
      <h1 className="t-heading-sm app-title">Convert.</h1>
      <RpcBanner />
      <div className="app-split">
        <ConvertPanel />
        <VaultStats />
      </div>
    </>
  );
}
