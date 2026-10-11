//! Integer math for share accounting. Every rounding goes against the caller and in favour of
//! the vault.

/// `floor(x * num / den)` without a 256-bit intermediate: `num = q * den + rem`, so the product
/// splits into `q * x` (exact) and `rem * x / den`, where `rem * x < 2^128`.
pub fn mul_div_floor(x: u64, num: u128, den: u64) -> Option<u128> {
    if den == 0 {
        return None;
    }
    let den = den as u128;
    let (q, rem) = (num / den, num % den);
    q.checked_mul(x as u128)?.checked_add(rem * x as u128 / den)
}

/// Liquidity to add (round up) or remove (round down) for `shares` of a position holding
/// `liquidity`. Rounding happens per share unit, then multiplies, so it never overflows u128
/// for realistic supplies and always favours the vault.
pub fn liquidity_for_shares(shares: u64, liquidity: u128, supply: u64, round_up: bool) -> Option<u128> {
    if supply == 0 {
        return None;
    }
    let supply = supply as u128;
    let per_share = if round_up { liquidity.div_ceil(supply) } else { liquidity / supply };
    per_share.checked_mul(shares as u128)
}

/// The pro-rata part of an idle reserve balance for `shares`: rounded up when the user pays it
/// in, down when the user takes it out.
pub fn amount_for_shares(shares: u64, balance: u64, supply: u64, round_up: bool) -> Option<u64> {
    if supply == 0 {
        return None;
    }
    let (n, d) = (shares as u128 * balance as u128, supply as u128);
    u64::try_from(if round_up { n.div_ceil(d) } else { n / d }).ok()
}

/// The most liquidity two balances cover at a pool's reserves. cp-amm rounds the amounts it
/// pulls up, and `floor(balance * L / reserve)` keeps them within the balances.
pub fn liquidity_for_amounts(balance_a: u64, balance_b: u64, liquidity: u128, reserve_a: u64, reserve_b: u64) -> Option<u128> {
    Some(mul_div_floor(balance_a, liquidity, reserve_a)?.min(mul_div_floor(balance_b, liquidity, reserve_b)?))
}

/// `amount * bps / 10_000`, rounded down.
pub fn bps_of(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / 10_000) as u64
}

/// `ceil(x * num / den)`, the rounding-up twin of `mul_div_floor`.
pub fn mul_div_ceil(x: u64, num: u128, den: u64) -> Option<u128> {
    if den == 0 {
        return None;
    }
    let den = den as u128;
    let (q, rem) = (num / den, num % den);
    q.checked_mul(x as u128)?.checked_add((rem * x as u128).div_ceil(den))
}

/// `floor(amount * part / whole)` for `part <= whole`, where `part` and `whole` are pool
/// liquidities that may not fit next to `amount` in 128 bits. Both are shifted down until
/// `whole` fits in 64 bits, which costs at most one part in 2^63 of precision.
pub fn pro_rata(amount: u64, part: u128, whole: u128) -> u64 {
    if whole == 0 {
        return 0;
    }
    let shift = (128 - whole.leading_zeros()).saturating_sub(64);
    let (part, whole) = (part >> shift, whole >> shift);
    if whole == 0 {
        return 0;
    }
    (amount as u128 * part.min(whole) / whole) as u64
}

/// Value in nano-shares of `amount` raw units of a token with `decimals`, at `price` nano-shares
/// per whole token. Rounded down.
pub fn value_of(amount: u64, decimals: u8, price: u64) -> u128 {
    amount as u128 * price as u128 / 10u128.pow(decimals as u32)
}

/// Raw units of a token worth `value` nano-shares at `price`. Rounded down.
pub fn amount_for_value(value: u128, decimals: u8, price: u64) -> Option<u64> {
    if price == 0 {
        return None;
    }
    u64::try_from(value.checked_mul(10u128.pow(decimals as u32))? / price as u128).ok()
}

/// `part` as a share of `total`, in bps (0 when the total is zero).
pub fn weight_bps(part: u128, total: u128) -> i64 {
    if total == 0 {
        return 0;
    }
    (part.saturating_mul(10_000) / total) as i64
}

/// Whether two values sit within `band_bps` of each other, relative to the larger one.
pub fn within_band(a: u128, b: u128, band_bps: u16) -> bool {
    let (lo, hi) = (a.min(b), a.max(b));
    (hi - lo).saturating_mul(10_000) <= hi.saturating_mul(band_bps as u128)
}

/// The basket's dynamic fee, in signed bps, for a trade that moves a token's weight from `w0` to
/// `w1` (bps of the vault's value). It is measured at the midpoint, so a large trade pays for
/// the imbalance it creates along the way. `inflow` is a deposit, which costs more the more
/// overweight the token is; a redemption costs more the more underweight it leaves the token.
/// Trades that move the token towards its target pay less, down to a small discount.
pub fn dynamic_fee_bps(w0: i64, w1: i64, target: u16, inflow: bool, params: &crate::state::BasketParams) -> i64 {
    let mid = (w0 + w1) / 2;
    let deviation = if inflow { mid - target as i64 } else { target as i64 - mid };
    let fee = params.base_fee_bps as i64 + deviation * params.fee_slope_bps as i64 / 100;
    fee.clamp(-(params.max_discount_bps as i64), params.max_fee_bps as i64)
}

/// `value` after a signed fee in bps (a negative fee adds to it). Rounded down.
pub fn after_fee(value: u128, fee_bps: i64) -> u128 {
    value * (10_000 - fee_bps) as u128 / 10_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> crate::state::BasketParams {
        crate::state::BasketParams {
            band_bps: 200,
            base_fee_bps: 5,
            fee_slope_bps: 2,
            max_fee_bps: 100,
            max_discount_bps: 3,
            max_price_age: 600,
        }
    }

    #[test]
    fn dynamic_fee_follows_the_weight() {
        let p = params();
        // At target: the base fee, either way.
        assert_eq!(dynamic_fee_bps(3_000, 3_000, 3_000, true, &p), 5);
        assert_eq!(dynamic_fee_bps(3_000, 3_000, 3_000, false, &p), 5);
        // Depositing an overweight token: 10 points over at the midpoint costs 5 + 20.
        assert_eq!(dynamic_fee_bps(3_900, 4_100, 3_000, true, &p), 25);
        // Depositing an underweight one earns the capped discount.
        assert_eq!(dynamic_fee_bps(1_000, 1_200, 3_000, true, &p), -3);
        // Redeeming an underweight token costs more; an overweight one, less.
        assert_eq!(dynamic_fee_bps(1_200, 1_000, 3_000, false, &p), 43);
        assert_eq!(dynamic_fee_bps(4_100, 3_900, 3_000, false, &p), -3);
        // Capped at the maximum.
        assert_eq!(dynamic_fee_bps(10_000, 10_000, 0, true, &p), 100);
    }

    #[test]
    fn a_round_trip_never_earns_the_discount_twice() {
        // In then straight out of the same token: the two fees cancel their slopes and leave at
        // least the smaller of twice the base fee and the gap between the cap and the discount.
        let p = params();
        for (w0, w1, target) in [(1_000, 1_500, 3_000), (2_900, 3_100, 3_000), (5_000, 6_000, 3_000), (0, 9_000, 3_000)] {
            let total = dynamic_fee_bps(w0, w1, target, true, &p) + dynamic_fee_bps(w1, w0, target, false, &p);
            assert!(total >= 2 * p.base_fee_bps as i64 || total >= (p.max_fee_bps - p.max_discount_bps) as i64, "{w0} {w1}: {total}");
        }
    }

    #[test]
    fn values_and_amounts() {
        // 1 SPCX (6 decimals) and 1 SPCXon (9 decimals) are both one share.
        assert_eq!(value_of(1_000_000, 6, 1_000_000_000), 1_000_000_000);
        assert_eq!(value_of(1_000_000_000, 9, 1_000_000_000), 1_000_000_000);
        // 175 USDC at $175 a share.
        assert_eq!(value_of(175_000_000, 6, 5_714_285), 999_999_875);
        assert_eq!(amount_for_value(1_000_000_000, 8, 1_000_000_000), Some(100_000_000));
        assert_eq!(amount_for_value(1, 6, 0), None);
        assert_eq!(after_fee(10_000, 25), 9_975);
        assert_eq!(after_fee(10_000, -3), 10_003);
    }

    #[test]
    fn pro_rata_handles_large_liquidity() {
        assert_eq!(pro_rata(1_000, 1, 4), 250);
        let whole: u128 = 3 << 100;
        assert_eq!(pro_rata(u64::MAX, whole / 3, whole), u64::MAX / 3);
        assert_eq!(pro_rata(7, 5, 0), 0);
        assert_eq!(mul_div_ceil(7, 100, 3), Some(234));
    }

    #[test]
    fn bands_and_weights() {
        assert!(within_band(1_000, 1_020, 200));
        assert!(!within_band(1_000, 1_021, 200));
        assert!(within_band(0, 0, 0));
        assert_eq!(weight_bps(1, 3), 3_333);
        assert_eq!(weight_bps(1, 0), 0);
    }

    #[test]
    fn mul_div_matches_wide_math() {
        let num: u128 = 922_337_203_685_477_580 * 98_765_432_123;
        assert_eq!(mul_div_floor(7, 100, 3), Some(233));
        assert_eq!(
            mul_div_floor(1_000_000_000_000, num, 50_000_000_001),
            Some(num / 50_000_000_001 * 1_000_000_000_000 + (num % 50_000_000_001) * 1_000_000_000_000 / 50_000_000_001)
        );
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn share_rounding_favours_the_vault() {
        let (liquidity, supply) = (1_000_000_007u128, 1_000u64);
        let added = liquidity_for_shares(10, liquidity, supply, true).unwrap();
        let removed = liquidity_for_shares(10, liquidity, supply, false).unwrap();
        assert!(added >= removed);
        assert_eq!(liquidity_for_shares(1, 5, 0, true), None);

        assert_eq!(amount_for_shares(1, 10, 3, true), Some(4));
        assert_eq!(amount_for_shares(1, 10, 3, false), Some(3));
        // Paying in, then taking out the same shares, never takes out more than was paid.
        for balance in [0u64, 1, 7, 999, u64::MAX / 2] {
            let paid = amount_for_shares(13, balance, 1_000, true).unwrap();
            let taken = amount_for_shares(13, balance + paid, 1_013, false).unwrap();
            assert!(taken <= paid, "{balance}");
        }
    }

    #[test]
    fn liquidity_for_amounts_takes_the_scarcer_side() {
        // Pool 1M:500k with L = 1e9: 100k of A covers 1e8, 10k of B covers 2e7.
        assert_eq!(liquidity_for_amounts(100_000, 10_000, 1_000_000_000, 1_000_000, 500_000), Some(20_000_000));
        assert_eq!(liquidity_for_amounts(1, 1, 1, 0, 1), None);
    }

    #[test]
    fn bps() {
        assert_eq!(bps_of(10_000, 2_000), 2_000);
        assert_eq!(bps_of(u64::MAX, 10_000), u64::MAX);
        assert_eq!(bps_of(9, 1_000), 0);
    }
}
