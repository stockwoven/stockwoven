# Stockwoven app: visual design

The authority is the design system in `src/design-system/stockwoven-design-system/` (README, `tokens.json`, `css/`). This file records how the devnet app applies it. It doesn't redefine any token.

## Wiring

- `src/app/layout.tsx` imports `fonts.css`, `tokens.css` and `components.css` once, then `globals.css`.
- `globals.css` uses only `var(--*)` from `tokens.css`. The only raw values are layout widths, breakpoints and touch-target sizes.
- Metadata and the manifest read colors from `tokens.json` through `src/lib/tokens.ts`.
- React ports live in `src/components/ds/` and keep the `sw-*` classes:
  - `Button` / `ButtonLink`
  - `Mark` / `Lockup` (from the SVG files)
  - `PoweredBy`
  - `StatCard`
  - `TickerChip` / `Ticker` / `WithTickers`
  - `WeavePattern` (`Stockwoven.weave()` plus a `ResizeObserver`)
  - `Display`
- Icons are generated from `assets/social/app-icon.png` into `public/icons/`.

## Areas

Three areas, each with its own layout and its own CSS file next to its route.

| Route | Mode | Layout | CSS |
|---|---|---|---|
| `/` | Landing: sells, never operates | `LandingHeader` (Product, Partners, Docs, Launch app), `LandingFooter` | `src/app/landing.css` |
| `/app`, `/app/portfolio`, `/app/convert`, `/app/devnet` | App: task first | `AppHeader` (tabs, Docs ↗, wallet), shared `VaultDataProvider` | `src/app/app/app.css` |
| `/docs/[slug]` | Docs: reading | `DocsHeader` (search, Launch app), sidebar/drawer, "On this page" | `src/app/docs/docs.css` |

- **Grounds.** The landing alternates ivory sections with black (`data-theme="dark"`) for the hero, the closing CTA and the footer. The app and the docs are ivory only.
- **Weave.** Only on the landing (hero and closing CTA). From 1024px it's full-bleed in the right half with `fade` toward the text. Below that it's a strip under the copy. It never appears in the app or the docs.
- **Bento grids.** 1 → 2 → 4 columns at 640 / 1024px, `radius-lg`, `space-3` gaps, no shadows, one inverse tile per row.
- **Tables.** The vault list, activity and assets are tables from 768px and label/value lists below that.
- **Accent.** Purple marks primary buttons, the active tab or page, the `sw` prefix, the holders' share, the pending state and "Learn more →" links (`accent-text`). The landing has no eyebrow labels above headings.

## Help text in the app

At most one line of microcopy per field or action. Anything longer is a `LearnMore` link to a docs anchor. Explanations live in `src/content/docs/*.mdx`. Headings get stable ids from their text (`slugify`), so links like `/docs/fees#harvest` keep working when a heading keeps its wording.

## Decisions where the design system was interpreted

- **Responsive display type.** `tokens.css` has classes but no size variables. `Display` renders both scale steps and shows one per breakpoint, so no in-between sizes exist.
- **Big numbers.** Stat values use Bricolage (`sw-stat__value`, "big numbers"), with the unit in `t-data` mono. Balances, quotes, addresses and table figures use mono with `tabular-nums`.
- **Data colors (Markets only).** The design system has one accent and no data palette. The Markets charts use five categorical slots, one per issuer and fixed everywhere a token appears: xStocks blue `#2a78d6`, Backpack orange `#eb6834`, Tessera aqua `#1baf7a`, PreStocks yellow `#eda100`, Ondo magenta `#e87ba4`. The diverging premium scale runs blue (`#2a78d6`, below fair value) to red (`#e34948`, above). They live as custom properties on `.app-main` in `markets.css` and never appear outside charts and their legends. Purple never marks data.
- **Touch targets.** Every control that is tapped is at least 44px tall: buttons, segmented filters, the amount input, header brand links, the docs "On this page" links. Small labels that are links (the docs chip) get a 44px hit area through `::after` without changing how they look.
- **Option groups.** "Pay with" and "Receive" sit in two columns on the narrowest panels, three from 280px and one row (`--options` columns) from 600px, so a label never wraps and an option never ends alone on a second row.
- **Scrolling regions.** Tables and code blocks that scroll sideways take keyboard focus (`tabIndex 0`, a region label, the accent focus ring).
- **Status colors.** The system has no success or error colors. Transaction states differ by word and treatment:
  - Pending: purple outline.
  - Confirmed: line outline.
  - Failed: inverse block.
- **Component states the package leaves open.** Hover on primary uses `purple-ink`, hover on secondary uses `text-body`, and buttons get a 44px minimum height.
- **Header.** Below 400px it shows the symbol without the wordmark. The wallet button stays visible at every width.
- **Wallet picker.** It's custom, built on `useWallet`, and replaces `wallet-adapter-react-ui` so the modal follows the tokens.

## Verification

`npm run build && PORT=3100 npm start`, then `CHROMIUM=/usr/bin/chromium npm run screenshots` (on Windows, `CHROMIUM="C:/Program Files/Google/Chrome/Application/chrome.exe"`). This captures every page of the three areas at 320, 375, 768, 1024, 1440 and 1920, plus the app states, with a test Wallet Standard wallet over the live devnet vault: the vault's accounts are read from devnet, while the wallet's balances, history and transactions are made up. It also runs the flow landing → Launch app → connect → deposit → portfolio → redeem. Results go to `screenshots/` (`report.json` for overflow, `flow.json` for the flow).
