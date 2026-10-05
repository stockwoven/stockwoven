import Link from "next/link";
import { LINKS } from "@/lib/links";
import { Lockup } from "../ds";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/app", label: "Launch app" },
      { href: "/app/portfolio", label: "Portfolio" },
      { href: "/docs/supported-assets", label: "Assets" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs/overview", label: "Overview" },
      { href: "/docs/how-the-vault-works", label: "How the vault works" },
      { href: "/docs/for-partners", label: "For partners" },
    ],
  },
  {
    title: "Community",
    links: [
      { href: LINKS.github, label: "GitHub" },
      { href: LINKS.x, label: "X" },
      { href: LINKS.contact, label: "Contact" },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer className="footer theme-surface" data-theme="dark">
      <div className="wrap footer__grid">
        <div className="footer__note">
          <Lockup color="ivory" />
          <p className="t-body body">
            Built on Meteora DAMM v2 with compounding fees. Test tokens stand in for INTCx from xStocks and INTC from Backpack.
          </p>
          <p className="t-body muted">Solana devnet only. Nothing here uses real funds.</p>
        </div>
        <div className="footer__links">
          {COLUMNS.map((c) => ({ ...c, links: c.links.filter((l): l is { href: string; label: string } => !!l.href) }))
            .filter((c) => c.links.length > 0)
            .map((c) => (
            <nav key={c.title} aria-label={c.title}>
              <p className="t-eyebrow muted">{c.title}</p>
              <ul>
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href} className="t-body">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
    </footer>
  );
}
