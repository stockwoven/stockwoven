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
import { createTokenAccountIx, depositIx, harvestIx, redeemIx, swapIx, tokenAccount, unwrapSolIx, wrapSolIxs } from "./instructions.js";
import { Swap, ZapInPlan, ZapOutPlan, applyBps, exposure, poolValue, tokensForShares, usdValue, vaultValue, zapIn, zapOut } from "./quote.js";
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
 * with that one token, which the transaction swaps into the mix.
 */
export type DepositInput = { pay: "mix"; shares: bigint } | { pay: string; amount: bigint };

export type DepositQuote = {
  input: DepositInput;
  /** "mix": one transaction. "swap": two, the swaps then the deposit (one transaction would pass the runtime's instruction limit). */
  route: "mix" | "swap";
  /** Share tokens minted, raw units. The deposit mints exactly this or fails. */
  shares: bigint;
  /** The most the customer can be charged per token; anything the deposit doesn't take stays in their wallet. */
  maxSpend: { token: TokenInfo; amount: bigint }[];
  /** `shares` in USD at the vault's value per share. */
  valueUsd: number;
  /** USD value of what the customer pays. */
  costUsd: number;
  /** Slot of the state the quote was computed from. */
  slot: number;
  plan: { route: "mix"; maxAmounts: bigint[] } | { route: "swap"; zap: ZapInPlan };
};

export type RedeemQuote = {
  shares: bigint;
  /** "kind": a slice of every asset. Otherwise the asset everything is swapped into. */
  receive: "kind" | TokenInfo;
  /** What the customer gets at least, per token (in kind) or of the one token. */
  payout: { token: TokenInfo; min: bigint }[];
  valueUsd: number;
  slot: number;
  plan: { route: "kind"; minAmounts: bigint[] } | { route: "swap"; output: number; zap: ZapOutPlan };
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
      slot: st.slot,
    };
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
    const zap = zapIn(cfg, st, k, amount, this.routeSlippageBps);
    if (!zap) throw new Error("amount too small to deposit");
    this.checkLoss(zap.usdIn, zap.usdOut);
    const spend = cfg.assets.map((_, i) => (i === k ? amount : 0n) + zap.fromWallet[i]);
    return {
      input,
      route: "swap",
      shares: zap.shares,
      maxSpend: cfg.assets.map((token, i) => ({ token, amount: spend[i] })).filter((x) => x.amount > 0n),
      valueUsd: valueOf(zap.shares),
      costUsd: zap.usdIn,
      slot: st.slot,
      plan: { route: "swap", zap },
    };
  }

  /**
   * Prices redeeming `shares`. In kind (the default), the vault pays a slice of every asset; with
   * `receive` set to an asset ("USDC"...), the same transaction swaps the rest into it.
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
    const zap = zapOut(cfg, st, shares, output, this.routeSlippageBps);
    if (!zap) throw new Error("shares too small to redeem");
    this.checkLoss(valueUsd, zap.usdOut);
    return {
      shares,
      receive: cfg.assets[output],
      payout: [{ token: cfg.assets[output], min: zap.out }],
      valueUsd,
      slot: st.slot,
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

  private accountIxs(owner: PublicKey, feePayer: PublicKey, exists: boolean[]) {
    return [...this.vault.assets, this.vault.share]
      .filter((_, i) => !exists[i])
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
