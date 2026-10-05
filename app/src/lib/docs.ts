export const DOCS = [
  { slug: "overview", title: "Overview" },
  { slug: "how-the-vault-works", title: "How the vault works" },
  { slug: "deposit", title: "Deposit" },
  { slug: "hold", title: "Hold" },
  { slug: "redeem", title: "Redeem" },
  { slug: "fees", title: "Fees" },
  { slug: "supported-assets", title: "Supported issuers & assets" },
  { slug: "risks", title: "Risks & protections" },
  { slug: "for-partners", title: "For partners" },
  { slug: "faq", title: "FAQ" },
  { slug: "glossary", title: "Glossary" },
] as const;

export type DocSlug = (typeof DOCS)[number]["slug"];

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export type SearchEntry = { slug: string; page: string; heading?: string; anchor?: string; text: string };
