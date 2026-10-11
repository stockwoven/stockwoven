import type { Metadata } from "next";
import { ButtonLink, Display, PoweredBy, Ticker, TickerChip, WeavePattern, WithTickers } from "@/components/ds";
import { LearnMore } from "@/components/LearnMore";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { LINKS } from "@/lib/links";
import "./landing.css";

export const metadata: Metadata = {
  title: "Stockwoven · One stock. One token.",
};

const INPUTS = [
  { token: "SPCXx", note: "SpaceX, by xStocks" },
  { token: "SPCX", note: "SpaceX, by Backpack" },
  { token: "SPCXon", note: "SpaceX, by Ondo" },
  { token: "USDC · SOL", note: "The other side of two pools" },
];

const POOLS = ["SPCXx / SPCX", "SPCXon / SPCXx", "SPCX / USDC", "SPCXx / SOL"];

const STEPS = [
  {
    title: "Deposit",
    text: "Hand over the vault's current mix, or pay with one token. Any issuer's SpaceX counts 1:1; USDC and SOL are converted by the vault into the issuer token it holds least of. Receive swSPCX.",
  },
  {
    title: "Hold",
    text: "Each swSPCX is a pro-rata slice of everything the vault holds: its liquidity in all four pools plus its idle reserves. No oracle: the value is read from the pool and reserve accounts.",
  },
  {
    title: "Redeem",
    text: "Burn swSPCX and take your slice of every token back, or receive one issuer token or USDC in a single transaction. The vault never pauses redemptions in kind.",
  },
];

// Set per pool when the vault creates it (trade_fee_bps, compounding_fee_bps) and per vault for
// arbitrage (arb_fee_bps). cp-amm keeps 20% of every pool fee; the rest splits by compounding_fee_bps.
const TRADE_FEE_BPS = 30;
const COMPOUNDING_FEE_BPS = 8_000;
const ARB_FEE_BPS = 2_000;
const HOLDERS = (80 * COMPOUNDING_FEE_BPS) / 10_000;
const FEE_SPLIT = [
  { key: "holders", share: HOLDERS, label: "Compounds in the pool for swSPCX holders", source: `compounding_fee_bps = ${COMPOUNDING_FEE_BPS}` },
  { key: "treasury", share: 80 - HOLDERS, label: "Protocol's cut, sent to the treasury", source: "harvest" },
  { key: "meteora", share: 20, label: "Meteora protocol fee", source: "fixed by cp-amm" },
];
const ARB_SPLIT = [
  { key: "holders", share: 100 - ARB_FEE_BPS / 100, label: "Stays in the vault for swSPCX holders", source: "vault reserves" },
  { key: "treasury", share: ARB_FEE_BPS / 100, label: "Stockwoven treasury", source: `arb_fee_bps = ${ARB_FEE_BPS}` },
];

const YIELD = [
  {
    title: "Pool fees",
    text: `Traders pay ${(TRADE_FEE_BPS / 100).toFixed(2)}% in every vault pool. Most of it compounds into the pool, so each unit of the vault's liquidity is backed by more tokens. The stock/USDC and stock/SOL pools see far more volume than the stock/stock ones.`,
  },
  {
    title: "Auto-balancing",
    text: "A keeper bot measures each pool's fee yield and moves the vault's liquidity toward the pools that earn the most, against target weights stored on-chain. It can't mint swSPCX or take funds out of the vault.",
  },
  {
    title: "Arbitrage",
    text: "When the same SpaceX trades at different prices across pools, the keeper runs a swap cycle of 2 to 4 hops through the vault's pools and market pools. The program only lets it land if the vault ends with more of the token it started from.",
  },
];

const ASSETS = [
  { ticker: "SPCX", stock: "SpaceX", issuers: "xStocks, Backpack, Ondo (devnet mocks)", status: "Live on devnet", live: true },
  { ticker: "AAPL", stock: "Apple", issuers: "—", status: "Not live yet" },
  { ticker: "NVDA", stock: "NVIDIA", issuers: "—", status: "Not live yet" },
  { ticker: "TSLA", stock: "Tesla", issuers: "—", status: "Not live yet" },
];

const FAQ = [
  {
    q: "Where does swSPCX's growth come from?",
    a: "From three sources: trading fees in the vault's four pools, the keeper moving liquidity toward the pools that earn the most, and arbitrage between pools that only lands when the vault ends with more. No return is promised: it depends on trading volume and price gaps.",
    href: "/docs/fees#where-the-yield-comes-from",
  },
  {
    q: "Is swSPCX 100% SpaceX?",
    a: "Mostly, not entirely. The vault also holds USDC and SOL inside its stock/USDC and stock/SOL pools, so swSPCX's value is a mix of SpaceX, USDC and SOL. The app shows its USD value as 1 swSPCX = $X.",
    href: "/docs/hold#how-swspcx-is-valued",
  },
  {
    q: "Is there a price oracle?",
    a: "Not for the mix. Depositing the mix and redeeming in kind use no price: a share is a pro-rata slice of every position and reserve. Single-token trades value USDC and SOL at prices the keeper posts, and stop if they are over 10 minutes old or a vault pool trades more than 2% away from them.",
    href: "/docs/how-the-vault-works#share-accounting",
  },
  {
    q: "Can redemptions be paused?",
    a: "No. The admin can pause deposits during an issuer event (pause, freeze, depeg). Redemptions stay open.",
    href: "/docs/risks",
  },
  {
    q: "What can the keeper do?",
    a: "Move liquidity between the vault's pools, swap between its reserves, run arbitrage cycles and post the prices single-token trades use. It is trusted to pick sizes and prices, but it can't mint swSPCX or move funds out of the vault, and every arbitrage is checked on-chain.",
    href: "/docs/how-the-vault-works#rebalancing",
  },
  {
    q: "What can the issuers still do?",
    a: "Issuers keep their token powers: pause, freeze and permanent delegate can halt or drain the pools' token accounts, and the vault can't prevent that.",
    href: "/docs/risks#issuer-powers-stay",
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
                Stockwoven pools every issuer&apos;s tokenized version of a stock in Meteora and gives your customers a single
                token for it, like <Ticker ticker="SPCX" />, that redeems for its share of everything the vault holds.
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
                SpaceX is tokenized by xStocks, Backpack and Ondo, and each version trades in its own pools. The vault holds
                liquidity in four Meteora DAMM v2 pools it owns, plus idle reserves of each token, and issues{" "}
                <Ticker ticker="SPCX" />, one token for a slice of all of it.
              </p>
            </div>

            <figure className="flow" aria-label="Three issuers' SpaceX tokens, USDC and SOL go into four Meteora pools, which back swSPCX">
              <div className="flow__inputs">
                {INPUTS.map((i) => (
                  <div key={i.token} className="flow__node">
                    <span className="t-data-lg">{i.token}</span>
                    <span className="t-body muted">{i.note}</span>
                  </div>
                ))}
              </div>
              <FlowArrow />
              <div className="flow__node flow__node--pool">
                <span className="t-label">Four Meteora DAMM v2 pools + idle reserves</span>
                {POOLS.map((p) => (
                  <span key={p} className="t-data muted">
                    {p}
                  </span>
                ))}
                <span className="t-data muted">compounding fees · keeper rebalances</span>
              </div>
              <FlowArrow />
              <div className="flow__node flow__node--out">
                <span className="t-data-lg">
                  <Ticker ticker="SPCX" />
                </span>
                <span className="t-body">Redeems for its slice of every pool and reserve</span>
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
                Where the yield comes from
              </h2>
              {YIELD.map((y) => (
                <p key={y.title} className="t-body body">
                  <strong>{y.title}.</strong> <WithTickers>{y.text}</WithTickers>
                </p>
              ))}
              <p className="t-body muted">
                Every parameter on the right is set in the program and readable on-chain. No yield is promised: it depends on
                trading volume and price gaps.
              </p>
              <LearnMore href="/docs/fees#where-the-yield-comes-from" label="Fees in detail" />
            </div>
            <div className="tile fees">
              <div className="tile__head">
                <span className="t-label">Each {(TRADE_FEE_BPS / 100).toFixed(2)}% pool fee</span>
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
              <div className="tile__head">
                <span className="t-label">Each arbitrage profit</span>
                <span className="t-data muted">2–4 hops · must end with more</span>
              </div>
              <div className="fee-bar" aria-hidden>
                {ARB_SPLIT.map((f) => (
                  <i key={f.key} className={`fee-bar__${f.key}`} style={{ flexGrow: f.share }} />
                ))}
              </div>
              <dl className="kv">
                {ARB_SPLIT.map((f) => (
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
              <p className="t-body-lg body">One sw token per stock, backed by every issuer&apos;s version in the vault&apos;s pools.</p>
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
                  <TickerChip ticker="SPCX" />
                  <span className="t-data">1,450.55 swSPCX</span>
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
                    {/* One flex item, so a ticker chip inside the question doesn't split it into columns. */}
                    <span className="faq__q">
                      <WithTickers>{f.q}</WithTickers>
                    </span>
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
                Connect a Solana wallet, get test tokens from the faucet, then deposit, swap and redeem. Nothing uses real
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
