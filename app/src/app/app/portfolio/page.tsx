"use client";

import { ActivityTable } from "@/components/app/ActivityTable";
import { HoldPanel } from "@/components/app/HoldPanel";
import { RpcBanner } from "@/components/app/RpcBanner";
import { useActivity } from "@/lib/hooks";

export default function PortfolioPage() {
  const activity = useActivity();
  return (
    <>
      <h1 className="t-heading-sm app-title">Portfolio.</h1>
      <RpcBanner />
      <div className="app-split app-split--wide-left">
        <HoldPanel />
        <ActivityTable {...activity} />
      </div>
    </>
  );
}
