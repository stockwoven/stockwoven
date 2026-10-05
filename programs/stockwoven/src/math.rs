//! Integer math for share accounting and the single-token zap. Every rounding goes against the
//! caller and in favour of the vault.

/// Floor of the square root.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x0 = n / 2 + 1;
    let mut x1 = (x0 + n / x0) / 2;
    while x1 < x0 {
        x0 = x1;
        x1 = (x0 + n / x0) / 2;
    }
    x0
}

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

/// Liquidity behind one raw share unit. Before any shares exist it is the vault's launch ratio.
fn liquidity_per_share(vault_liquidity: u128, supply: u64, launch_ratio: u128, round_up: bool) -> Option<u128> {
    if supply == 0 {
        return Some(launch_ratio);
    }
    let supply = supply as u128;
    Some(if round_up { vault_liquidity.div_ceil(supply) } else { vault_liquidity / supply })
}

/// Liquidity to add (round up) or remove (round down) for `shares`.
pub fn liquidity_for_shares(
    shares: u64,
    vault_liquidity: u128,
    supply: u64,
    launch_ratio: u128,
    round_up: bool,
) -> Option<u128> {
    liquidity_per_share(vault_liquidity, supply, launch_ratio, round_up)?.checked_mul(shares as u128)
}

/// Shares minted for `liquidity` added to the vault (rounded down).
pub fn shares_for_liquidity(liquidity: u128, vault_liquidity: u128, supply: u64, launch_ratio: u128) -> Option<u64> {
    let per_share = liquidity_per_share(vault_liquidity, supply, launch_ratio, true)?;
    if per_share == 0 {
        return None;
    }
    u64::try_from(liquidity / per_share).ok()
}

/// How much of `amount_in` to swap so the rest matches the pool's ratio afterwards, on x·y = k
/// ignoring the trading fee: `s = sqrt(r · (r + a)) − r`. The fee leaves a small remainder of the
/// input token, which the zap refunds.
pub fn zap_swap_amount(reserve_in: u64, amount_in: u64) -> Option<u64> {
    let r = reserve_in as u128;
    let n = r.checked_mul(r.checked_add(amount_in as u128)?)?;
    u64::try_from(isqrt(n) - r).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_is_floor() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 64, u64::MAX as u128, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n, "{n}");
            assert!((r + 1).checked_mul(r + 1).map_or(true, |s| s > n), "{n}");
        }
    }

    #[test]
    fn mul_div_matches_wide_math() {
        let num: u128 = 922_337_203_685_477_580 * 98_765_432_123;
        assert_eq!(mul_div_floor(7, 100, 3), Some(233));
        assert_eq!(mul_div_floor(1_000_000_000_000, num, 50_000_000_001), Some(num / 50_000_000_001 * 1_000_000_000_000 + (num % 50_000_000_001) * 1_000_000_000_000 / 50_000_000_001));
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn share_rounding_favours_the_vault() {
        let (vault_liquidity, supply, launch) = (1_000_000_007u128, 1_000u64, 1_000_000u128);
        let added = liquidity_for_shares(10, vault_liquidity, supply, launch, true).unwrap();
        let removed = liquidity_for_shares(10, vault_liquidity, supply, launch, false).unwrap();
        assert!(added >= removed);
        // Depositing the liquidity behind 10 shares never mints more than 10.
        assert!(shares_for_liquidity(removed, vault_liquidity, supply, launch).unwrap() <= 10);
        // Empty vault: the launch ratio applies.
        assert_eq!(shares_for_liquidity(5_000_000, 0, 0, launch), Some(5));
    }

    #[test]
    fn zap_split_balances_xyk() {
        // Pool 1M:500k, deposit 100k of A: after the swap, what is left of A and the B received
        // sit in the same ratio as the pool.
        let (x, y, a) = (1_000_000u64, 500_000u64, 100_000u64);
        let s = zap_swap_amount(x, a).unwrap();
        assert_eq!(s, 48_808);
        let out = y * s / (x + s);
        let (ra, rb) = ((x + s) as f64, (y - out) as f64);
        let (a_left, b_got) = ((a - s) as f64, out as f64);
        assert!((a_left / b_got - ra / rb).abs() / (ra / rb) < 1e-3);
    }
}
