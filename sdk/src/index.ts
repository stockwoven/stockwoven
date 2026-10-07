export { Stockwoven } from "./client.js";
export type {
  BuildOptions,
  BuiltTransactions,
  DepositInput,
  DepositQuote,
  PoolInfo,
  Position,
  RedeemQuote,
  StockwovenOptions,
  VaultInfo,
} from "./client.js";
export { CP_AMM, DAMM_EVENT_AUTHORITY, DAMM_POOL_AUTHORITY, DEVNET_SPCX, assetIndex } from "./config.js";
export type { AssetKind, Pool, PoolKind, TokenInfo, VaultConfig } from "./config.js";
export { fetchVaultState } from "./state.js";
export type { PoolState, VaultState } from "./state.js";
export {
  MIN_SWAP_USD,
  allPools,
  applyBps,
  bestRoute,
  exposure,
  holdings,
  poolValue,
  positionAmounts,
  prices,
  sharesFor,
  swapOut,
  tokensForShares,
  usdValue,
  vaultValue,
  zapIn,
  zapOut,
} from "./quote.js";
export type { Hop, Route, Swap, ZapInPlan, ZapOutPlan } from "./quote.js";
export { createTokenAccountIx, depositIx, harvestIx, redeemIx, swapIx, tokenAccount, unwrapSolIx, wrapSolIxs } from "./instructions.js";
export { fetchActivity } from "./activity.js";
export type { Activity, ActivityKind } from "./activity.js";
export { StockwovenError, VAULT_ERRORS, parseError } from "./errors.js";
export type { ErrorKind } from "./errors.js";
export { fromRaw, toRaw } from "./units.js";

/** The sw ticker for a stock: "SPCX" → "swSPCX". Partners keep the prefix in their apps. */
export const swTicker = (stock: string) => `sw${stock.toUpperCase()}`;
