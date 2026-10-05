import type { Metadata } from "next";
import { ButtonLink, Display, PoweredBy, StatCard, Ticker, TickerChip, WeavePattern, WithTickers } from "@/components/ds";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { LINKS } from "@/lib/links";
import { COMPOUNDING_FEE_BPS, TRADE_FEE_BPS } from "@/lib/stockwoven";
import "./landing.css";

export const metadata: Metadata = {
  title: "Stockwoven · One stock. One token.",
};

const STEPS = [
  { title: "Deposit.", text: "Hand over the vault's current mix of mINTCx and mINTC. Receive swINTC." },
  {
    title: "Hold.",
    text: "Each swINTC is a fixed slice of the pool's liquidity. Its value is read from the pool account, not from an oracle.",
  },
  { title: "Redeem.", text: "Burn swINTC and take your share of both tokens. The vault never pauses redemptions." },
];

const ASSETS = [
  { ticker: "INTC", status: "Live on devnet", live: true },
  { ticker: "AAPL", status: "Not live yet" },
  { ticker: "NVDA", status: "Not live yet" },
  { ticker: "TSLA", status: "Not live yet" },
];

const HOLDERS = (80 * COMPOUNDING_FEE_BPS) / 10_000;

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
              <p className="t-eyebrow accent-text">Live on Solana devnet</p>
              <Display as="h1" id="hero-title" base="heading-md" up="display-lg">
                One stock. One token.
              </Display>
              <p className="t-body-lg hero__lead">Give your customers one token per stock, with all the liquidity in one pool.</p>
              <div className="hero__actions">
                <ButtonLink href="/app">Launch app</ButtonLink>
                <ButtonLink variant="ghost" href="/docs/overview">
                  Read the docs
                </ButtonLink>
              </div>
            </div>
          </div>
          <WeavePattern className="hero__art sw-weave--bleed" seed={3} fade={0.4} />
        </section>

        <section className="section" aria-labelledby="problem-title">
          <div className="wrap">
            <div className="section__head">
              <p className="t-eyebrow accent-text">The problem</p>
              <h2 id="problem-title" className="t-heading-md">
                One stock. Separate pools.
              </h2>
              <p className="t-body-lg body">
                The same stock is tokenized by several issuers, and each version trades in its own pool.
              </p>
            </div>
            <div className="bento bento--2">
              {[
                ["INTCx", "xStocks"],
                ["INTC", "Backpack"],
              ].map(([token, issuer]) => (
                <div key={token} className="tile island">
                  <span className="t-data-lg">{token}</span>
                  <span className="t-body body">Intel, tokenized by {issuer}. Its own pool, its own liquidity.</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="product" aria-labelledby="solution-title">
          <div className="wrap">
            <div className="section__head">
              <p className="t-eyebrow accent-text">The solution</p>
              <h2 id="solution-title" className="t-heading-md">
                Many issuers. One token.
              </h2>
              <p className="t-body-lg body">
                Stockwoven&apos;s vault takes every issuer&apos;s version in and gives back one yield-bearing token per stock, with all
                the liquidity in one place.
              </p>
              <p className="t-body body">
                The vault takes Intel from two issuers and returns <Ticker ticker="INTC" />, a share of one Meteora pool that grows
                with every conversion fee.
              </p>
            </div>
            <h3 className="t-heading-sm">One token per stock.</h3>
            <ul className="asset-chips">
              {ASSETS.map((a) => (
                <li key={a.ticker}>
                  <TickerChip ticker={a.ticker} muted={!a.live} />
                  <span className={a.live ? "t-data" : "t-data muted"}>{a.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="section" aria-labelledby="how-title">
          <div className="wrap">
            <div className="section__head">
              <p className="t-eyebrow accent-text">How it works</p>
              <h2 id="how-title" className="t-heading-md">
                Deposit. Hold. Redeem.
              </h2>
            </div>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.title}>
                  <span className="t-eyebrow muted">Step {i + 1}</span>
                  <h3 className="t-heading-sm">{s.title}</h3>
                  <p className="t-body body">
                    <WithTickers>{s.text}</WithTickers>
                  </p>
                </li>
              ))}
            </ol>
            <ButtonLink variant="ghost" href="/docs/how-the-vault-works">
              How the vault works →
            </ButtonLink>
          </div>
        </section>

        <section className="section" aria-labelledby="numbers-title">
          <div className="wrap">
            <div className="section__head">
              <p className="t-eyebrow accent-text">By the numbers</p>
              <h2 id="numbers-title" className="t-heading-md">
                Set in the program. Readable on-chain.
              </h2>
            </div>
            <div className="bento">
              <StatCard
                value={`${(TRADE_FEE_BPS / 100).toFixed(2)}%`}
                label="Fee on each conversion between issuers"
                source="Pool fee config · trade_fee_bps = 10"
              />
              <StatCard
                inverse
                value={`${HOLDERS}%`}
                label="Of each conversion fee compounds for holders"
                source="compounding_fee_bps = 8000"
              />
              <StatCard value="2" unit="issuers" label="In the devnet vault: xStocks and Backpack (mocks)" source="Devnet deployment" />
              <StatCard value="0" unit="oracles" label="Deposits and redemptions are priced by the pool itself" source="cp-amm L × reserve / L_total" />
            </div>
          </div>
        </section>

        <section className="section" id="partners" aria-labelledby="partners-title">
          <div className="wrap">
            <div className="bento bento--2">
              <div className="tile partners">
                <p className="t-eyebrow accent-text">For partners</p>
                <h2 id="partners-title" className="t-heading-md">
                  Your brand leads. We stay small.
                </h2>
                <p className="t-body-lg body">
                  The neobank owns the customer and the app; Stockwoven is the layer underneath.
                </p>
                <p className="t-body body">
                  Inside your app, Stockwoven appears only as a &ldquo;Powered by&rdquo; badge and in the sw tickers.
                </p>
                <div className="hero__actions">
                  <ButtonLink variant="secondary" href="/docs/for-partners">
                    Read the partner docs
                  </ButtonLink>
                  {LINKS.contact ? (
                    <ButtonLink variant="ghost" href={LINKS.contact}>
                      Talk to us
                    </ButtonLink>
                  ) : (
                    <span className="t-label muted todo-link">Talk to us [TODO]</span>
                  )}
                </div>
              </div>
              <div className="tile partner-sample" aria-label="How Stockwoven appears in a partner app">
                <p className="t-eyebrow muted">Example · inside your app</p>
                <div className="partner-sample__row">
                  <TickerChip ticker="INTC" />
                  <span className="t-data">1,450.55 INTC</span>
                </div>
                <p className="t-body body">Tickers keep the sw prefix and the monospaced face. Your colors on the chip.</p>
                <div className="partner-sample__badge">
                  <PoweredBy />
                </div>
                <p className="t-body muted">Once per flow, at the bottom of the investment screen.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="cta theme-surface" data-theme="dark" aria-labelledby="cta-title">
          <div className="wrap hero__inner cta__inner">
            <div className="hero__copy">
              <h2 id="cta-title" className="t-heading-md">
                One integration. Every issuer.
              </h2>
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
