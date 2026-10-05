import Link from "next/link";

/** The only way longer help appears in the app: a link to the right docs anchor. */
export function LearnMore({ href, label = "Learn more" }: { href: string; label?: string }) {
  return (
    <Link href={href} className="learn-more t-label">
      {label} →
    </Link>
  );
}
