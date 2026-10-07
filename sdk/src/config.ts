// Where a Stockwoven vault lives on-chain. One config per vault (one per stock); the SDK reads
// every address from it, so the same code serves devnet and mainnet.

import { PublicKey } from "@solana/web3.js";

export type AssetKind = "stock" | "usdc" | "sol";

/** A token the vault holds: an issuer's version of the stock, USDC or wrapped SOL. */
export type TokenInfo = {
  symbol: string;
  name: string;
  /** Who issues it (xStocks, Backpack, Ondo), for display. Null for USDC and SOL. */
  issuer: string | null;
  kind: AssetKind;
  mint: PublicKey;
  decimals: number;
  /** SPL Token or Token-2022. */
  program: PublicKey;
  /** The vault's reserve account for this token. */
  reserve: PublicKey;
};

export type PoolKind = "stock-stock" | "stock-usdc" | "stock-sol" | "market";

/** A Meteora DAMM v2 (cp-amm) pool between two of the vault's assets. */
export type Pool = {
  label: string;
  kind: PoolKind;
  pool: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  /** Indexes into `VaultConfig.assets`. */
  a: number;
  b: number;
  /** The pool's trading fee. The fee is charged in token B (compounding pools). */
  feeBps: number;
  /** Only the vault's own pools have a position. */
  position?: PublicKey;
  positionNftAccount?: PublicKey;
};

export type VaultConfig = {
  cluster: "devnet" | "mainnet-beta";
  /** The stock behind the vault, e.g. "SPCX". */
  stock: string;
  /** The vault's token (swSPCX). */
  share: { symbol: string; mint: PublicKey; decimals: number; program: PublicKey };
  program: PublicKey;
  vault: PublicKey;
  treasury: PublicKey;
  /** Address lookup table with every vault-owned and fixed account; deposits and redeems need it. */
  lookupTable: PublicKey;
  /** Share of each arbitrage profit the treasury takes, in basis points. */
  arbFeeBps: number;
  /** The tokens the vault holds, in the vault's order. Deposits and redeems move every one of them. */
  assets: TokenInfo[];
  /** The vault's own pools, in the vault's order. */
  pools: Pool[];
  /** Pools other LPs own. Routes for one-token deposits and redemptions can use them. */
  marketPools: Pool[];
  /** USD value of one share token at launch, for "since launch" figures. */
  launchUsdPerShare: number;
};

const pk = (s: string) => new PublicKey(s);
const TOKEN_PROGRAM = pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * The swSPCX vault on Solana devnet. Its SpaceX tokens are mocks of xStocks SPCXx, Backpack SPCX
 * and Ondo SPCXon with their real decimals; its USDC is a test token from the Stockwoven faucet.
 * It holds liquidity in four pools: SPCXx/SPCX and SPCXon/SPCXx (between issuers), SPCX/USDC and
 * SPCXx/SOL.
 */
export const DEVNET_SPCX: VaultConfig = {
  cluster: "devnet",
  stock: "SPCX",
  share: { symbol: "swSPCX", mint: pk("C7jWrmv58WRpohBrgcUmTpUicq5TqA8jDYV4YVx99HH2"), decimals: 8, program: TOKEN_PROGRAM },
  program: pk("H9ZJiWoKXGrje8Y3errCSh2uXUiNpf8mDmjJ7TapZm7b"),
  vault: pk("GmqYTH8YLXRMBhxd4CYutRJbw1N9UUbxvFTDohbw365p"),
  treasury: pk("Dwrba3bghFaRnE6RqGmRHLRKd4QqUr9Bz38Dt8KxQD1D"),
  lookupTable: pk("F2cbk6mCXNPbjmTThuqrqPDDSVb7qLLBbraTeraUqsf2"),
  arbFeeBps: 2000,
  assets: [
    { symbol: "SPCXx", name: "SpaceX xStock (mock)", issuer: "xStocks", kind: "stock", mint: pk("72KEUW3UYXDDfwkorkTrz2cjFB6JNPEMQxvvWp48kcWD"), decimals: 8, program: pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), reserve: pk("NiKGeQ4Ndzf3U5tgMksAA6v1sKCXZ58sUEzcJgeaiWb") },
    { symbol: "SPCX", name: "SpaceX (Backpack) (mock)", issuer: "Backpack", kind: "stock", mint: pk("9r6tVtSuSEqXizpPsqkZXSVT99Mns156boaGMyjwoDjD"), decimals: 6, program: pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), reserve: pk("HtMr3xSyxKTAvRq7XTd4CbcpdkHEV1cYSeAsU3ov3FvS") },
    { symbol: "SPCXon", name: "SpaceX (Ondo Tokenized) (mock)", issuer: "Ondo", kind: "stock", mint: pk("F9dxeL9egjMutFFtdscFrHcvF8D6CAxam2ddMWqQJvzZ"), decimals: 9, program: pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), reserve: pk("Fa1DPG1QdWs62W62ZyayGk6rTXms4jNPKm6uDZYJLk7L") },
    { symbol: "USDC", name: "USD Coin (mock)", issuer: null, kind: "usdc", mint: pk("5xzRhDT2jdyJ1WbwnyBdj8Gjb5JbNrD3G3w89b7Qeahz"), decimals: 6, program: pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), reserve: pk("f7qSikvYXTPdXYzjWefZLvb2TcaRHXqNoMHwncKy8E5") },
    { symbol: "SOL", name: "Solana", issuer: null, kind: "sol", mint: pk("So11111111111111111111111111111111111111112"), decimals: 9, program: pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), reserve: pk("AoK5pkDzJbQJjZgArRWFrYfiafQtWgq6o6wzQ16rEhM1") },
  ],
  pools: [
    {
      label: "SPCXx / SPCX",
      kind: "stock-stock",
      pool: pk("CK1hZi9o3sRDR64aWzRfRiKqC9ibLab1mjCrnH6XKhUA"),
      tokenAVault: pk("A2BL3kvEi8pjcXovFyes6BxFxaaY7QYFUs24KhqfgeoV"),
      tokenBVault: pk("4dDc6ZETwuKy13dbe8PLshgz2Ctbyx2YasCrfPrZRkLG"),
      a: 0,
      b: 1,
      feeBps: 30,
      position: pk("2BfjwUYhrUd4uTCqfeCr9TdDfk7ZafmgQL3WjXMzsN5K"),
      positionNftAccount: pk("56VJ9iMSzSE8S9d7Hwg8LQgpgRVyzqpZ4XAmZR13bXes"),
    },
    {
      label: "SPCXon / SPCXx",
      kind: "stock-stock",
      pool: pk("3M4j7WhWTiRXCcMSkWaTc2fJuWBUU71cX4aNbaqZCriM"),
      tokenAVault: pk("FSTV2njMoBHjqQWzw8ZmhVZ2SwFZf118wF3LQeHQ36wh"),
      tokenBVault: pk("4UQuoE6Rd4mTMABScHagJMrn6q8tNXjPq5FdZZ5P5SpN"),
      a: 2,
      b: 0,
      feeBps: 30,
      position: pk("AToVmiHu2APa3uFkxfPuTTF3Du1B1ZTsFCSP2zXF735Z"),
      positionNftAccount: pk("DFUb67ZG7ozG62rB2pysmkTKCXFgLpbfNgNYfvmbzUzm"),
    },
    {
      label: "SPCX / USDC",
      kind: "stock-usdc",
      pool: pk("GC1E83NTdmGQDYtDHNbokgoomtC6bL8SwGqfBmAWwGky"),
      tokenAVault: pk("2EfDvpVmL5csiVJGhoaEPPqEtktppV4k9pzTQ6H1QbFU"),
      tokenBVault: pk("8TUKVZdcpAxCF92iACLc7LFpc9FcdhFWiz5ExoPowahP"),
      a: 1,
      b: 3,
      feeBps: 30,
      position: pk("DPRBoVLswrDMzoBPprWHWsVEqNuY13MNq22GfYZhe1X4"),
      positionNftAccount: pk("Ex8Q5GJJDy6JNhDQVBeDhAMCRckXH1MCDdPrav7SbJQW"),
    },
    {
      label: "SPCXx / SOL",
      kind: "stock-sol",
      pool: pk("3hDKpudujQDsnTvk8hobcJc1HVYXsMMcLCMH9oeGU7fA"),
      tokenAVault: pk("79aRM6LoRRh52GyWuuSr5wn8ZGQrpJuppAweLJSN4w9j"),
      tokenBVault: pk("5pTbEPvYe5FDW27KyUMwFUAWEX75RKrijZYkm5fXsvM5"),
      a: 0,
      b: 4,
      feeBps: 30,
      position: pk("246vrViEppQuA5voc1zZXaR66x37BUMVWgZ2qj4ZfJUh"),
      positionNftAccount: pk("HV4RGLPBQ4bXQEZfrbuEi53WJYXbVTLow3voL3yn2ZDw"),
    },
  ],
  marketPools: [
    {
      label: "SPCXx / USDC (market)",
      kind: "market",
      pool: pk("JFrYsFN2v9bs777G5XFhLByjFYvHJKGH7XSNQFCMNn3"),
      tokenAVault: pk("3eUeDHZMs9muEaUD5d1BQQZEWrrwWSJNeqC2G93YeBK5"),
      tokenBVault: pk("BZWeepbywd35hpbMXPLtp31XNq3sikeVQa8nXQCjakp1"),
      a: 0,
      b: 3,
      feeBps: 30,
    },
    {
      label: "SPCXon / USDC (market)",
      kind: "market",
      pool: pk("AUoC4y39VeaksN4sKZS5du3ckD6HQv1qYLHXtQw8EeKu"),
      tokenAVault: pk("FFXPRe7yWHBSxJSPhCR5KC1uz1QU1gmXASfTTaB2MxzS"),
      tokenBVault: pk("BJji5AuUr3Xo2uaEq2y3xe3gqgFs4ukRUUQgcMsTSV9V"),
      a: 2,
      b: 3,
      feeBps: 30,
    },
    {
      label: "SOL / USDC (market)",
      kind: "market",
      pool: pk("3n6nM4mN722rB8oa5RH2c3y75eaGemhveBBK1xu45qYL"),
      tokenAVault: pk("Bn83pTazSyX3agoq2Qidb3nBnGPC9LBwW4sT6aAPNKDr"),
      tokenBVault: pk("FkVY8M4BCmGX2huiYqd31QGeQwJWcg7gAALhwhXWBVY7"),
      a: 4,
      b: 3,
      feeBps: 10,
    },
  ],
  launchUsdPerShare: 168,
};

/** Fixed cp-amm accounts. */
export const CP_AMM = pk("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DAMM_POOL_AUTHORITY = pk("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DAMM_EVENT_AUTHORITY = pk("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

/** Index of an asset by symbol ("SPCXx", "USDC"...) or kind ("usdc", "sol"); -1 when absent. */
export function assetIndex(cfg: VaultConfig, which: string): number {
  const bySymbol = cfg.assets.findIndex((a) => a.symbol === which);
  return bySymbol >= 0 ? bySymbol : cfg.assets.findIndex((a) => a.kind === which.toLowerCase());
}
