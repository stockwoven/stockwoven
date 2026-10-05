import black from "@/design-system/stockwoven-design-system/assets/logos/stockwoven-mark-black.svg";
import gray from "@/design-system/stockwoven-design-system/assets/logos/stockwoven-mark-gray.svg";
import ivory from "@/design-system/stockwoven-design-system/assets/logos/stockwoven-mark-ivory.svg";
import purple from "@/design-system/stockwoven-design-system/assets/logos/stockwoven-mark-purple.svg";

const MARKS = { black, ivory, purple, gray };

export type MarkColor = keyof typeof MARKS;

/** The symbol from the design system's SVG files. Never below 24px. */
export function Mark({ color, size = 24, className }: { color: MarkColor; size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={MARKS[color].src} width={Math.max(size, 24)} height={Math.max(size, 24)} alt="" className={["sw-mark", className].filter(Boolean).join(" ")} />
  );
}

/** Symbol + wordmark. The type class sets the size of both. */
export function Lockup({ color, typeClass = "t-heading-sm" }: { color: MarkColor; typeClass?: string }) {
  return (
    <span className={`sw-lockup ${typeClass}`}>
      <Mark color={color} />
      Stockwoven
    </span>
  );
}
