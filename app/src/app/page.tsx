import type { Metadata } from "next";
import { ButtonLink, Display, PoweredBy, Ticker, TickerChip, WeavePattern, WithTickers } from "@/components/ds";
import { LearnMore } from "@/components/LearnMore";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { LINKS } from "@/lib/links";
import { COMPOUNDING_FEE_BPS, TRADE_FEE_BPS } from "@/lib/stockwoven";
import "./landing.css";

export const metadata: Metadata = {
  title: "Stockwoven · One stock. One token.",
};

const ISSUERS = [
  { token: "INTCx", issuer: "xStocks" },
  { token: "INTC", issuer: "Backpack" },
];

const STEPS = [
  { title: "Deposit", text: "Hand over the vault's current mix of both issuers' tokens. Receive swINTC." },
  {
    title: "Hold",
    text: "Each swINTC is a pro-rata slice of the vault's liquidity in the pool. Its value is read from the pool account, not from an oracle.",
  },
  { title: "Redeem", text: "Burn swINTC and take your share of both tokens. The vault never pauses redemptions." },
];

// Of each conversion fee: cp-amm keeps 20%, the LP share splits by compounding_fee_bps.
const HOLDERS = (80 * COMPOUNDING_FEE_BPS) / 10_000;
const FEE_SPLIT = [
  { key: "holders", share: HOLDERS, label: "Compounds in the pool for swINTC holders", source: "compounding_fee_bps = 8000" },
  { key: "treasury", share: 80 - HOLDERS, label: "Claimable by the Stockwoven treasury", source: "harvest" },
  { key: "meteora", share: 20, label: "Meteora protocol fee", source: "fixed by cp-amm" },
];

const ASSETS = [
  { ticker: "INTC", stock: "Intel", issuers: "xStocks, Backpack (devnet mocks)", status: "Live on devnet", live: true },
  { ticker: "AAPL", stock: "Apple", issuers: "—", status: "Not live yet" },
  { ticker: "NVDA", stock: "NVIDIA", issuers: "—", status: "Not live yet" },
  { ticker: "TSLA", stock: "Tesla", issuers: "—", status: "Not live yet" },
];

const FAQ = [
  {
    q: "Where does swINTC's growth come from?",
    a: "From conversions between issuers. Every conversion through the Meteora pool leaves a fee in its reserves, so each swINTC is backed by a little more stock.",
    href: "/docs/fees",
  },
  {
    q: "Is there a price oracle?",
    a: "No. Meteora's own pool math prices deposits and redemptions, rounding against the user. Only the vault can add liquidity to its position, so tokens sent to the vault don't change what a share is worth.",
    href: "/docs/how-the-vault-works#share-accounting",
  },
  {
    q: "Can redemptions be paused?",
    a: "No. The admin can pause deposits during an issuer event (pause, freeze, depeg). Redemptions stay open.",
    href: "/docs/risks",
  },
  {
    q: "What can the issuers still do?",
    a: "Issuers keep their token powers: pause, freeze and permanent delegate can halt or drain the pool's vaults, and the vault can't prevent that.",
    href: "/docs/risks#issuer-powers-stay",
  },
  {
    q: "Can I deposit only one issuer's token?",
    a: "Yes. The vault swaps part of it on the Meteora pool and deposits both, for the conversion fee plus a 0.05% vault fee.",
    href: "/docs/deposit#single-token-deposits",
  },
  {
    q: "Is this on mainnet?",
    a: "No. Everything runs on Solana devnet with test tokens. Nothing here uses real funds.",
  },
];

export default function Landing() {
  return (
    <>
      <a href="#main" className="skip-link sw-btn sw-btn--secondary">
        Skip to content
      </a>
      <LandingHeader />
      <main id="main">
        <section className="hero theme-surface" data-theme="dark" aria-labelledby="hero-title">
          <div className="wrap hero__inner">
            <div className="hero__copy">
              <Display as="h1" id="hero-title" base="heading-md" up="display-lg">
                One stock. One token.
              </Display>
              <p className="t-body-lg hero__lead">
                Stockwoven puts every issuer&apos;s tokenized version of a stock into one Meteora pool and gives your customers a
                single token for it, like <Ticker ticker="INTC" />, that redeems for its share of the pool.
              </p>
              <div className="hero__actions">
                <ButtonLink href="/app">Launch app</ButtonLink>
                <ButtonLink variant="ghost" href="/docs/overview">
                  Read the docs
                </ButtonLink>
              </div>
              <p className="t-data muted">Solana devnet · Meteora DAMM v2 · test tokens only</p>
            </div>
          </div>
          <WeavePattern className="hero__art sw-weave--bleed" seed={3} fade={0.4} />
        </section>

        <section className="section" id="how" aria-labelledby="how-title">
          <div className="wrap">
            <div className="section__head">
              <h2 id="how-title" className="t-heading-md">
                How it works
              </h2>
              <p className="t-body-lg body">
                Intel is tokenized by xStocks and by Backpack, and each version trades in its own pool. The vault puts both into
                one pool and issues <Ticker ticker="INTC" />, one token backed by both.
              </p>
            </div>

            <figure className="flow" aria-label="Two issuer tokens go into one Meteora pool, which backs swINTC">
              <div className="flow__inputs">
                {ISSUERS.map((i) => (
                  <div key={i.token} className="flow__node">
                    <span className="t-data-lg">{i.token}</span>
                    <span className="t-body muted">Intel, by {i.issuer}</span>
                  </div>
                ))}
              </div>
              <FlowArrow />
              <div className="flow__node flow__node--pool">
                <span className="t-label">Meteora DAMM v2 pool</span>
                <span className="t-data muted">INTCx ↔ INTC · compounding fees</span>
              </div>
              <FlowArrow />
              <div className="flow__node flow__node--out">
                <span className="t-data-lg">
                  <Ticker ticker="INTC" />
                </span>
                <span className="t-body">Redeems for its share of both</span>
              </div>
            </figure>

            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <h3 className="t-heading-sm">
                    <span className="steps__n t-data muted">{i + 1}</span>
                    {s.title}
                  </h3>
                  <p className="t-body body">
                    <WithTickers>{s.text}</WithTickers>
                  </p>
                </li>
              ))}
            </ol>
            <LearnMore href="/docs/how-the-vault-works" label="How the vault works" />
          </div>
        </section>

        <section className="section" id="fees" aria-labelledby="fees-title">
          <div className="wrap split">
            <div className="section__head">
              <h2 id="fees-title" className="t-heading-md">
                Where the conversion fee goes
              </h2>
              <p className="t-body-lg body">
                Every conversion between issuers pays {(TRADE_FEE_BPS / 100).toFixed(2)}%. The pool runs in compounding mode,
                so most of that fee stays in its reserves and each <Ticker ticker="INTC" /> is backed by a little more stock.
              </p>
              <p className="t-body muted">Set in the program and readable on-chain. No yield is promised: it depends on conversion volume.</p>
              <LearnMore href="/docs/fees" label="Fees in detail" />
            </div>
            <div className="tile fees">
              <div className="tile__head">
                <span className="t-label">Each {(TRADE_FEE_BPS / 100).toFixed(2)}% conversion fee</span>
                <span className="t-data muted">trade_fee_bps = {TRADE_FEE_BPS}</span>
              </div>
              <div className="fee-bar" aria-hidden>
                {FEE_SPLIT.map((f) => (
                  <i key={f.key} className={`fee-bar__${f.key}`} style={{ flexGrow: f.share }} />
                ))}
              </div>
              <dl className="kv">
                {FEE_SPLIT.map((f) => (
                  <div key={f.key}>
                    <dt className="t-body">
                      <span className={`key-swatch fee-key__${f.key}`} aria-hidden />
                      <WithTickers>{f.label}</WithTickers>
                      <span className="t-data muted fees__source">{f.source}</span>
                    </dt>
                    <dd className="t-data-lg">{f.share}%</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <section className="section" id="assets" aria-labelledby="assets-title">
          <div className="wrap">
            <div className="section__head">
              <h2 id="assets-title" className="t-heading-md">
                Supported stocks
              </h2>
              <p className="t-body-lg body">One sw token per stock, backed by every issuer&apos;s version in the vault.</p>
            </div>
            <table className="table assets">
              <thead>
                <tr>
                  <th scope="col" className="t-label">Token</th>
                  <th scope="col" className="t-label">Stock</th>
                  <th scope="col" className="t-label">Issuers in the vault</th>
                  <th scope="col" className="t-label num">Status</th>
                </tr>
              </thead>
              <tbody>
                {ASSETS.map((a) => (
                  <tr key={a.ticker}>
                    <td>
                      <span className="td-label t-eyebrow">Token</span>
                      <TickerChip ticker={a.ticker} muted={!a.live} />
                    </td>
                    <td>
                      <span className="td-label t-eyebrow">Stock</span>
                      <span className={a.live ? "t-body" : "t-body muted"}>{a.stock}</span>
                    </td>
                    <td>
                      <span className="td-label t-eyebrow">Issuers</span>
                      <span className={a.live ? "t-body" : "t-body muted"}>{a.issuers}</span>
                    </td>
                    <td className="num">
                      <span className="td-label t-eyebrow">Status</span>
                      <span className={a.live ? "t-label" : "t-label muted"}>{a.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section" id="partners" aria-labelledby="partners-title">
          <div className="wrap">
            <div className="bento bento--2">
              <div className="tile partners">
                <h2 id="partners-title" className="t-heading-md">
                  For neobanks and fintechs
                </h2>
                <p className="t-body-lg body">
                  You own the customer and the app. Stockwoven is the layer underneath: your customers buy one token per stock,
                  and you don&apos;t have to pick an issuer.
                </p>
                <p className="t-body body">
                  Inside your app, Stockwoven appears only in the sw tickers and as a &ldquo;Powered by&rdquo; badge.
                </p>
                <div className="hero__actions">
                  <ButtonLink variant="secondary" href="/docs/for-partners">
                    Read the partner docs
                  </ButtonLink>
                  {LINKS.contact && (
                    <ButtonLink variant="ghost" href={LINKS.contact}>
                      Talk to us
                    </ButtonLink>
                  )}
                </div>
              </div>
              <figure className="tile partner-sample" aria-label="How Stockwoven appears in a partner app">
                <figcaption className="t-label muted">Example: an investment screen in your app</figcaption>
                <div className="partner-sample__row">
                  <TickerChip ticker="INTC" />
                  <span className="t-data">1,450.55 swINTC</span>
                </div>
                <p className="t-body body">Tickers keep the sw prefix and the monospaced face. Your colors on the chip.</p>
                <div className="partner-sample__badge">
                  <PoweredBy />
                </div>
                <p className="t-body muted">Once per flow, at the bottom of the investment screen.</p>
              </figure>
            </div>
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-title">
          <div className="wrap split">
            <div className="section__head">
              <h2 id="faq-title" className="t-heading-md">
                Questions
              </h2>
              <LearnMore href="/docs/faq" label="All questions in the docs" />
            </div>
            <div className="faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary className="t-label">
                    <WithTickers>{f.q}</WithTickers>
                  </summary>
                  <p className="t-body body">
                    <WithTickers>{f.a}</WithTickers>
                  </p>
                  {f.href && <LearnMore href={f.href} />}
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="cta theme-surface" data-theme="dark" aria-labelledby="cta-title">
          <div className="wrap hero__inner cta__inner">
            <div className="hero__copy">
              <h2 id="cta-title" className="t-heading-md">
                Try the vault on devnet
              </h2>
              <p className="t-body-lg hero__lead">
                Connect a Solana wallet, get test tokens from the faucet, then deposit, convert and redeem. Nothing uses real
                funds.
              </p>
              <div className="hero__actions">
                <ButtonLink href="/app">Launch app</ButtonLink>
                <ButtonLink variant="ghost" href="/docs/overview">
                  Read the docs
                </ButtonLink>
              </div>
            </div>
          </div>
          <WeavePattern className="hero__art sw-weave--bleed" seed={11} fade={0.5} />
        </section>
      </main>
      <LandingFooter />
    </>
  );
}

/** A 2px square-cap arrow: right from 768px, down below it. */
function FlowArrow() {
  return (
    <svg className="flow__arrow" viewBox="0 0 24 24" width="24" height="24" aria-hidden>
      <path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}
