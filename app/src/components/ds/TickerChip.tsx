/** A unified asset ticker: lowercase `sw` prefix in accent-text, the stock ticker in caps. */
export function TickerChip({ ticker, muted }: { ticker: string; muted?: boolean }) {
  return (
    <span className={muted ? "sw-chip sw-chip--muted" : "sw-chip"}>
      <span className="sw-prefix">sw</span>
      {ticker}
    </span>
  );
}

/** The same ticker inline in running text or figures, without the chip: mono, prefix in accent-text. */
export function Ticker({ ticker }: { ticker: string }) {
  return (
    <span className="ticker">
      <span className="accent-text">sw</span>
      {ticker}
    </span>
  );
}

/** Renders a string with every sw ticker in it set as a Ticker. */
export function WithTickers({ children }: { children: string }) {
  return (
    <>
      {children.split(/\b(sw[A-Z]+)\b/).map((part, i) => (i % 2 ? <Ticker key={i} ticker={part.slice(2)} /> : part))}
    </>
  );
}
