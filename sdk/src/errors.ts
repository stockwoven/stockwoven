// Turns a failed transaction into something a partner can act on: the program's error name and a
// sentence for their own customer-facing copy.

/** The vault program's errors, in the order of programs/stockwoven/src/error.rs (Anchor codes start at 6000). */
export const VAULT_ERRORS = [
  ["Unauthorized", "Only the vault admin can do this."],
  ["NotKeeper", "Only the vault keeper can do this."],
  ["DepositsPaused", "Deposits are paused by the vault. Redemptions stay open."],
  ["ZeroAmount", "The amount must be greater than zero."],
  ["InvalidTradeFee", "Invalid trading fee."],
  ["InvalidCompoundingFee", "Invalid compounding share."],
  ["InvalidArbFee", "Invalid arbitrage fee."],
  ["InvalidWeight", "Invalid pool weight."],
  ["InvalidSeedShares", "Only the vault's first pool mints seed shares."],
  ["InvalidPool", "The pool does not match the vault's tokens."],
  ["TooManyAssets", "The vault holds the maximum number of assets."],
  ["TooManyPools", "The vault holds the maximum number of pools."],
  ["AssetExists", "This token is already a vault asset."],
  ["UnknownAsset", "This token is not a vault asset."],
  ["UnknownPool", "The vault has no pool at this index."],
  ["AccountMismatch", "An account does not match the vault. Update the SDK's vault config."],
  ["WrongAccountCount", "Wrong number of accounts or amounts for this vault. Update the SDK's vault config."],
  ["NotTreasury", "The token account is not the treasury's."],
  ["VaultEmpty", "The vault has no shares yet."],
  ["MathOverflow", "The amount is too large."],
  ["InvalidDammAccount", "An account is not the vault's pool or position."],
  ["InvalidTokenAccount", "An account is not a token account."],
  ["SlippageExceeded", "The pools moved past the limit. Quote again and retry."],
  ["InvalidRoute", "The arbitrage route does not return to its start token."],
  ["NotProfitable", "The arbitrage did not reach its minimum profit."],
  ["InvalidBasket", "The vault's basket settings do not cover every asset yet."],
  ["PricesStale", "The keeper's prices are out of date, so single-token deposits and redemptions are paused. Deposit with the mix or redeem in kind, or retry in a minute."],
  ["PoolOutOfBand", "A vault pool trades outside the band around the keeper's prices, so single-token deposits and redemptions are paused. Deposit with the mix or redeem in kind."],
  ["TokenDepegged", "This token trades outside its 1:1 band, so the vault is not taking it or paying it out alone. Use another token, or redeem in kind."],
  ["AssetAtCap", "This token is at its cap in the vault. Pay with another token: the SDK converts it into one the vault needs."],
  ["NotAStock", "Only issuer tokens of the stock go in or out alone; USDC and SOL are converted first."],
  ["NotUnderweight", "The vault only converts deposits into a token below its target weight. Quote again."],
  ["InsufficientLiquidity", "The vault does not hold enough of this token. Choose another token, or redeem in kind."],
] as const;

export type ErrorKind =
  | (typeof VAULT_ERRORS)[number][0]
  | "Slippage"
  | "InsufficientFunds"
  | "BlockhashExpired"
  | "RateLimited"
  | "Rejected"
  | "TooManyInstructions"
  | "Unknown";

export class StockwovenError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** The program's custom error code, when there is one. */
    readonly code?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StockwovenError";
  }
}

/** Classifies an error from sending or simulating a Stockwoven transaction. */
export function parseError(error: unknown): StockwovenError {
  if (error instanceof StockwovenError) return error;
  const logs: string[] = (error as { logs?: string[] })?.logs ?? (error as { transactionLogs?: string[] })?.transactionLogs ?? [];
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : JSON.stringify(error);
  const text = [message, ...logs].join("\n");

  const byName = text.match(/Error Code: (\w+)/)?.[1];
  const custom = text.match(/"Custom":\s*(\d+)/)?.[1] ?? text.match(/custom program error: (0x[0-9a-f]+)/i)?.[1];
  const code = custom === undefined ? undefined : Number(custom);
  const vault = VAULT_ERRORS.findIndex(([name]) => name === byName);
  const index = vault >= 0 ? vault : code !== undefined && code >= 6000 && code < 6000 + VAULT_ERRORS.length ? code - 6000 : -1;
  // A cp-amm error carries its own codes (ExceededSlippage is also 6002); only trust the vault
  // table when the vault program failed.
  const vaultFailed = vault >= 0 || !/cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG failed/.test(text);
  if (index >= 0 && vaultFailed) {
    const [name, message] = VAULT_ERRORS[index];
    return new StockwovenError(name, message, 6000 + index, error);
  }
  if (/slippage|ExceededSlippage/i.test(text)) return new StockwovenError("Slippage", "A pool moved past the slippage limit. Quote again and retry.", code, error);
  if (/MaxInstructionTraceLengthExceeded/.test(text))
    return new StockwovenError("TooManyInstructions", "Too many instructions for one transaction. Send each step of a built deposit as its own transaction.", code, error);
  if (/insufficient (funds|lamports)|custom program error: 0x1\b|"Custom":\s*1\b/i.test(text))
    return new StockwovenError("InsufficientFunds", "Not enough tokens or SOL to pay for this.", code, error);
  if (/blockhash|block height exceeded/i.test(text)) return new StockwovenError("BlockhashExpired", "The transaction expired before it confirmed. Build it again.", code, error);
  if (/429|too many requests/i.test(text)) return new StockwovenError("RateLimited", "The RPC rate-limited the request. Retry, or use a dedicated RPC.", code, error);
  if (/reject|denied|declined/i.test(text)) return new StockwovenError("Rejected", "The signer declined the transaction.", code, error);
  return new StockwovenError("Unknown", message, code, error);
}
