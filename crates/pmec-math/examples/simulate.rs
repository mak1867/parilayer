//! The floor simulation (spec deliverable 5): what happens to an early buyer
//! when late money floods the outcome they bet on, in a plain parimutuel pot
//! versus this pool (n = 2 dynamic parimutuel, C(q) = ||q||).
//!
//!   cargo run -q -p pmec-math --example simulate > floor.csv
//!
//! Scenario: a binary market seeded with 1,000 USDC at 30% for outcome A. An
//! early buyer spends 100 USDC on A. Then `late` USDC more is bought on A by
//! others. Both systems take the same 1% fee. Columns are the early buyer's
//! return multiple (payout / 100 USDC) if A wins:
//!
//! - parimutuel: payout = stake * pot / (money on A). As late money pours in,
//!   this falls toward 1x, and below it once the fee is counted.
//! - pool: payout = shares * pot / q_A, using the exact on-chain math.
//! - pool_floor: shares * 1 USDC / 100, the guarantee fixed at the moment of
//!   purchase. The pool line can approach it but never cross it.
//!
//! The web app's "How it works" page computes the same rows with the
//! TypeScript port of this math.

use pmec_math::*;

const SEED: u64 = 1_000 * UNIT;
const PROB_A_PPM: u32 = 300_000;
const EARLY: u64 = 100 * UNIT;
const FEE_BPS: u16 = 100;

fn main() {
    println!("late_usdc,parimutuel,pool,pool_floor");
    for step in 0..=40u64 {
        let late = step * 500 * UNIT;

        // Plain parimutuel: the seed sits 300 on A and 700 on B.
        let net = |x: u64| x - split_fee(x, FEE_BPS).unwrap().1;
        let on_a = 300 * UNIT + net(EARLY) + if late > 0 { net(late) } else { 0 };
        let pot = SEED + net(EARLY) + if late > 0 { net(late) } else { 0 };
        let pari = net(EARLY) as f64 * pot as f64 / on_a as f64 / EARLY as f64;

        // This pool, seeded at the same 30%.
        let mut pool = Pool::seeded(&[PROB_A_PPM, PPM - PROB_A_PPM], SEED).unwrap();
        let early = pool.buy(0, EARLY, FEE_BPS).unwrap();
        if late > 0 {
            pool.buy(0, late, FEE_BPS).unwrap();
        }
        let payout = redeem_value(early.shares, pool.payout_rate(0).unwrap()).unwrap();
        let ret = payout as f64 / EARLY as f64;
        let floor = early.shares as f64 / EARLY as f64;

        println!("{},{:.4},{:.4},{:.4}", late / UNIT, pari, ret, floor);
    }
}
