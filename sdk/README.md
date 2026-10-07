# @stockwoven/sdk

TypeScript SDK for neobanks and fintechs that offer tokenized stocks through Stockwoven. Several issuers tokenize the same stock; a Stockwoven vault takes them all and gives back one yield-bearing token per stock (`swSPCX` for SpaceX). Your customers hold that one token, and you don't have to pick an issuer.

The swSPCX vault holds the three issuers' SpaceX tokens (xStocks **SPCXx**, Backpack **SPCX**, Ondo **SPCXon**), USDC and SOL, and provides liquidity with them in four Meteora DAMM v2 pools it owns: SPCXx/SPCX and SPCXon/SPCXx between issuers, SPCX/USDC and SPCXx/SOL. One swSPCX is a pro-rata slice of everything the vault holds. Its yield comes from the pools' fees, a keeper that moves liquidity toward the pools earning the most, and arbitrage between pools that only lands when the vault ends with more.

The SDK reads the vault and your customers' positions, prices deposits and redemptions, and builds the transactions. **It never holds keys:** you sign with your own custody, whether that is a backend key, an MPC or wallet-as-a-service provider, or the customer's wallet in your app.

> Devnet only for now: the preset vault is swSPCX over mock SpaceX tokens with the issuers' real decimals, and its USDC is a test token.

## Install

```bash
npm install @solana/web3.js @solana/spl-token
npm install ./stockwoven-sdk-0.2.0.tgz   # until it is on npm: build the tarball with `npm pack` in sdk/
```

It runs in Node 20+ and in browsers. It needs `@solana/web3.js` 1.95+ and `@solana/spl-token` 0.4+.

## Quick start

```ts
import { Connection } from "@solana/web3.js";
import { Stockwoven, toRaw, fromRaw } from "@stockwoven/sdk";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const sw = new Stockwoven({ connection });

// What one swSPCX is worth now, and what it is made of
const vault = await sw.getVault();
console.log(`1 ${vault.share.symbol} = $${vault.valuePerShare.toFixed(2)}`, vault.exposure); // { stock: 0.88, usdc: 0.12, sol: 0.001 }

// Your customer deposits 20 USDC
const quote = await sw.quoteDeposit({ pay: "USDC", amount: toRaw("20", 6) });
const built = await sw.buildDeposit(quote, { owner: customer.publicKey, feePayer: treasury.publicKey });
await sw.sendAll(built, [treasury, customer]); // signs, sends and confirms each transaction in order

// Their position
const position = await sw.getPosition(customer.publicKey);
console.log(fromRaw(position.shares, vault.share.decimals), vault.share.symbol, `≈ $${position.valueUsd.toFixed(2)}`);
```

A complete custodial backend, with a dry run and error handling, is in [`examples/custodial-backend.ts`](examples/custodial-backend.ts).

In a browser app with a Wallet Standard wallet (Phantom, Solflare, Backpack), sign every transaction in one prompt, then send them in order:

```ts
const built = await sw.buildDeposit(quote, { owner: wallet.publicKey });
const signed = await wallet.signAllTransactions(built.transactions);
for (const tx of signed) {
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight });
}
```

## How a deposit can be paid

| `pay` | The customer pays | Transactions | What happens |
|---|---|---|---|
| `"mix"` | every asset in the vault's current proportions, for an exact number of `shares` | 1 | Mints exactly `shares`. Takes at most `maxSpend` of each token and refunds the rest. SOL is wrapped and unwrapped in the same transaction. |
| `"USDC"`, `"SOL"`, `"SPCXx"`, `"SPCX"`, `"SPCXon"` | one token, `amount` raw units | 2 | The first transaction swaps the token into each asset the vault holds, in the vault's proportions, through the best route of one or two pools. The second deposits them and mints exactly the quoted `shares`. Slices worth under $0.05 are not swapped: the wallet pays them from its own balance. |

A one-token deposit is two transactions because, together, the swaps and the deposit exceed Solana's limit of 64 instructions and inner calls per transaction. Sign both, then send and confirm them in order (`sendAll` does it for a backend). If the second fails, the customer keeps the tokens the first one bought; quote again and deposit them with `pay: "mix"`.

Redeeming pays a slice of every asset in kind: `sw.quoteRedeem(shares)`. With `{ receive: "USDC" }` (or any asset), the same transaction swaps the rest into it. The vault never pauses redemptions.

## Concepts

- **Amounts are raw units** (`bigint`), as on-chain. Convert with `toRaw("12.5", decimals)` and `fromRaw(raw, decimals)`; both are exact. Every `TokenInfo` carries its `decimals`, `symbol` and `issuer`.
- **Value in USD.** `valuePerShare`, `valueUsd` and `costUsd` use prices read from the pools, outward from USDC. swSPCX is mostly SpaceX but not all of it: `exposure` gives the split between stock tokens, USDC and SOL. `sinceLaunch` is in USD, so it includes SpaceX's own price move, not only the vault's yield.
- **Ticker clash.** Backpack's SpaceX token is called `SPCX`, the same letters as swSPCX's stock ticker. Show the issuer next to it (`token.issuer`) in your app.
- **Slippage.** Deposits with the mix and redemptions in kind tolerate `slippageBps` (default 50, 0.5%); each swap of a one-token route tolerates `routeSlippageBps` (default 50). The transaction fails rather than filling worse. Whatever a deposit doesn't take stays in the customer's wallet.
- **Shallow pools.** One-token deposits and redemptions to one asset are refused when their swaps would lose more than `maxLossBps` (default 300, 3%) of the value. The devnet SOL pools are small: keep SOL deposits under about 0.05 SOL.
- **wSOL.** Every deposit and redemption closes the owner's wrapped-SOL account at the end, returning all of it as SOL.
- **Quotes go stale.** Build and send soon after quoting. Pass one `getState()` result to several quotes to price them off the same read.
- **Sponsored fees.** `feePayer` pays network fees and token-account rent. Set it to your own key so customers don't need SOL (except to pay with SOL); then both of you sign (`signers` lists who must).
- **Compose your own transactions** with `depositSteps(quote, owner, feePayer)` and `redeemSteps(...)`, which return one instruction list per transaction. They need the vault's address lookup table (`vault.lookupTable`) to fit: a deposit touches about 45 accounts.

## API

| Method | Returns |
|---|---|
| `new Stockwoven({ connection, vault?, slippageBps?, routeSlippageBps?, maxLossBps?, computeUnits? })` | A client for one vault. Default: `DEVNET_SPCX`. |
| `getVault()` | Share token, assets, `valuePerShare`, `sinceLaunch`, `totalValue`, `supply`, `exposure`, each pool's value and target weight, idle reserves, prices, pause flag. |
| `getPosition(owner)` | Shares held, their USD value, and what redeeming them all in kind would pay now. |
| `getActivity(owner, limit?)` | The owner's latest transactions, newest first: deposit, redeem, swap or other, with balance changes per token. |
| `quoteDeposit(input)` | `route`, exact `shares`, `maxSpend` per token, `valueUsd`, `costUsd`. |
| `quoteRedeem(shares, { receive? })` | The minimum payout per token (in kind) or of the one asset. |
| `buildDeposit(quote, { owner, feePayer?, priorityFee? })` | Unsigned v0 `transactions` (one or two), the `signers` they need, `blockhash` and `lastValidBlockHeight`. |
| `buildRedeem(quote, { owner, feePayer?, priorityFee? })` | The same, for a redemption (one transaction). |
| `buildHarvest(caller)` | Permissionless: sends every pool's protocol fee to the treasury. |
| `sendAll(built, keypairs)` | Signs, sends and confirms each transaction in order; returns the signatures. |
| `getState()` | Raw on-chain state, to reuse across quotes. |
| `asset(symbolOrKind)` | The index of an asset in `vault.assets`. |
| `parseError(error)` | A `StockwovenError` with a `kind` you can branch on and a sentence for your own copy. |

Lower level, for partners who build their own flows: the pure pricing functions (`prices`, `vaultValue`, `exposure`, `holdings`, `tokensForShares`, `sharesFor`, `swapOut`, `bestRoute`, `zapIn`, `zapOut`), the instruction builders (`depositIx`, `redeemIx`, `swapIx`, `harvestIx`, `wrapSolIxs`, `unwrapSolIx`) and `fetchVaultState`.

## Errors

```ts
try {
  await sw.sendAll(built, [treasury, customer]);
} catch (e) {
  const error = parseError(e);
  if (error.kind === "DepositsPaused") showBanner(error.message);
}
```

| `kind` | Meaning |
|---|---|
| `DepositsPaused` | The vault paused deposits (an issuer event). Redemptions still work. |
| `SlippageExceeded`, `Slippage` | A pool moved past the limit. Quote again. |
| `InsufficientFunds` | The owner lacks the tokens, or the fee payer lacks SOL. |
| `TooManyInstructions` | A deposit's steps were merged into one transaction. Send each step on its own. |
| `AccountMismatch`, `WrongAccountCount` | The vault changed (an asset or pool was added). Update the SDK's vault config. |
| `BlockhashExpired` | Too slow between build and send. Build again. |
| `RateLimited` | The RPC refused. Retry, or use a dedicated RPC. |
| `Rejected` | The signer declined. |
| Other vault errors | `VAULT_ERRORS` lists them all with their codes (6000+). |

## In your app

- Keep the `sw` prefix on tickers (`swTicker("SPCX")` gives `"swSPCX"`). Your colors on the chip are fine.
- Show the issuer next to each SpaceX token, and say that swSPCX holds some USDC and SOL alongside SpaceX.
- Show "Powered by Stockwoven" once per flow, at the bottom of the investment screen.

The details are in the partner docs: `/docs/for-partners` on the Stockwoven site.

## Vault config

Every address comes from a `VaultConfig`, so the same code will serve mainnet vaults. The asset and pool order must match the vault's on-chain order: deposits and redemptions pass every asset and every pool, and the program checks each account. A token's `program` may be SPL Token or Token-2022. The real issuer tokens are Token-2022 with extensions such as ScaledUiAmount; when that multiplier differs from 1, one raw token is no longer one share, and pricing will need it.

## Changes from 0.1

0.1 served the swINTC vault, a single pool between two issuers. 0.2 serves the multi-pool swSPCX vault:

- `pay` is `"mix"` or an asset symbol (was `"both"`, `"A"`, `"B"`, `"USDC"`, `"SOL"`), and one-token deposits have no vault fee.
- `buildDeposit` and `buildRedeem` return `transactions` (an array) instead of `transaction`; `depositSteps` and `redeemSteps` replace `depositInstructions` and `redeemInstructions`.
- Values are in USD (`valuePerShare`, `valueUsd`) instead of shares of stock (`stockPerShare`, `stockValue`).
- `quoteRedeem` can pay out in one asset, and `buildHarvest` and `sendAll` are new.

## Develop

```bash
npm install
npm test              # math, units, errors, and parity with the devnet app's quotes
npm run test:devnet   # builds every transaction against devnet and simulates it (nothing is sent)
SEND_KEYPAIR=owner.json npm run test:devnet   # also sends the two-step deposits for real
npm run build         # dist/ with type declarations
npm pack              # the tarball partners install
```
