// Screenshot harness: a Wallet Standard test wallet over the live devnet vault. Reads of the vault go
// to devnet, so the pages show its real state; the wallet's balances, history, faucet drips and
// transactions are made up, so every wallet state renders the same way on every run.
//   npm run build && PORT=3100 npm start
//   CHROMIUM=/usr/bin/chromium node scripts/screenshots.mjs [pages|states]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DEVNET = JSON.parse(fs.readFileSync(path.join(ROOT, "src/lib/devnet.json"), "utf8"));
const URL_ = process.env.APP_URL ?? "http://localhost:3100/";
const user = Keypair.generate().publicKey;
const FX = {
  user: user.toBase58(),
  userBytes: Array.from(user.toBytes()),
  blockhash: Keypair.generate().publicKey.toBase58(),
  sigs: [...Array(6)].map(() => bs58.encode(Keypair.generate().secretKey)),
};
const WIDTHS = process.env.W ? [Number(process.env.W)] : [320, 375, 768, 1024, 1440, 1920];
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// The vault itself is read live from devnet: pools, positions, reserves and the basket render as
// they are. Only the test wallet is made up: its token balances, its SOL, its history, and every
// transaction it sends (which "confirms" without touching the chain).
const ASSET_ATAS = DEVNET.assets.map((a) => getAssociatedTokenAddressSync(new PublicKey(a.mint), user, true, new PublicKey(a.tokenProgram)).toBase58());
const SHARE_ATA = getAssociatedTokenAddressSync(new PublicKey(DEVNET.shareMint), user, true).toBase58();
const SYMBOL = Object.fromEntries(DEVNET.assets.map((a) => [a.symbol, a]));

/** Whole tokens the test wallet holds, per asset symbol and for the share token. */
const HOLDINGS = { SPCXx: 8.75, SPCX: 9.25, SPCXon: 7.5, USDC: 1_250, SOL: 0, swSPCX: 1.234567 };
const EMPTY = { SPCXx: 10, SPCX: 10, SPCXon: 10, USDC: 2_000, SOL: 0, swSPCX: 0 };

function tokenAccount(mint, raw) {
  const b = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(b, 0);
  user.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(BigInt(raw), 64);
  b[108] = 1; // initialized
  return b.toString("base64");
}
const account = (data, owner = TOKEN_PROGRAM) => ({
  data: [data, "base64"],
  executable: false,
  lamports: 2_039_280,
  owner,
  rentEpoch: 0,
  space: Buffer.from(data, "base64").length,
});
const ctx = (value) => ({ context: { slot: 1 }, value });

/** The fake account for one of the test wallet's token accounts, or undefined for anything else. */
function walletAccount(address, opts) {
  const hold = opts.empty ? EMPTY : HOLDINGS;
  const k = ASSET_ATAS.indexOf(address);
  if (k >= 0) {
    const a = DEVNET.assets[k];
    return hold[a.symbol] ? account(tokenAccount(a.mint, Math.round(hold[a.symbol] * 10 ** a.decimals))) : null;
  }
  if (address === SHARE_ATA) return hold.swSPCX ? account(tokenAccount(DEVNET.shareMint, Math.round(hold.swSPCX * 1e8))) : null;
  return undefined;
}

const ACTIVITY = [
  { t: 0, d: { swSPCX: 2.5, USDC: -575 } },
  { t: 1, d: { SPCXx: -1, SPCXon: 0.998903 } },
  { t: 2, d: { swSPCX: -0.5, SPCXx: 0.2499, SPCX: 0.2502, USDC: 22.4 } },
  { t: 3, d: { SPCXx: 10, SPCX: 10, SPCXon: 10, USDC: 2_000 } },
  { t: 4, d: {}, err: true },
];

function parsedTx(i) {
  const a = ACTIVITY[i];
  const meta = (sym) => (sym === "swSPCX" ? [DEVNET.shareMint, 8] : [SYMBOL[sym].mint, SYMBOL[sym].decimals]);
  const bal = (sym, amt, index) => {
    const [mint, decimals] = meta(sym);
    return {
      accountIndex: index,
      mint,
      owner: FX.user,
      programId: TOKEN_PROGRAM,
      uiTokenAmount: { amount: String(Math.round(amt * 10 ** decimals)), decimals, uiAmount: amt, uiAmountString: String(amt) },
    };
  };
  const pre = [], post = [];
  Object.entries(a.d).forEach(([sym, v], j) => {
    pre.push(bal(sym, 20, j + 1));
    post.push(bal(sym, 20 + v, j + 1));
  });
  return {
    slot: 100 - i,
    blockTime: Math.floor(Date.now() / 1000) - (i + 1) * 3600,
    version: 0,
    transaction: {
      signatures: [FX.sigs[i]],
      message: {
        accountKeys: [{ pubkey: FX.user, signer: true, writable: true, source: "transaction" }],
        instructions: [],
        recentBlockhash: FX.blockhash,
      },
    },
    meta: {
      err: a.err ? { InstructionError: [0, "Custom"] } : null,
      fee: 5000,
      preBalances: [1],
      postBalances: [1],
      innerInstructions: [],
      logMessages: [],
      preTokenBalances: pre,
      postTokenBalances: post,
    },
  };
}

/** The answer for requests about the test wallet or its transactions; undefined sends it to devnet. */
function local(r, opts) {
  const [first] = r.params ?? [];
  switch (r.method) {
    case "getBalance":
      return first === FX.user ? ctx(opts.empty ? 20_000_000 : 1_482_000_000) : undefined;
    case "getSignaturesForAddress":
      if (first !== FX.user) return undefined;
      return opts.empty
        ? []
        : ACTIVITY.map((a, i) => ({
            signature: FX.sigs[i],
            slot: 100 - i,
            err: a.err ? { InstructionError: [0, "Custom"] } : null,
            memo: null,
            blockTime: Math.floor(Date.now() / 1000) - (i + 1) * 3600,
            confirmationStatus: "finalized",
          }));
    case "getTransaction":
      return FX.sigs.includes(first) ? parsedTx(FX.sigs.indexOf(first)) : undefined;
    case "sendTransaction":
      return FX.sigs[5];
    case "simulateTransaction":
      return ctx({ err: null, logs: [], accounts: null, unitsConsumed: 200_000, returnData: null });
    case "getSignatureStatuses":
      return ctx(first.map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: "confirmed" })));
    case "getAccountInfo": {
      const fake = walletAccount(first, opts);
      return fake === undefined ? undefined : ctx(fake);
    }
    default:
      return undefined;
  }
}

async function mock(page, opts = {}) {
  // A page closed while a live read is still in flight is not an error.
  await page.route(/api\.devnet\.solana\.com/, (route) => answer(route).catch(() => {}));
  async function answer(route) {
    if (opts.rpc === "hang") return; // never answers: loading state
    if (opts.rpc === "error") return route.fulfill({ status: 503, body: "Service Unavailable" });
    const body = JSON.parse(route.request().postData() || "{}");
    const calls = Array.isArray(body) ? body : [body];
    const answers = calls.map((r) => local(r, opts));
    const remote = calls.filter((_, i) => answers[i] === undefined);
    let fetched = [];
    if (remote.length) {
      const res = await route.fetch({ postData: JSON.stringify(remote) });
      fetched = await res.json();
      if (!Array.isArray(fetched)) fetched = [fetched];
    }
    const out = calls.map((r, i) => {
      if (answers[i] !== undefined) return { jsonrpc: "2.0", id: r.id, result: answers[i] };
      const got = fetched.find((f) => f.id === r.id);
      // The test wallet's token accounts inside a batch read.
      if (r.method === "getMultipleAccounts" && got?.result?.value) {
        got.result.value = got.result.value.map((v, j) => {
          const fake = walletAccount(r.params[0][j], opts);
          return fake === undefined ? v : fake;
        });
      }
      return got;
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? out : out[0]) });
  }
  // Only the wallet's confirmations go over the WebSocket; they confirm at once.
  await page.routeWebSocket(/api\.devnet\.solana\.com/, (ws) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(raw);
      if (m.method === "signatureSubscribe") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: 7 }));
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "signatureNotification",
                params: { subscription: 7, result: { context: { slot: 2 }, value: { err: null } } },
              }),
            ),
          150,
        );
      } else ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: true }));
    });
  });
  await page.route("**/api/faucet", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ signature: FX.sigs[5] }) }),
  );
}

// A Wallet Standard wallet injected before the app loads. `mode`: ok | pending | reject.
function walletScript({ user, userBytes, connected, mode }) {
  const account = {
    address: user,
    publicKey: new Uint8Array(userBytes),
    chains: ["solana:devnet", "solana:mainnet"],
    features: ["solana:signAndSendTransaction", "solana:signTransaction"],
  };
  const listeners = [];
  const icon =
    "data:image/svg+xml;base64," +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="6" fill="#3C3D39"/></svg>');
  const wallet = {
    version: "1.0.0",
    name: "Test Wallet",
    icon,
    chains: ["solana:devnet", "solana:mainnet"],
    accounts: [],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          wallet.accounts = [account];
          listeners.forEach((l) => l({ accounts: wallet.accounts }));
          return { accounts: wallet.accounts };
        },
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { wallet.accounts = []; } },
      "standard:events": { version: "1.0.0", on: (_e, l) => { listeners.push(l); return () => {}; } },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs) => {
          if (mode === "pending") await new Promise(() => {});
          if (mode === "reject") throw new Error("User rejected the request.");
          return inputs.map(() => ({ signature: new Uint8Array(64).fill(9) }));
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => inputs.map((i) => ({ signedTransaction: i.transaction })),
      },
    },
  };
  const callback = ({ register }) => register(wallet);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  } catch {}
  window.addEventListener("wallet-standard:app-ready", ({ detail }) => callback(detail));
  if (connected) localStorage.setItem("walletName", JSON.stringify("Test Wallet"));
}

async function open(browser, width, opts = {}, route = "app") {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 800 : 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  if (process.env.DEBUG) {
    page.on("console", (m) => console.log("console:", m.text().slice(0, 300)));
    page.on("pageerror", (e) => console.log("pageerror:", e.message));
  }
  await mock(page, opts);
  await page.addInitScript(walletScript, {
    user: FX.user,
    userBytes: FX.userBytes,
    connected: !!opts.connected,
    mode: opts.mode ?? "ok",
  });
  await page.goto(new URL(route, URL_).href, { waitUntil: "load" });
  if (route.startsWith("app") && opts.rpc !== "hang" && opts.rpc !== "error") {
    await page.waitForFunction(() => !document.querySelector(".app-main .tile .skeleton"), null, { timeout: 15000 });
  }
  if (opts.connected) await page.waitForSelector(".wallet", { timeout: 15000 });
  await page.waitForTimeout(600); // weave canvas draw
  return { page, context };
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1 && el.getClientRects().length)
      .filter((el) => !el.closest(".hero__art, dialog:not([open]), thead, pre, .doc-table"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
    return { scroll: doc.scrollWidth - doc.clientWidth, offenders };
  });
}

// Prose longer than one line of microcopy inside the app's main area.
const longCopy = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".app-main p")]
      .map((p) => p.textContent.trim())
      .filter((t) => t.length > 90),
  );

const PAGES = [
  ["landing", "", {}],
  ["app-vaults", "app", { connected: true }],
  ["app-vaults-disconnected", "app", {}],
  ["app-portfolio", "app/portfolio", { connected: true }],
  ["app-convert", "app/convert", { connected: true }],
  ["app-markets", "app/markets", {}],
  ["app-devnet", "app/devnet", { connected: true }],
  ["docs-overview", "docs/overview", {}],
  ["docs-fees", "docs/fees", {}],
];

const report = [];
const only = process.argv[2];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
try {
  if (!only || only === "pages") {
    for (const width of WIDTHS) {
      for (const [name, route, opts] of PAGES) {
        const { page, context } = await open(browser, width, opts, route);
        report.push({ width, state: name, ...(await overflow(page)) });
        await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
        await context.close();
      }
    }
  }

  if (!only || only === "states") {
    for (const width of [375, 1440]) {
      const shot = async (name, route, opts, act, selector) => {
        const { page, context } = await open(browser, width, opts, route);
        if (selector) await page.addStyleTag({ content: ".header{position:static}" });
        if (act) await act(page);
        const target = selector ? page.locator(selector).first() : page;
        await target.screenshot({ path: `${OUT}/state-${name}-${width}.png` });
        report.push({ width, state: name, ...(await overflow(page)) });
        await context.close();
      };
      const deposit = async (page) => {
        await page.locator("#vault-tabpanel button.sw-btn--primary").click();
        await page.waitForTimeout(1500);
      };
      await shot("loading", "app", { rpc: "hang" }, null, null);
      await shot("rpc-error", "app", { rpc: "error" }, (p) => p.waitForSelector(".banner"), ".app-main");
      await shot("panel-disconnected", "app", {}, null, "#vault-panel");
      await shot("tx-pending", "app", { connected: true, mode: "pending" }, deposit, "#vault-panel");
      await shot("tx-confirmed", "app", { connected: true }, deposit, "#vault-panel");
      await shot("tx-failed", "app", { connected: true, mode: "reject" }, deposit, "#vault-panel");
      await shot("redeem-tab", "app", { connected: true }, (p) => p.click("#tab-redeem"), "#vault-panel");
      await shot("redeem-usdc", "app", { connected: true }, async (p) => {
        await p.click("#tab-redeem");
        await p.click("#vault-tabpanel [aria-pressed] >> text=USDC");
      }, "#vault-panel");
      await shot("deposit-single", "app", { connected: true }, (p) => p.click("#vault-tabpanel [aria-pressed] >> text=SPCXon"), "#vault-panel");
      await shot("deposit-usdc", "app", { connected: true }, (p) => p.click("#vault-tabpanel [aria-pressed] >> text=USDC"), "#vault-panel");
      await shot("deposit-sol", "app", { connected: true }, (p) => p.click("#vault-tabpanel [aria-pressed] >> text=SOL"), "#vault-panel");
      await shot("portfolio-empty", "app/portfolio", { connected: true, empty: true }, null, ".app-main");
      await shot("portfolio-disconnected", "app/portfolio", {}, null, ".app-main");
      await shot(
        "faucet-ok",
        "app/devnet",
        { connected: true },
        async (p) => {
          await p.click("text=Get test tokens >> nth=-1");
          await p.waitForTimeout(800);
        },
        ".app-main",
      );
      await shot("wallet-picker", "app", {}, (p) => p.click(".header .sw-btn--secondary"), null);
      await shot("wallet-menu", "app", { connected: true }, (p) => p.click(".wallet > button"), null);
      await shot("docs-search", "docs/overview", {}, async (p) => {
        await p.click(".docs-search-trigger");
        await p.keyboard.type("oracle");
        await p.waitForTimeout(300);
      }, null);
      if (width === 375) {
        await shot("menu-landing", "", {}, (p) => p.click(".menu-button"), null);
        await shot("menu-app", "app", {}, (p) => p.click(".menu-button"), null);
        await shot("menu-docs", "docs/overview", {}, (p) => p.click(".docs-menu-button"), null);
      }
    }
  }

  if (!only || only === "flow") {
    // Connect → deposit → see the position → redeem, through the app's own navigation only.
    const { page, context } = await open(browser, 1440, {}, "");
    const seen = [];
    await page.click("text=Launch app >> nth=0");
    await page.waitForURL(/\/app$/);
    await page.click(".header .sw-btn--secondary");
    await page.click(".wallet-option");
    await page.waitForSelector(".wallet");
    seen.push(...(await longCopy(page)));
    await page.locator("#vault-tabpanel button.sw-btn--primary").click();
    await page.waitForSelector(".status--ok");
    await page.click(".header__nav >> text=Portfolio");
    await page.waitForURL(/portfolio/);
    await page.waitForSelector(".balance .t-data-lg");
    const balance = await page.textContent(".balance .t-data-lg");
    seen.push(...(await longCopy(page)));
    await page.click(".header__nav >> text=Vaults");
    await page.click("#tab-redeem");
    await page.locator("#vault-tabpanel button.sw-btn--primary").click();
    await page.waitForSelector(".status--ok");
    seen.push(...(await longCopy(page)));
    const flow = { steps: "landing → Launch app → connect → deposit ok → portfolio → redeem ok", balance, longCopy: seen };
    fs.writeFileSync(`${OUT}/flow.json`, JSON.stringify(flow, null, 2));
    console.log("flow:", JSON.stringify(flow));
    await context.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(report.map((r) => `${r.width}\t${r.state}\tscroll=${r.scroll}\t${r.offenders.join(" ")}`).join("\n"));
