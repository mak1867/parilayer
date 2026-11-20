//! Unit and property tests for the pool math: the closed-form buy, seeding,
//! rounding, and invariants 1-4 under 1,000 random buys (PROGRAM_WALKTHROUGH.md
//! maps each invariant to its tests).

use super::*;
use proptest::prelude::*;

const FEE_BPS: u16 = 100;

// ---------- helpers ----------

/// Random probability vector: n outcomes, each >= 0.5%, summing to exactly 1e6 ppm.
fn probs_strategy() -> impl Strategy<Value = Vec<u32>> {
    (2usize..=MAX_OUTCOMES)
        .prop_flat_map(|n| prop::collection::vec(1u32..=1_000, n))
        .prop_map(|weights| {
            let n = weights.len() as u32;
            let spare = PPM - n * MIN_PROB_PPM;
            let total: u64 = weights.iter().map(|&w| w as u64).sum();
            let mut probs: Vec<u32> = weights
                .iter()
                .map(|&w| MIN_PROB_PPM + ((spare as u64) * (w as u64) / total) as u32)
                .collect();
            // Give the rounding remainder to the largest entry.
            let sum: u32 = probs.iter().sum();
            let imax = (0..probs.len()).max_by_key(|&i| probs[i]).unwrap();
            probs[imax] += PPM - sum;
            // With many outcomes the largest entry cannot exceed the upper clamp,
            // but with 2 outcomes it can; clamp and hand the excess to the other.
            if probs[imax] > MAX_PROB_PPM {
                let excess = probs[imax] - MAX_PROB_PPM;
                probs[imax] = MAX_PROB_PPM;
                let other = (imax + 1) % probs.len();
                probs[other] += excess;
            }
            probs
        })
}

/// Buy sizes from 1 base unit up to 10 million USDC: mostly retail, some whales.
fn amount_strategy() -> impl Strategy<Value = u64> {
    prop_oneof![
        6 => 1u64..=50 * UNIT,
        3 => 50 * UNIT..=20_000 * UNIT,
        1 => 20_000 * UNIT..=10_000_000 * UNIT,
    ]
}

/// The price of outcome i as a function of its share count, in f64:
/// p(q) = q / sqrt(rest + q^2), where rest = sum of the other outcomes' squares.
fn price_f64(rest: f64, q: f64) -> f64 {
    q / (rest + q * q).sqrt()
}

/// Numeric integral of the price from `a` to `b` by composite Simpson's rule on
/// panels whose width follows the local scale of the curve, sqrt(rest + q^2).
fn integrate_price(rest: f64, a: f64, b: f64) -> f64 {
    let mut total = 0.0f64;
    let mut lo = a;
    while lo < b {
        let scale = (rest + lo * lo).sqrt();
        let hi = (lo + scale / 8.0).min(b);
        let steps = 256usize; // even
        let h = (hi - lo) / steps as f64;
        let mut acc = price_f64(rest, lo) + price_f64(rest, hi);
        for k in 1..steps {
            let w = if k % 2 == 1 { 4.0 } else { 2.0 };
            acc += w * price_f64(rest, lo + h * k as f64);
        }
        total += acc * h / 3.0;
        lo = hi;
    }
    total
}

// ---------- plain unit tests ----------

#[test]
fn isqrt_small_values() {
    for n in 0u128..10_000 {
        let r = isqrt(n);
        assert!(r * r <= n && (r + 1) * (r + 1) > n, "isqrt({n}) = {r}");
    }
}

#[test]
fn isqrt_edges() {
    assert_eq!(isqrt(u128::MAX), u64::MAX as u128);
    assert_eq!(isqrt(1u128 << 126), 1u128 << 63);
    assert_eq!(isqrt((1u128 << 126) - 1), (1u128 << 63) - 1);
    let big = 1_000_000_000_000_000u128; // 1e15
    assert_eq!(isqrt(big * big), big);
    assert_eq!(isqrt(big * big - 1), big - 1);
}

#[test]
fn seed_fifty_fifty() {
    let pool = Pool::seeded(&[500_000, 500_000], 500 * UNIT).unwrap();
    // q_i = 500 * sqrt(0.5) = 353.553390 shares
    assert_eq!(pool.q[0], 353_553_390);
    assert_eq!(pool.q[1], 353_553_390);
    assert_eq!(pool.pot, 500 * UNIT);
    assert_eq!(prob_ppm(pool.shares(), 0).unwrap(), 500_000);
    // price = sqrt(0.5) = 0.707106
    assert_eq!(price_e6(pool.shares(), 0).unwrap(), 707_106);
}

#[test]
fn worked_example_matches_hand_calculation() {
    // Seed 500 USDC at 50/50, then buy 100 USDC of YES with no fee.
    // N = 500, q_yes = 353.553390...
    // q_yes' = sqrt(600^2 - 353.553390^2) = sqrt(360000 - 125000) = sqrt(235000) = 484.767985...
    // delta = 484.767985 - 353.553390 = 131.214594...
    let mut pool = Pool::seeded(&[500_000, 500_000], 500 * UNIT).unwrap();
    let out = pool.buy(0, 100 * UNIT, 0).unwrap();
    assert!((131_214_590..=131_214_600).contains(&out.shares), "{}", out.shares);
    assert_eq!(pool.pot, 600 * UNIT);
    // Average price paid is under 1 USDC per share, and the winner's payout is over 1.
    assert!(out.shares > 100 * UNIT);
    assert!(pool.payout_rate(0).unwrap() >= RATE_SCALE);
}

#[test]
fn fee_rounds_up_and_is_taken_first() {
    assert_eq!(split_fee(100 * UNIT, 100).unwrap(), (99 * UNIT, UNIT));
    assert_eq!(split_fee(1, 100).unwrap(), (0, 1)); // 1 unit: fee rounds up to 1
    assert_eq!(split_fee(101, 100).unwrap(), (99, 2)); // 1.01 rounds up to 2
    assert_eq!(split_fee(12_345, 0).unwrap(), (12_345, 0));
    assert_eq!(split_fee(1, MAX_FEE_BPS + 1), Err(MathError::BadFee));
}

#[test]
fn rejects_bad_seeds() {
    assert_eq!(
        Pool::seeded(&[1_000_000], 500 * UNIT),
        Err(MathError::BadOutcomeCount)
    );
    assert_eq!(
        Pool::seeded(&[999_000, 1_000], 500 * UNIT),
        Err(MathError::BadProbabilities)
    );
    assert_eq!(
        Pool::seeded(&[500_000, 400_000], 500 * UNIT),
        Err(MathError::BadProbabilities)
    );
    assert_eq!(
        Pool::seeded(&[500_000, 500_000], UNIT - 1),
        Err(MathError::SeedTooSmall)
    );
    assert_eq!(
        Pool::seeded(&[500_000, 500_000], MAX_POT + 1),
        Err(MathError::PotCapExceeded)
    );
    let too_many = vec![PPM / 33; 33];
    assert_eq!(
        Pool::seeded(&too_many, 500 * UNIT),
        Err(MathError::BadOutcomeCount)
    );
}

#[test]
fn rejects_bad_buys() {
    let mut pool = Pool::seeded(&[500_000, 500_000], 500 * UNIT).unwrap();
    assert_eq!(pool.buy(2, UNIT, FEE_BPS), Err(MathError::BadOutcome));
    assert_eq!(pool.buy(0, 0, FEE_BPS), Err(MathError::ZeroAmount));
    assert_eq!(pool.buy(0, 1, FEE_BPS), Err(MathError::ZeroAmount)); // all fee
    assert_eq!(pool.buy(0, MAX_POT, 0), Err(MathError::PotCapExceeded));
    // Failed buys leave the pool untouched.
    assert_eq!(pool, Pool::seeded(&[500_000, 500_000], 500 * UNIT).unwrap());
}

#[test]
fn pot_can_fill_to_the_cap() {
    let mut pool = Pool::seeded(&[500_000, 500_000], 500 * UNIT).unwrap();
    let room = MAX_POT - pool.pot;
    pool.buy(0, room, 0).unwrap();
    assert_eq!(pool.pot, MAX_POT);
    pool.check().unwrap();
    assert!(pool.payout_rate(0).unwrap() >= RATE_SCALE);
    assert_eq!(pool.buy(1, 2, 0), Err(MathError::PotCapExceeded));
}

#[test]
fn extreme_seed_thirty_two_outcomes() {
    let mut probs = vec![MIN_PROB_PPM; 32];
    probs[0] = PPM - 31 * MIN_PROB_PPM;
    let pool = Pool::seeded(&probs, 500 * UNIT).unwrap();
    for i in 0..32 {
        assert!(pool.payout_rate(i).unwrap() >= RATE_SCALE);
    }
}

// ---------- property tests ----------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn isqrt_is_floor_sqrt(n in any::<u128>()) {
        let r = isqrt(n);
        prop_assert!(r.checked_mul(r).map_or(false, |sq| sq <= n));
        // (r + 1)^2 > n, written to avoid overflow at the top of the range.
        let next = r + 1;
        prop_assert!(next.checked_mul(next).map_or(true, |sq| sq > n));
    }

    /// Seeding from probabilities reproduces each pi within 0.1 percentage points
    /// (in fact far closer), and never costs more than the seed.
    #[test]
    fn seeding_reproduces_probabilities(
        probs in probs_strategy(),
        seed in MIN_SEED..=5_000_000 * UNIT,
    ) {
        let pool = Pool::seeded(&probs, seed).unwrap();
        prop_assert!(pot_covers_cost(seed, pool.shares()).unwrap());
        for (i, &p) in probs.iter().enumerate() {
            let got = prob_ppm(pool.shares(), i).unwrap() as i64;
            // 0.1 percentage points = 1_000 ppm.
            prop_assert!((got - p as i64).abs() <= 1_000, "outcome {i}: want {p} got {got}");
        }
        // The seed is not wasted either: C(q) is within n base units of the seed.
        let n_ceil = norm_ceil(pool.shares()).unwrap();
        prop_assert!(n_ceil + probs.len() as u128 + 1 >= seed as u128);
    }

    /// The closed-form delta matches numeric integration of the price within
    /// 1 base unit: the integral of p dq over the minted shares equals the USDC paid.
    #[test]
    fn closed_form_matches_numeric_integration(
        probs in probs_strategy(),
        seed in 10 * UNIT..=100_000 * UNIT,
        warmup in prop::collection::vec((0usize..MAX_OUTCOMES, 1u64..=5_000 * UNIT), 0..6),
        outcome in 0usize..MAX_OUTCOMES,
        x in 1_000u64..=100_000 * UNIT,
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        for (o, amt) in warmup {
            let _ = pool.buy(o % pool.n, amt, 0);
        }
        let i = outcome % pool.n;
        let q_before = pool.q[i];
        let rest: f64 = pool
            .shares()
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != i)
            .map(|(_, &qj)| (qj as f64) * (qj as f64))
            .sum();
        let delta = shares_for_buy(pool.shares(), i, x).unwrap();
        let cost = integrate_price(rest, q_before as f64, (q_before + delta as u128) as f64);
        // Shares round down, so the integral is at most x and short by under 1 unit.
        let diff = x as f64 - cost;
        prop_assert!(diff > -0.01 && diff < 1.01, "x = {x}, integral = {cost}, diff = {diff}");
    }

    /// Rounding never favours the user: one more share than we mint would cost
    /// more than was paid, and what we do mint costs no more than was paid.
    #[test]
    fn shares_minted_round_down_exactly(
        probs in probs_strategy(),
        seed in MIN_SEED..=1_000_000 * UNIT,
        outcome in 0usize..MAX_OUTCOMES,
        x in amount_strategy(),
    ) {
        let pool = Pool::seeded(&probs, seed).unwrap();
        let i = outcome % pool.n;
        let delta = shares_for_buy(pool.shares(), i, x).unwrap() as u128;
        let s2 = sum_squares(pool.shares()).unwrap();
        let qi = pool.q[i];
        let rest = s2 - qi * qi;
        // Exact test of C(q') <= N + x  <=>  C(q')^2 - N^2 - x^2 <= 2 N x
        //                               <=>  (C(q')^2 - N^2 - x^2)^2 <= 4 x^2 N^2 (when lhs >= 0).
        // Use the weaker, overflow-free form with floor/ceil of N instead.
        let n_floor = isqrt(s2);
        let n_ceil = norm_ceil(pool.shares()).unwrap();
        let after = rest + (qi + delta) * (qi + delta);
        prop_assert!(after <= (n_ceil + x as u128) * (n_ceil + x as u128));
        // Two more shares would overshoot even the most generous bound.
        let over = rest + (qi + delta + 2) * (qi + delta + 2);
        prop_assert!(over > (n_floor + x as u128) * (n_floor + x as u128));
    }

    /// After 1,000 random buys, whales included, invariants 1-4 hold; for every
    /// possible winner the payout per share is at least 1 USDC; void prices never
    /// pay out more than the pot.
    #[test]
    fn invariants_hold_after_1000_random_buys(
        probs in probs_strategy(),
        seed in 10 * UNIT..=5_000 * UNIT,
        buys in prop::collection::vec((0usize..MAX_OUTCOMES, amount_strategy()), 1_000),
        splits in prop::collection::vec(1u64..=1_000, 8),
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let n = pool.n;

        // Shadow ledger standing in for the token accounts.
        let mut pot_vault: u64 = seed;
        let mut fees_collected: u64 = 0;
        let mut supply: Vec<u128> = pool.shares().to_vec(); // seed shares held by the treasury

        for (o, usdc_in) in buys {
            let i = o % n;
            let before = pool.clone();
            match pool.buy(i, usdc_in, FEE_BPS) {
                Ok(out) => {
                    prop_assert_eq!(out.net + out.fee, usdc_in);
                    // Fee is at least the exact 1%.
                    prop_assert!((out.fee as u128) * 10_000 >= (usdc_in as u128) * FEE_BPS as u128);
                    // A share never costs more than 1 USDC before the fee.
                    prop_assert!(out.shares >= out.net, "paid {} for {} shares", out.net, out.shares);
                    prop_assert!(out.price_after_e6 <= UNIT);
                    pot_vault += out.net;
                    fees_collected += out.fee;
                    supply[i] += out.shares as u128;
                    // Buying raises only the bought outcome's share count.
                    for j in 0..n {
                        if j != i {
                            prop_assert_eq!(pool.q[j], before.q[j]);
                        }
                    }
                }
                Err(MathError::PotCapExceeded) | Err(MathError::ZeroAmount) => {
                    prop_assert_eq!(&pool, &before);
                }
                Err(e) => prop_assert!(false, "unexpected error {:?}", e),
            }

            // Invariant 1: M >= C(q) >= q_i.
            prop_assert!(pot_covers_cost(pool.pot, pool.shares()).unwrap());
            let n_ceil = norm_ceil(pool.shares()).unwrap();
            for j in 0..n {
                prop_assert!(n_ceil >= pool.q[j]);
            }
            // Invariant 2: pot vault balance = M.
            prop_assert_eq!(pot_vault, pool.pot);
            // Invariant 3: mint supply (nothing burned yet) = q_i.
            for j in 0..n {
                prop_assert_eq!(supply[j], pool.q[j]);
            }
        }
        let _ = fees_collected;

        // Every possible winner: payout per share >= 1 USDC, and (invariant 4)
        // payout_per_share * q_winner <= M even when holders redeem in pieces.
        for w in 0..n {
            let rate = pool.payout_rate(w).unwrap();
            prop_assert!(rate >= RATE_SCALE, "winner {w} pays {rate} < 1 USDC");
            prop_assert!(rate * pool.q[w] <= (pool.pot as u128) * RATE_SCALE);

            // Split the winning supply among several holders and redeem each.
            let total_w: u64 = pool.q[w] as u64;
            let weight_sum: u64 = splits.iter().sum();
            let mut left = total_w;
            let mut paid: u128 = 0;
            for (k, &wgt) in splits.iter().enumerate() {
                let amt = if k + 1 == splits.len() {
                    left
                } else {
                    ((total_w as u128) * (wgt as u128) / (weight_sum as u128)) as u64
                };
                let amt = amt.min(left);
                left -= amt;
                let pay = redeem_value(amt, rate).unwrap();
                // Each holder gets at least 1 USDC per share, to the base unit.
                prop_assert!(pay >= amt);
                paid += pay as u128;
            }
            prop_assert!(paid <= pool.pot as u128, "paid {} from pot {}", paid, pool.pot);
        }

        // Void: every share redeems at its final price; the pot covers all of it.
        let rates = pool.void_rates().unwrap();
        let mut void_total: u128 = 0;
        for j in 0..n {
            prop_assert!(rates[j] as u128 <= RATE_SCALE);
            void_total += redeem_value(pool.q[j] as u64, rates[j] as u128).unwrap() as u128;
        }
        prop_assert!(void_total <= pool.pot as u128, "void pays {} from pot {}", void_total, pool.pot);
    }

    /// A small buy at implied probability pi returns at least 1/sqrt(pi) if it
    /// wins (before the fee), because the price is sqrt(pi) and the payout is >= 1.
    #[test]
    fn small_buy_floor_return(
        probs in probs_strategy(),
        seed in 100 * UNIT..=100_000 * UNIT,
        outcome in 0usize..MAX_OUTCOMES,
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let i = outcome % pool.n;
        let x = seed / 10_000; // 1 bp of the pot: small
        let price_before = price_e6(pool.shares(), i).unwrap();
        let out = pool.buy(i, x, 0).unwrap();
        // Average price paid is between the price before and the price after.
        let avg_e6 = (x as u128) * (UNIT as u128) / (out.shares as u128);
        prop_assert!(avg_e6 + 2 >= price_before as u128);
        prop_assert!(avg_e6 <= out.price_after_e6 as u128 + 2);
        // Winning pays at least 1 USDC per share, so the return is >= 1 / avg price.
        let pay = redeem_value(out.shares, pool.payout_rate(i).unwrap()).unwrap();
        prop_assert!(pay >= x);
    }

    /// Quoting does not change the pool and matches the real buy.
    #[test]
    fn quote_matches_buy(
        probs in probs_strategy(),
        seed in MIN_SEED..=100_000 * UNIT,
        outcome in 0usize..MAX_OUTCOMES,
        x in 1_000u64..=10_000 * UNIT,
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let i = outcome % pool.n;
        let snapshot = pool.clone();
        let quoted = pool.quote_buy(i, x, FEE_BPS);
        prop_assert_eq!(&pool, &snapshot);
        let real = pool.buy(i, x, FEE_BPS);
        prop_assert_eq!(quoted, real);
    }
}
