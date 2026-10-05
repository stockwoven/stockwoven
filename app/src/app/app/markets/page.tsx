import type { Metadata } from "next";
import { Markets } from "@/components/markets/Markets";
import "./markets.css";

export const metadata: Metadata = { title: "Markets · Stockwoven" };

export default function MarketsPage() {
  return (
    <>
      <h1 className="t-heading-sm app-title">Markets.</h1>
      <Markets />
    </>
  );
}
