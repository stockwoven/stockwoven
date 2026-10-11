import type { MDXComponents } from "mdx/types";
import { Children, ReactNode, isValidElement } from "react";
import { WithTickers } from "@/components/ds";
import { slugify } from "@/lib/docs";

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement(c) ? text((c.props as { children?: ReactNode }).children) : ""))
    .join("");

/** Sets every sw ticker in running text as a Ticker (mono, accent-text prefix). */
const tickers = (node: ReactNode) =>
  Children.map(node, (c) => (typeof c === "string" ? <WithTickers>{c}</WithTickers> : c));

const heading = (Tag: "h2" | "h3", className: string) =>
  function Heading({ children }: { children?: ReactNode }) {
    const id = slugify(text(children));
    return (
      <Tag id={id} className={className}>
        <a href={`#${id}`} className="doc-anchor">
          {children}
        </a>
      </Tag>
    );
  };

const components: MDXComponents = {
  h1: ({ children }) => <h1 className="t-heading-md">{children}</h1>,
  h2: heading("h2", "t-heading-sm"),
  h3: heading("h3", "t-label"),
  p: ({ children }) => <p className="t-body">{tickers(children)}</p>,
  li: ({ children }) => <li className="t-body">{tickers(children)}</li>,
  td: ({ children }) => <td>{tickers(children)}</td>,
  strong: ({ children }) => <strong>{tickers(children)}</strong>,
  code: ({ children }) => <code className="t-data">{children}</code>,
  // Named by its first line, so several code blocks on a page stay distinguishable.
  pre: ({ children }) => (
    <pre className="doc-pre" tabIndex={0} role="region" aria-label={`Code: ${text(children).trim().split("\n")[0].slice(0, 60)}`}>
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="doc-table" tabIndex={0} role="region" aria-label="Table">
      <table className="t-body">{children}</table>
    </div>
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}
