//! Tests for selling back to the pool. These are the spec's "Selling" tests:
//! a buy followed by an immediate sell of the same shares returns the cost
//! minus both fees; random buy/sell sequences keep every invariant; sells
//! below the seed are rejected; rounding never favours the seller.

use super::*;
use proptest::prelude::*;

const BUY_FEE: u16 = 100; // 1% to the treasury
const SELL_FEE: u16 = 200; // 2% kept in the pot

/// Same generator as the buy tests: n outcomes, each >= 0.5%, summing to 1e6 ppm.
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
            let sum: u32 = probs.iter().sum();
            let imax = (0..probs.len()).max_by_key(|&i| probs[i]).unwrap();
            probs[imax] += PPM - sum;
            if probs[imax] > MAX_PROB_PPM {
                let excess = probs[imax] - MAX_PROB_PPM;
                probs[imax] = MAX_PROB_PPM;
                let other = (imax + 1) % probs.len();
                probs[other] += excess;
            }
            probs
        })
}

fn amount_strategy() -> impl Strategy<Value = u64> {
    prop_oneof![
        6 => 1u64..=50 * UNIT,
        3 => 50 * UNIT..=20_000 * UNIT,
        1 => 20_000 * UNIT..=10_000_000 * UNIT,
    ]
}

/// Exact refund in f64, for comparison: N - sqrt(N^2 - q_i^2 + (q_i - s)^2).
fn refund_f64(q: &[u128], i: usize, s: u64) -> f64 {
    let s2: f64 = q.iter().map(|&x| (x as f64) * (x as f64)).sum();
    let qi = q[i] as f64;
    let rest = qi - s as f64;
    s2.sqrt() - (s2 - qi * qi + rest * rest).sqrt()
}

// ---------- unit tests ----------

#[test]
fn fifty_fifty_round_trip_by_hand() {
    // 1,000 USDC seed at 50/50: q = (707.106781, 707.106781), N = 1000.
    let mut pool = Pool::seeded(&[500_000, 500_000], 1_000 * UNIT).unwrap();
    let seed_q = pool.q[1];
    let bought = pool.buy(1, 100 * UNIT, BUY_FEE).unwrap();
    assert_eq!(bought.net, 99 * UNIT);
    let sold = pool.sell(1, bought.shares, SELL_FEE, seed_q).unwrap();
    // The pool gives back what it took in (99 USDC), to within rounding.
    assert!(sold.gross <= 99 * UNIT && 99 * UNIT - sold.gross <= 1, "gross {}", sold.gross);
    // 2% of it stays in the pot.
    assert_eq!(sold.fee, sold.gross.div_ceil(50));
    assert_eq!(sold.usdc_out + sold.fee, sold.gross);
    // Back to the seed share count; the pot keeps the sell fee and the dust.
    assert_eq!(pool.q[1], seed_q);
    assert_eq!(pool.pot, 1_000 * UNIT + 99 * UNIT - sold.usdc_out);
}

#[test]
fn rejects_bad_sells() {
    let mut pool = Pool::seeded(&[400_000, 600_000], 500 * UNIT).unwrap();
    let seed = pool.q;
    let out = pool.buy(0, 50 * UNIT, BUY_FEE).unwrap();
    let snapshot = pool.clone();
    // Zero shares.
    assert_eq!(pool.sell(0, 0, SELL_FEE, seed[0]), Err(MathError::ZeroAmount));
    // One share more than holders own would dip into the seed.
    assert_eq!(pool.sell(0, out.shares + 1, SELL_FEE, seed[0]), Err(MathError::BelowSeed));
    // Outcome 1 has only seed shares: nothing can be sold.
    assert_eq!(pool.sell(1, 1, SELL_FEE, seed[1]), Err(MathError::BelowSeed));
    // More than exist at all.
    assert_eq!(pool.sell(0, u64::MAX, SELL_FEE, 0), Err(MathError::NotEnoughShares));
    // Bad outcome and fee.
    assert_eq!(pool.sell(5, 1, SELL_FEE, 0), Err(MathError::BadOutcome));
    assert_eq!(pool.sell(0, out.shares, MAX_FEE_BPS + 1, seed[0]), Err(MathError::BadFee));
    // Nothing changed.
    assert_eq!(pool, snapshot);
    // Selling exactly what was bought is fine.
    pool.sell(0, out.shares, SELL_FEE, seed[0]).unwrap();
    assert_eq!(pool.q[0], seed[0]);
}

#[test]
fn tiny_sell_that_pays_nothing_is_rejected() {
    let mut pool = Pool::seeded(&[5_000, 995_000], 1_000 * UNIT).unwrap();
    pool.buy(0, 10 * UNIT, BUY_FEE).unwrap();
    // One base unit of a 0.5% outcome is worth well under one base unit of USDC.
    assert_eq!(pool.sell(0, 1, SELL_FEE, 0), Err(MathError::ZeroAmount));
}

#[test]
fn sell_refund_equals_buy_cost_on_a_whale() {
    let mut pool = Pool::seeded(&[300_000, 300_000, 400_000], 500 * UNIT).unwrap();
    let seed = pool.q;
    let x = 1_000_000 * UNIT; // a whale 2,000 times the seed
    let out = pool.buy(2, x, 0).unwrap();
    let back = sell_refund(pool.shares(), 2, out.shares).unwrap();
    assert!(back <= x && x - back <= 1, "paid {x}, refund {back}");
    pool.sell(2, out.shares, 0, seed[2]).unwrap();
}

// ---------- property tests ----------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Buying and immediately selling the same shares returns exactly
    /// cost - buy fee - sell fee, within rounding (always in the pool's favour).
    #[test]
    fn buy_then_sell_costs_exactly_the_two_fees(
        probs in probs_strategy(),
        seed in MIN_SEED..=100_000 * UNIT,
        outcome in 0usize..MAX_OUTCOMES,
        x in 1_000u64..=1_000_000 * UNIT,
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let i = outcome % pool.n;
        let seed_q = pool.q[i];
        let bought = match pool.buy(i, x, BUY_FEE) {
            Ok(b) => b,
            Err(MathError::ZeroAmount) => return Ok(()),
            Err(e) => return Err(TestCaseError::fail(format!("buy failed: {e:?}"))),
        };
        let sold = match pool.sell(i, bought.shares, SELL_FEE, seed_q) {
            Ok(s) => s,
            Err(MathError::ZeroAmount) => return Ok(()),
            Err(e) => return Err(TestCaseError::fail(format!("sell failed: {e:?}"))),
        };
        // Refund before the sell fee = what went into the pot, never more,
        // and at most 1 base unit less (shares round down, refund rounds down).
        prop_assert!(sold.gross <= bought.net, "refund {} > paid {}", sold.gross, bought.net);
        prop_assert!(bought.net - sold.gross <= 1, "refund {} vs paid {}", sold.gross, bought.net);
        // So the seller gets x - buy fee - sell fee.
        prop_assert_eq!(sold.usdc_out, x - bought.fee - sold.fee - (bought.net - sold.gross));
        prop_assert_eq!(pool.q[i], seed_q);
    }

    /// The refund never exceeds the exact value and is within 1 base unit of it.
    #[test]
    fn refund_rounds_down(
        probs in probs_strategy(),
        seed in MIN_SEED..=100_000 * UNIT,
        outcome in 0usize..MAX_OUTCOMES,
        x in 1_000u64..=100_000 * UNIT,
        frac in 1u64..=1_000,
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let i = outcome % pool.n;
        let bought = match pool.buy(i, x, 0) { Ok(b) => b, Err(_) => return Ok(()) };
        let s = (bought.shares as u128 * frac as u128 / 1_000).max(1) as u64;
        let r = sell_refund(pool.shares(), i, s).unwrap();
        let exact = refund_f64(pool.shares(), i, s);
        // f64 carries about 0.1 base unit of error at these sizes.
        prop_assert!((r as f64) <= exact + 0.5, "refund {r} above exact {exact}");
        prop_assert!((r as f64) >= exact - 1.5, "refund {r} far below exact {exact}");
    }

    /// 1,000 random buys and sells, whales included: invariants 1-4 hold after
    /// each one, no outcome drops below its seed, every winner still pays at
    /// least 1 USDC a share, and void prices fit in the pot.
    #[test]
    fn invariants_hold_after_1000_random_buys_and_sells(
        probs in probs_strategy(),
        seed in 10 * UNIT..=5_000 * UNIT,
        ops in prop::collection::vec(
            (any::<bool>(), 0usize..MAX_OUTCOMES, amount_strategy(), 1u64..=1_000),
            1_000,
        ),
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let n = pool.n;
        let seed_q: Vec<u128> = pool.shares().to_vec();

        // Shadow ledger standing in for the token accounts.
        let mut pot_vault: u64 = seed;
        let mut supply: Vec<u128> = seed_q.clone();
        let mut held: Vec<u64> = vec![0; n]; // shares held by traders

        for (is_sell, o, amount, frac) in ops {
            let i = o % n;
            let before = pool.clone();
            if is_sell && held[i] > 0 {
                let s = ((held[i] as u128 * frac as u128) / 1_000).max(1) as u64;
                match pool.sell(i, s, SELL_FEE, seed_q[i]) {
                    Ok(out) => {
                        prop_assert_eq!(out.usdc_out + out.fee, out.gross);
                        prop_assert!((out.fee as u128) * 10_000 >= (out.gross as u128) * SELL_FEE as u128);
                        // Never more than 1 USDC a share back.
                        prop_assert!(out.gross <= s, "refund {} for {} shares", out.gross, s);
                        pot_vault -= out.usdc_out;
                        supply[i] -= s as u128;
                        held[i] -= s;
                        for j in 0..n {
                            if j != i {
                                prop_assert_eq!(pool.q[j], before.q[j]);
                            }
                        }
                    }
                    Err(MathError::ZeroAmount) => prop_assert_eq!(&pool, &before),
                    Err(e) => prop_assert!(false, "unexpected sell error {:?}", e),
                }
            } else {
                match pool.buy(i, amount, BUY_FEE) {
                    Ok(out) => {
                        prop_assert!(out.shares >= out.net);
                        pot_vault += out.net;
                        supply[i] += out.shares as u128;
                        held[i] += out.shares;
                    }
                    Err(MathError::PotCapExceeded) | Err(MathError::ZeroAmount) => {
                        prop_assert_eq!(&pool, &before);
                    }
                    Err(e) => prop_assert!(false, "unexpected buy error {:?}", e),
                }
            }

            // Invariant 1: M >= C(q) >= q_i.
            prop_assert!(pot_covers_cost(pool.pot, pool.shares()).unwrap());
            let n_ceil = norm_ceil(pool.shares()).unwrap();
            for j in 0..n {
                prop_assert!(n_ceil >= pool.q[j]);
                // Never below the seed.
                prop_assert!(pool.q[j] >= seed_q[j]);
                // Invariant 3: supply = q (nothing redeemed yet).
                prop_assert_eq!(supply[j], pool.q[j]);
                prop_assert_eq!(pool.q[j], seed_q[j] + held[j] as u128);
            }
            // Invariant 2: pot vault = M.
            prop_assert_eq!(pot_vault, pool.pot);
        }

        // Every possible winner pays at least 1 USDC a share (invariant 4 too).
        for w in 0..n {
            let rate = pool.payout_rate(w).unwrap();
            prop_assert!(rate >= RATE_SCALE, "winner {w} pays {rate} < 1 USDC");
            prop_assert!(rate * pool.q[w] <= (pool.pot as u128) * RATE_SCALE);
        }
        // Void prices fit in the pot.
        let rates = pool.void_rates().unwrap();
        let mut void_total: u128 = 0;
        for j in 0..n {
            void_total += redeem_value(pool.q[j] as u64, rates[j] as u128).unwrap() as u128;
        }
        prop_assert!(void_total <= pool.pot as u128);
    }

    /// Quoting a sell does not change the pool and matches the real sell.
    #[test]
    fn quote_matches_sell(
        probs in probs_strategy(),
        seed in MIN_SEED..=100_000 * UNIT,
        outcome in 0usize..MAX_OUTCOMES,
        x in 1_000u64..=10_000 * UNIT,
    ) {
        let mut pool = Pool::seeded(&probs, seed).unwrap();
        let i = outcome % pool.n;
        let seed_q = pool.q[i];
        let Ok(b) = pool.buy(i, x, BUY_FEE) else { return Ok(()) };
        let snapshot = pool.clone();
        let quoted = pool.quote_sell(i, b.shares, SELL_FEE, seed_q);
        prop_assert_eq!(&pool, &snapshot);
        prop_assert_eq!(quoted, pool.sell(i, b.shares, SELL_FEE, seed_q));
    }
}
