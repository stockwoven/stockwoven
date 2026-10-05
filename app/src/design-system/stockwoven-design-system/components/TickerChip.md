# TickerChip

A unified asset's ticker: the lowercase `sw` prefix plus the stock ticker, in JetBrains Mono.

- Markup: `<span class="sw-chip"><span class="sw-prefix">sw</span>AAPL</span>`.
- The prefix uses `accent-text`; the ticker uses `text`.
- In a partner app the partner may restyle the chip's fill and border, but keeps the `sw` prefix and the monospaced face.
- The consumer provides the ticker.
