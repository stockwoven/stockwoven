import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DOCS } from "@/lib/docs";

export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const doc = DOCS.find((d) => d.slug === slug);
  return { title: doc ? `${doc.title} · Stockwoven docs` : "Stockwoven docs" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const i = DOCS.findIndex((d) => d.slug === slug);
  if (i < 0) notFound();
  const { default: Content } = await import(`@/content/docs/${slug}.mdx`);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];

  return (
    <>
      <article className="doc-article">
        <Content />
      </article>
      <nav className="doc-pager" aria-label="Previous and next page">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} rel="prev">
            <span className="t-eyebrow muted">Previous</span>
            <span className="t-label">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/docs/${next.slug}`} rel="next" className="doc-pager__next">
            <span className="t-eyebrow muted">Next</span>
            <span className="t-label">{next.title}</span>
          </Link>
        ) : (
          <Link href="/app" className="doc-pager__next">
            <span className="t-eyebrow muted">Done reading</span>
            <span className="t-label">Open the app</span>
          </Link>
        )}
      </nav>
    </>
  );
}
