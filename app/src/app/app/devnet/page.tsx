import { FaucetPanel, HarvestPanel } from "@/components/app/Panels";

export default function DevnetPage() {
  return (
    <>
      <h1 className="t-heading-sm app-title">Devnet tools.</h1>
      <div className="bento bento--2">
        <FaucetPanel />
        <HarvestPanel />
      </div>
    </>
  );
}
