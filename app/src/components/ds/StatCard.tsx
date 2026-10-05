import { ReactNode } from "react";

/** One big figure with its unit, a label and a source. `inverse` marks the one that matters most in a row. */
export function StatCard({
  value,
  unit,
  label,
  source,
  inverse,
  loading,
  className,
}: {
  value: ReactNode;
  unit?: ReactNode;
  label: ReactNode;
  source: ReactNode;
  inverse?: boolean;
  loading?: boolean;
  className?: string;
}) {
  return (
    <div className={["sw-stat", inverse && "sw-stat--inverse", className].filter(Boolean).join(" ")}>
      <span className="sw-stat__value">
        {loading ? <span className="skeleton" style={{ width: "4ch" }} aria-label="Loading" /> : value}
        {unit && !loading && <span className="sw-stat__unit t-data">{unit}</span>}
      </span>
      <span className="sw-stat__label">{label}</span>
      <span className="sw-stat__source">{source}</span>
    </div>
  );
}
