// The partner-facing client: read a vault and a customer's position, quote deposits and
// redemptions, and build unsigned transactions. It never holds keys: the partner signs with its
// custody (a backend key, an MPC service, an embedded or browser wallet) and sends.

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Activity, fetchActivity } from "./activity.js";
import { DEVNET_SPCX, Pool, PoolKind, TokenInfo, VaultConfig, assetIndex } from "./config.js";
import {
  BasketParams,
  Refusal,
  SingleDepositPlan,
  basketAddress,
  breaker,
  describeRefusal,
  marginalFeeBps,
  pegged,
  planRedeemTo,
  planSingleDeposit,
  planSingleRedeem,
  valueBook,
} from "./basket.js";
import {
  createTokenAccountIx,
  depositIx,
  depositSingleIx,
  harvestIx,
  redeemIx,
  redeemSingleIx,
  swapIx,
  tokenAccount,
  unwrapSolIx,
  wrapSolIxs,
} from "./instructions.js";
import { Swap, ZapInPlan, ZapOutPlan, applyBps, exposure, poolValue, prices, tokensForShares, usdValue, vaultValue, zapIn, zapOut } from "./quote.js";
import { VaultState, fetchVaultState } from "./state.js";

export type StockwovenOptions = {
  connection: Connection;
  /** Which vault. Default: swSPCX on devnet. */
  vault?: VaultConfig;
  /** Tolerance on deposits with the vault's mix and on redemptions in kind. Default 50 (0.5%). */
  slippageBps?: number;
  /** Per-swap tolerance on one-token deposits and redemptions. Default 50 (0.5%). */
  routeSlippageBps?: number;
  /** Compute unit limit set on every transaction. Default 1,400,000. */
  computeUnits?: number;
  /**
   * One-token deposits and redemptions to one asset are refused when their swaps would lose more
   * than this share of the value (fees, price impact and the slippage margin). Default 300 (3%).
   */
  maxLossBps?: number;
};

/**
 * What the customer pays with. `"mix"` pays every asset in the vault's current proportions for an
 * exact number of `shares`; any asset (by symbol: "SPCXx", "SPCX", "SPCXon", "USDC", "SOL") pays
 * with that one token: the vault takes it alone (`deposit_single`), or, when it cannot, the
 * transaction swaps it into the mix.
 */
export type DepositInput = { pay: "mix"; shares: bigint } | { pay: string; amount: bigint };

export type DepositQuote = {
  input: DepositInput;
  /**
   * "mix": one transaction. "single": one transaction; the vault takes the token alone, valued 1:1
   * for an issuer token, or converts it into an underweight issuer token. "swap" (the fallback when
   * the vault cannot take it alone): two, the swaps into the mix, then the deposit.
   */
  route: "mix" | "single" | "swap";
  /** Share tokens minted, raw units. "mix" and "swap" mint exactly this; "single" mints about this, and at least `minShares`. */
  shares: bigint;
  /** The least the deposit mints, or it fails. Equals `shares` except on the "single" route. */
  minShares: bigint;
  /** "single" only: the vault's dynamic fee in signed bps (negative is a discount); it stays in the vault. */
  feeBps?: number;
  /** "single" only: the issuer token the deposit becomes in the vault. */
  into?: TokenInfo;
  /** "single" only, when the token does not go in as itself: it is USDC or SOL, at its cap, or outside its 1:1 band. */
  redirect?: "quote" | "cap" | "depeg";
  /** "swap" only: why the vault could not take the token alone (no basket, prices stale, a pool off its band…). */
  fallbackReason?: string;
  /** The most the customer can be charged per token; anything the deposit doesn't take stays in their wallet. */
  maxSpend: { token: TokenInfo; amount: bigint }[];
  /** `shares` in USD at the vault's value per share. */
  valueUsd: number;
  /** USD value of what the customer pays. */
  costUsd: number;
  /** Slot of the state the quote was computed from. */
  slot: number;
  plan: { route: "mix"; maxAmounts: bigint[] } | { route: "single"; single: SingleDepositPlan<Pool> } | { route: "swap"; zap: ZapInPlan };
};

export type RedeemQuote = {
  shares: bigint;
  /** "kind": a slice of every asset. Otherwise the asset everything is swapped into. */
  receive: "kind" | TokenInfo;
  /** What the customer gets at least, per token (in kind) or of the one token. */
  payout: { token: TokenInfo; min: bigint }[];
  valueUsd: number;
  slot: number;
  /** One-token routes on the basket: the vault's dynamic fee in signed bps (negative is a discount). */
  feeBps?: number;
  /** For USDC or SOL on the basket: the issuer token the vault pays, which the same transaction sells. */
  via?: TokenInfo;
  /** On the in-kind-then-swap fallback: why the vault could not pay one token. */
  fallbackReason?: string;
  plan:
    | { route: "kind"; minAmounts: bigint[] }
    | { route: "single"; asset: number; minAmount: bigint; output: number; swaps: Swap[] }
    | { route: "swap"; output: number; zap: ZapOutPlan };
};

export type BuildOptions = {
  /** The customer's wallet: it signs and owns the token accounts. */
  owner: PublicKey;
  /** Who pays network fees and token-account rent. Default: the owner. A partner can sponsor its customers. */
  feePayer?: PublicKey;
  /** Priority fee in micro-lamports per compute unit. Default: none. */
  priorityFee?: number;
};

export type BuiltTransactions = {
  /** Unsigned v0 transactions. Sign all of them, then send and confirm them in this order. */
  transactions: VersionedTransaction[];
  /** Every key that must sign each transaction (the owner and, if different, the fee payer). */
  signers: PublicKey[];
  blockhash: string;
  lastValidBlockHeight: number;
};

export type PoolInfo = { label: string; kind: PoolKind; feeBps: number; valueUsd: number; targetWeightBps: number; pool: PublicKey };

/** Single-token deposits and redemptions: weights, caps, fees and the circuit breaker. */
export type BasketInfo = {
  address: PublicKey;
  /** "open" when single-token trades work now; otherwise the breaker that stops them. */
  status: "open" | "no-basket" | "invalid" | "stale" | "pool-out-of-band";
  /** A sentence for the status, null when open. */
  reason: string | null;
  /** Age of the keeper's prices, seconds. */
  pricesAgeSec: number;
  params: BasketParams;
  assets: {
    token: TokenInfo;
    /** Issuer token of the stock (taken and paid out alone, 1:1). */
    isStock: boolean;
    weightBps: number;
    targetWeightBps: number;
    maxWeightBps: number;
    /** Issuer tokens: whether the market price sits inside the 1:1 band. */
    pegged: boolean;
    /** The keeper's market price against one share, in bps (0 = exactly 1:1). */
    priceVsShareBps: number;
    /** Fee on a small deposit or redemption of this token alone, signed bps; null when it can't go in or out alone. */
    depositFeeBps: number | null;
    redeemFeeBps: number | null;
  }[];
};

export type VaultInfo = {
  stock: string;
  share: VaultConfig["share"];
  assets: TokenInfo[];
  /** USD value of one whole share token. */
  valuePerShare: number;
  /** Change of `valuePerShare` since launch, in USD terms (it includes the stock's own price move). */
  sinceLaunch: number;
  /** USD value of everything the vault holds. */
  totalValue: number;
  /** Share token supply, raw units. */
  supply: bigint;
  /** Share of the value in stock tokens, USDC and SOL (0–1). */
  exposure: { stock: number; usdc: number; sol: number };
  pools: PoolInfo[];
  /** USD value of the idle reserves, the keeper's working capital. */
  idleUsd: number;
  /** USD per whole token, by symbol, read from the pools. */
  prices: Record<string, number>;
  depositsPaused: boolean;
  /** Single-token deposits and redemptions; null when the vault has no basket yet. */
  basket: BasketInfo | null;
  slot: number;
};

export type Position = {
  owner: PublicKey;
  /** Share tokens held, raw units. */
  shares: bigint;
  valueUsd: number;
  /** What redeeming all of them in kind would pay now, raw units. */
  redeemable: { token: TokenInfo; amount: bigint }[];
};

const nowSec = () => Math.floor(Date.now() / 1000);

export class Stockwoven {
  readonly connection: Connection;
  readonly vault: VaultConfig;
  readonly slippageBps: number;
  readonly routeSlippageBps: number;
  readonly computeUnits: number;
  readonly maxLossBps: number;
  private lookupTable?: Promise<AddressLookupTableAccount | null>;

  constructor(options: StockwovenOptions) {
    this.connection = options.connection;
    this.vault = options.vault ?? DEVNET_SPCX;
    this.slippageBps = options.slippageBps ?? 50;
    this.routeSlippageBps = options.routeSlippageBps ?? 50;
    this.computeUnits = options.computeUnits ?? 1_400_000;
    this.maxLossBps = options.maxLossBps ?? 300;
  }

  /** Throws when a swap route loses more than `maxLossBps` of the value going in. */
  private checkLoss(usdIn: number, usdOut: number) {
    const loss = usdIn > 0 ? 1 - usdOut / usdIn : 0;
    if (loss * 10_000 > this.maxLossBps) {
      throw new Error(
        `the swaps would lose ${(loss * 100).toFixed(1)}% of the value (limit ${this.maxLossBps / 100}%): ` +
          "the pools are too shallow for this amount; try less, or pay with the vault's mix",
      );
    }
  }

  /** Raw on-chain state. Pass it to quotes to price several amounts off one read. */
  getState(): Promise<VaultState> {
    return fetchVaultState(this.connection, this.vault);
  }

  /** The asset index for a symbol ("SPCXx", "USDC"...) or kind ("usdc", "sol"). Throws when unknown. */
  asset(which: string): number {
    const k = assetIndex(this.vault, which);
    if (k < 0) throw new Error(`${which} is not an asset of the ${this.vault.share.symbol} vault (${this.vault.assets.map((a) => a.symbol).join(", ")})`);
    return k;
  }

  async getVault(state?: VaultState): Promise<VaultInfo> {
    const cfg = this.vault;
    const st = state ?? (await this.getState());
    const { px, total, perShare } = vaultValue(cfg, st);
    return {
      stock: cfg.stock,
      share: cfg.share,
      assets: cfg.assets,
      valuePerShare: perShare,
      sinceLaunch: perShare / cfg.launchUsdPerShare - 1,
      totalValue: total,
      supply: st.supply,
      exposure: exposure(cfg, st),
      pools: cfg.pools.map((p, i) => ({
        label: p.label,
        kind: p.kind,
        feeBps: p.feeBps,
        valueUsd: poolValue(cfg, st, px, i),
        targetWeightBps: st.weights[i],
        pool: p.pool,
      })),
      idleUsd: usdValue(cfg, st.reserves, px),
      prices: Object.fromEntries(cfg.assets.map((a, k) => [a.symbol, px[k]])),
      depositsPaused: st.depositsPaused,
      basket: this.basketInfo(st),
      slot: st.slot,
    };
  }

  private basketInfo(st: VaultState): BasketInfo | null {
    const cfg = this.vault;
    const basket = st.basket;
    if (!basket) return null;
    const v = this.basketVault();
    const stop = breaker(v, basket, st, nowSec());
    const book = basket.numAssets === cfg.assets.length ? valueBook(v, basket, st) : null;
    const status: BasketInfo["status"] = !stop
      ? "open"
      : stop.kind === "PricesStale"
        ? "stale"
        : stop.kind === "PoolOutOfBand"
          ? "pool-out-of-band"
          : stop.kind === "NoBasket"
            ? "no-basket"
            : "invalid";
    return {
      address: basketAddress(cfg.program, cfg.vault),
      status,
      reason: stop ? this.describe(stop) : null,
      pricesAgeSec: nowSec() - basket.pricesUpdatedAt,
      params: basket.params,
      assets: cfg.assets.map((token, k) => {
        const a = basket.assets[k];
        const ok = !stop && !!book && !!a && pegged(basket, k);
        return {
          token,
          isStock: !!a?.isStock,
          weightBps: book?.weights[k] ?? 0,
          targetWeightBps: a?.targetWeightBps ?? 0,
          maxWeightBps: a?.maxWeightBps ?? 0,
          pegged: !!a && pegged(basket, k),
          priceVsShareBps: a ? Math.round((Number(a.price) / 1e9 - 1) * 10_000) : 0,
          depositFeeBps: ok && book.weights[k] < a.maxWeightBps ? marginalFeeBps(basket, book, k, true) : null,
          redeemFeeBps: ok ? marginalFeeBps(basket, book, k, false) : null,
        };
      }),
    };
  }

  /** The vault's shape for the basket math. */
  private basketVault() {
    return { decimals: this.vault.assets.map((a) => a.decimals), pools: this.vault.pools, marketPools: this.vault.marketPools };
  }

  private describe(r: Refusal) {
    return describeRefusal(r, (k) => this.vault.assets[k].symbol, (i) => this.vault.pools[i].label);
  }

  async getPosition(owner: PublicKey, state?: VaultState): Promise<Position> {
    const cfg = this.vault;
    const [st, account] = await Promise.all([state ?? this.getState(), this.connection.getAccountInfo(tokenAccount(owner, cfg.share), "confirmed")]);
    const shares = account ? new DataView(account.data.buffer, account.data.byteOffset).getBigUint64(64, true) : 0n;
    const out = tokensForShares(cfg, st, shares, false);
    return {
      owner,
      shares,
      valueUsd: (Number(shares) / 10 ** cfg.share.decimals) * vaultValue(cfg, st).perShare,
      redeemable: cfg.assets.map((token, k) => ({ token, amount: out[k] })),
    };
  }

  /** The owner's latest transactions, newest first. */
  getActivity(owner: PublicKey, limit = 20): Promise<Activity[]> {
    return fetchActivity(this.connection, this.vault, owner, limit);
  }

  /** Prices a deposit. See `DepositInput` for what the customer can pay with. */
  async quoteDeposit(input: DepositInput, state?: VaultState): Promise<DepositQuote> {
    const cfg = this.vault;
    const st = state ?? (await this.getState());
    if (st.depositsPaused) throw new Error("deposits are paused by the vault; redemptions stay open");
    const { px, perShare } = vaultValue(cfg, st);
    const valueOf = (shares: bigint) => (Number(shares) / 10 ** cfg.share.decimals) * perShare;

    if (input.pay === "mix") {
      const { shares } = input as { shares: bigint };
      if (shares <= 0n) throw new Error("shares must be positive");
      const maxAmounts = tokensForShares(cfg, st, shares, true).map((x) => applyBps(x, -this.slippageBps) + 1n);
      return {
        input,
        route: "mix",
        shares,
        minShares: shares,
        maxSpend: cfg.assets.map((token, k) => ({ token, amount: maxAmounts[k] })),
        valueUsd: valueOf(shares),
        costUsd: usdValue(cfg, tokensForShares(cfg, st, shares, true), px),
        slot: st.slot,
        plan: { route: "mix", maxAmounts },
      };
    }

    const { amount } = input as { amount: bigint };
    if (amount <= 0n) throw new Error("amount must be positive");
    const k = this.asset(input.pay);

    // Alone, on the basket: one transaction.
    const single = planSingleDeposit(this.basketVault(), st.basket, st, k, amount, nowSec(), this.routeSlippageBps);
    if ("plan" in single) {
      const p = single.plan;
      const usdIn = (Number(amount) / 10 ** cfg.assets[k].decimals) * px[k];
      this.checkLoss(usdIn, valueOf(p.shares));
      return {
        input,
        route: "single",
        shares: p.shares,
        minShares: p.minShares,
        feeBps: p.feeBps,
        into: cfg.assets[p.into],
        redirect: p.redirect ?? undefined,
        maxSpend: [{ token: cfg.assets[k], amount }],
        valueUsd: valueOf(p.shares),
        costUsd: usdIn,
        slot: st.slot,
        plan: { route: "single", single: p },
      };
    }

    // Otherwise swapped into the mix: two transactions.
    const zap = zapIn(cfg, st, k, amount, this.routeSlippageBps);
    if (!zap) throw new Error("amount too small to deposit");
    this.checkLoss(zap.usdIn, zap.usdOut);
    const spend = cfg.assets.map((_, i) => (i === k ? amount : 0n) + zap.fromWallet[i]);
    return {
      input,
      route: "swap",
      shares: zap.shares,
      minShares: zap.shares,
      fallbackReason: this.describe(single.refused),
      maxSpend: cfg.assets.map((token, i) => ({ token, amount: spend[i] })).filter((x) => x.amount > 0n),
      valueUsd: valueOf(zap.shares),
      costUsd: zap.usdIn,
      slot: st.slot,
      plan: { route: "swap", zap },
    };
  }

  /**
   * Prices redeeming `shares`. In kind (the default), the vault pays a slice of every asset. With
   * `receive` set to an issuer token, the vault pays that token alone (`redeem_single`, with the
   * dynamic fee); set to USDC or SOL, it pays the issuer token that sells for the most and the same
   * transaction sells it. When the vault can't pay one token (no basket, the breaker), it falls
   * back to redeeming in kind and swapping the rest into `receive`.
   */
  async quoteRedeem(shares: bigint, options: { receive?: "kind" | string } = {}, state?: VaultState): Promise<RedeemQuote> {
    if (shares <= 0n) throw new Error("shares must be positive");
    const cfg = this.vault;
    const st = state ?? (await this.getState());
    const valueUsd = (Number(shares) / 10 ** cfg.share.decimals) * vaultValue(cfg, st).perShare;
    const receive = options.receive ?? "kind";
    if (receive === "kind") {
      const minAmounts = tokensForShares(cfg, st, shares, false).map((x) => applyBps(x, this.slippageBps));
      return {
        shares,
        receive: "kind",
        payout: cfg.assets.map((token, k) => ({ token, min: minAmounts[k] })),
        valueUsd,
        slot: st.slot,
        plan: { route: "kind", minAmounts },
      };
    }
    const output = this.asset(receive);
    const v = this.basketVault();
    const px = prices(cfg, st);
    const token = cfg.assets[output];
    const usdOf = (raw: bigint, k: number) => (Number(raw) / 10 ** cfg.assets[k].decimals) * px[k];
    let refused: Refusal;
    if (st.basket?.assets[output]?.isStock) {
      const r = planSingleRedeem(v, st.basket, st, shares, output, nowSec());
      if ("plan" in r) {
        const minAmount = applyBps(r.plan.amount, this.slippageBps);
        return {
          shares,
          receive: token,
          payout: [{ token, min: minAmount }],
          valueUsd,
          slot: st.slot,
          feeBps: r.plan.feeBps,
          plan: { route: "single", asset: output, minAmount, output, swaps: [] },
        };
      }
      refused = r.refused;
    } else {
      const r = planRedeemTo(v, st.basket, st, shares, output, nowSec(), this.routeSlippageBps);
      if ("plan" in r) {
        const p = r.plan;
        this.checkLoss(valueUsd, usdOf(p.out, output));
        return {
          shares,
          receive: token,
          payout: [{ token, min: p.out }],
          valueUsd,
          slot: st.slot,
          feeBps: p.redeem.feeBps,
          via: cfg.assets[p.redeem.asset],
          plan: { route: "single", asset: p.redeem.asset, minAmount: p.minAmount, output, swaps: p.swaps },
        };
      }
      refused = r.refused;
    }

    const zap = zapOut(cfg, st, shares, output, this.routeSlippageBps);
    if (!zap) throw new Error("shares too small to redeem");
    this.checkLoss(valueUsd, zap.usdOut);
    return {
      shares,
      receive: token,
      payout: [{ token, min: zap.out }],
      valueUsd,
      slot: st.slot,
      fallbackReason: this.describe(refused),
      plan: { route: "swap", output, zap },
    };
  }

  /**
   * The deposit's instructions as steps, one transaction each, without compute budget: for partners
   * composing their own transactions. `exists` (one flag per asset, then the share token) skips
   * creating token accounts the owner already has.
   */
  depositSteps(quote: DepositQuote, owner: PublicKey, feePayer: PublicKey = owner, exists: boolean[] = []): TransactionInstruction[][] {
    const cfg = this.vault;
    const sol = assetIndex(cfg, "sol");
    const accounts = this.accountIxs(owner, feePayer, exists);
    const unwrap = sol >= 0 ? [unwrapSolIx(owner)] : [];
    if (quote.plan.route === "mix") {
      const max = quote.plan.maxAmounts;
      const wrap = sol >= 0 && max[sol] > 0n ? wrapSolIxs(owner, max[sol]) : [];
      return [[...accounts, ...wrap, depositIx(cfg, owner, quote.shares, max), ...unwrap]];
    }
    if (quote.plan.route === "single") {
      const p = quote.plan.single;
      // Only the accounts this deposit touches: the token paid, the token deposited, the share token.
      const needed = this.accountIxs(owner, feePayer, exists, [p.input, p.mint]);
      const wrap = sol >= 0 && p.input === sol ? wrapSolIxs(owner, p.amountIn) : [];
      const pre = p.preSwap ? [swapIx(cfg, p.preSwap.pool, owner, p.preSwap.aToB, p.preSwap.amountIn, p.preSwap.minOut)] : [];
      const deposit = depositSingleIx(cfg, owner, p.mint, p.depositAmount, p.minShares, p.convert?.pool);
      return [[...needed, ...wrap, ...pre, deposit, ...(wrap.length > 0 || p.mint === sol ? unwrap : [])]];
    }
    const zap = quote.plan.zap;
    const solIn = sol < 0 ? 0n : (zap.input === sol ? zap.amountIn : 0n) + zap.fromWallet[sol];
    return [
      [...accounts, ...(solIn > 0n ? wrapSolIxs(owner, solIn) : []), ...this.swapIxs(zap.swaps, owner)],
      [depositIx(cfg, owner, zap.shares, zap.maxAmounts), ...unwrap],
    ];
  }

  /** The redemption's instructions as steps (one), without compute budget. */
  redeemSteps(quote: RedeemQuote, owner: PublicKey, feePayer: PublicKey = owner, exists: boolean[] = []): TransactionInstruction[][] {
    const cfg = this.vault;
    const accounts = this.accountIxs(owner, feePayer, exists);
    const unwrap = assetIndex(cfg, "sol") >= 0 ? [unwrapSolIx(owner)] : [];
    if (quote.plan.route === "kind") return [[...accounts, redeemIx(cfg, owner, quote.shares, quote.plan.minAmounts), ...unwrap]];
    if (quote.plan.route === "single") {
      const p = quote.plan;
      const needed = this.accountIxs(owner, feePayer, exists, [p.asset, p.output, ...p.swaps.flatMap((s) => [s.pool.a, s.pool.b])]);
      const sol = assetIndex(cfg, "sol");
      return [[...needed, redeemSingleIx(cfg, owner, p.asset, quote.shares, p.minAmount), ...this.swapIxs(p.swaps, owner), ...(p.output === sol ? unwrap : [])]];
    }
    const zap = quote.plan.zap;
    return [[...accounts, redeemIx(cfg, owner, quote.shares, zap.minAmounts), ...this.swapIxs(zap.swaps, owner), ...unwrap]];
  }

  /** Unsigned v0 transactions for the deposit (one for the mix, two for a one-token deposit). */
  async buildDeposit(quote: DepositQuote, options: BuildOptions): Promise<BuiltTransactions> {
    const feePayer = options.feePayer ?? options.owner;
    return this.build(this.depositSteps(quote, options.owner, feePayer, await this.existing(options.owner)), options);
  }

  /** An unsigned v0 transaction for the redemption. */
  async buildRedeem(quote: RedeemQuote, options: BuildOptions): Promise<BuiltTransactions> {
    const feePayer = options.feePayer ?? options.owner;
    return this.build(this.redeemSteps(quote, options.owner, feePayer, await this.existing(options.owner)), options);
  }

  /** Permissionless: sends every vault pool's protocol fee to the treasury. `caller` signs and pays. */
  buildHarvest(caller: PublicKey): Promise<BuiltTransactions> {
    const cfg = this.vault;
    // Each pool pays its fee in token B to the treasury's account for it, which may not exist yet
    // (a wSOL account is closed whenever its owner unwraps).
    const feeTokens = [...new Set(cfg.pools.map((p) => p.b))].map((k) => cfg.assets[k]);
    return this.build(
      [[...feeTokens.map((t) => createTokenAccountIx(caller, cfg.treasury, t)), ...cfg.pools.map((_, i) => harvestIx(cfg, caller, i))]],
      { owner: caller },
    );
  }

  /**
   * For custodial backends: signs every transaction with `keypairs` (the owner and the fee payer),
   * then sends and confirms them in order. Returns the signatures. Stops at the first failure.
   */
  async sendAll(built: BuiltTransactions, keypairs: Keypair[]): Promise<string[]> {
    const signatures: string[] = [];
    for (const tx of built.transactions) {
      tx.sign(keypairs.filter((k) => built.signers.some((s) => s.equals(k.publicKey))));
      const signature = await this.connection.sendTransaction(tx);
      const result = await this.connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        "confirmed",
      );
      if (result.value.err) throw Object.assign(new Error(JSON.stringify(result.value.err)), { signature });
      signatures.push(signature);
    }
    return signatures;
  }

  private swapIxs(swaps: Swap[], owner: PublicKey) {
    return swaps.map((s) => swapIx(this.vault, s.pool as Pool, owner, s.aToB, s.amountIn, s.minOut));
  }

  /** Opens the owner's missing token accounts: every asset and the share token, or only `assets` and the share token. */
  private accountIxs(owner: PublicKey, feePayer: PublicKey, exists: boolean[], assets?: number[]) {
    const share = this.vault.assets.length;
    return [...this.vault.assets, this.vault.share]
      .filter((_, i) => !exists[i] && (!assets || i === share || assets.includes(i)))
      .map((t) => createTokenAccountIx(feePayer, owner, t));
  }

  /** Which of the owner's token accounts (each asset, then the share token) already exist. */
  private async existing(owner: PublicKey) {
    const tokens = [...this.vault.assets, this.vault.share];
    const infos = await this.connection.getMultipleAccountsInfo(tokens.map((t) => tokenAccount(owner, t)), "confirmed");
    return infos.map((i) => !!i);
  }

  private async build(steps: TransactionInstruction[][], options: BuildOptions): Promise<BuiltTransactions> {
    const feePayer = options.feePayer ?? options.owner;
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnits })];
    if (options.priorityFee) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: options.priorityFee }));
    const [{ blockhash, lastValidBlockHeight }, table] = await Promise.all([this.connection.getLatestBlockhash("confirmed"), this.getLookupTable()]);
    const transactions = steps.map((instructions) => {
      const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: [...budget, ...instructions] });
      return new VersionedTransaction(message.compileToV0Message(table ? [table] : []));
    });
    const signers = feePayer.equals(options.owner) ? [options.owner] : [feePayer, options.owner];
    return { transactions, signers, blockhash, lastValidBlockHeight };
  }

  /** The vault's lookup table keeps deposits and redeems (about 45 accounts) under the size limit. Fetched once. */
  private getLookupTable() {
    this.lookupTable ??= this.connection.getAddressLookupTable(this.vault.lookupTable).then(
      (r) => r.value,
      (e) => {
        this.lookupTable = undefined; // retry on the next build
        throw e;
      },
    );
    return this.lookupTable;
  }
}
