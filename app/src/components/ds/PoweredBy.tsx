import { Mark } from "./Logo";

/** For partner products only: ink on light screens, ivory on dark, gray to blend in. */
export function PoweredBy({ color = "black" }: { color?: "black" | "ivory" | "gray" }) {
  return (
    <span className="sw-powered">
      <Mark color={color} />
      Powered by <b>Stockwoven</b>
    </span>
  );
}
