// The vault's on-chain state in one RPC call: share supply, idle reserves, every vault pool with
// the vault's position in it, the market pools, target weights, the pause flag and the basket.

import { Connection } from "@solana/web3.js";
import { Basket, basketAddress, decodeBasket } from "./basket.js";
import { VaultConfig } from "./config.js";

export type PoolState = { liquidity: bigint; reserveA: bigint; reserveB: bigint };

export type VaultState = {
  slot: number;
  /** Share token supply, raw units. */
  supply: bigint;
  /** Idle balance of each reserve, raw units, in `assets` order. */
  reserves: bigint[];
  /** The vault's pools, with the vault's position liquidity, in `pools` order. */
  pools: (PoolState & { position: bigint })[];
  /** Market pools, in `marketPools` order. */
  market: PoolState[];
  /** The keeper's target share of the vault's value per pool, in basis points. */
  weights: number[];
  depositsPaused: boolean;
  /** Weights, caps, fee settings and the keeper's prices for single-token trades; null when the vault has no basket yet. */
  basket?: Basket | null;
};

const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);
const u16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getUint16(o, true);

/** cp-amm Pool: liquidity at 360, reserves at 680 and 688 (offsets include the discriminator). */
const poolOf = (d: Uint8Array): PoolState => ({ liquidity: u128(d, 360), reserveA: u64(d, 680), reserveB: u64(d, 688) });

// Vault account: 8-byte discriminator, admin/keeper/treasury, stock, share mint, arb_fee_bps,
// deposits_paused, bump, num_assets, 6 assets of 97 bytes, num_pools, 6 pools of 164 bytes.
const PAUSED_OFFSET = 8 + 96 + 8 + 32 + 2;
const POOLS_OFFSET = PAUSED_OFFSET + 1 + 1 + 1 + 6 * 97 + 1;
const WEIGHT_IN_POOL = 162;
const POOL_SLOT_LEN = 164;

export async function fetchVaultState(connection: Connection, cfg: VaultConfig): Promise<VaultState> {
  const keys = [
    cfg.vault,
    cfg.share.mint,
    ...cfg.assets.map((a) => a.reserve),
    ...cfg.pools.flatMap((p) => [p.pool, p.position!]),
    ...cfg.marketPools.map((p) => p.pool),
    basketAddress(cfg.program, cfg.vault),
  ];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, "confirmed");
  const data = value.map((i) => (i ? new Uint8Array(i.data) : null));
  const vault = data[0];
  const mint = data[1];
  if (!vault || !mint) throw new Error(`vault ${cfg.vault.toBase58()} not found on this cluster`);
  let k = 2;
  const reserves = cfg.assets.map(() => {
    const d = data[k++];
    return d ? u64(d, 64) : 0n;
  });
  const pools = cfg.pools.map((p) => {
    const pool = data[k++];
    const position = data[k++];
    if (!pool || !position) throw new Error(`vault pool ${p.label} not found`);
    return { ...poolOf(pool), position: u128(position, 152) };
  });
  const market = cfg.marketPools.map(() => {
    const d = data[k++];
    return d ? poolOf(d) : { liquidity: 0n, reserveA: 0n, reserveB: 0n };
  });
  const basket = data[k++];
  return {
    slot: context.slot,
    supply: u64(mint, 36),
    reserves,
    pools,
    market,
    weights: cfg.pools.map((_, i) => u16(vault, POOLS_OFFSET + i * POOL_SLOT_LEN + WEIGHT_IN_POOL)),
    depositsPaused: vault[PAUSED_OFFSET] === 1,
    basket: basket ? decodeBasket(basket) : null,
  };
}
