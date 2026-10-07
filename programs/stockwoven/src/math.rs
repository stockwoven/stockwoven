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

#[cfg(test)]
mod tests {
    use super::*;

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
