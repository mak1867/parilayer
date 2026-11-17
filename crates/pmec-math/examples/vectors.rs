//! Prints golden test vectors as JSON so the TypeScript port of the math
//! (packages/sdk/src/math.ts) can be checked against this crate bit for bit.
//!
//!   cargo run -p pmec-math --example vectors > packages/sdk/test/vectors.json

use pmec_math::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn probs(rng: &mut Rng, n: usize) -> Vec<u32> {
    let weights: Vec<u64> = (0..n).map(|_| 1 + rng.next() % 1000).collect();
    let total: u64 = weights.iter().sum();
    let spare = (PPM - n as u32 * MIN_PROB_PPM) as u64;
    let mut p: Vec<u32> = weights
        .iter()
        .map(|w| MIN_PROB_PPM + (spare * w / total) as u32)
        .collect();
    let sum: u32 = p.iter().sum();
    let imax = (0..n).max_by_key(|&i| p[i]).unwrap();
    p[imax] += PPM - sum;
    if p[imax] > MAX_PROB_PPM {
        let excess = p[imax] - MAX_PROB_PPM;
        p[imax] = MAX_PROB_PPM;
        p[(imax + 1) % n] += excess;
    }
    p
}

fn list<T: std::fmt::Display>(items: impl Iterator<Item = T>, quote: bool) -> String {
    let parts: Vec<String> = items
        .map(|x| if quote { format!("\"{x}\"") } else { format!("{x}") })
        .collect();
    format!("[{}]", parts.join(","))
}

fn main() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let sizes = [2usize, 2, 2, 3, 4, 4, 5, 8, 13, 32, 32, 2];
    let mut cases = Vec::new();
    for (c, &n) in sizes.iter().enumerate() {
        let p = probs(&mut rng, n);
        let seed = match c % 4 {
            0 => 500 * UNIT,
            1 => UNIT + rng.next() % (50 * UNIT),
            2 => 1_000 * UNIT + rng.next() % (1_000_000 * UNIT),
            _ => 25 * UNIT,
        };
        let mut pool = Pool::seeded(&p, seed).unwrap();
        let q0 = list(pool.shares().iter(), true);
        let mut steps = Vec::new();
        for s in 0..40 {
            let outcome = (rng.next() % n as u64) as usize;
            let usdc_in = match s % 8 {
                0 => 1 + rng.next() % 100,                      // dust
                7 => 1_000 * UNIT + rng.next() % (50_000_000 * UNIT), // whale
                6 => MAX_POT / 3,                                // may hit the cap
                _ => 1 + rng.next() % (2_000 * UNIT),
            };
            let fee_bps = [0u16, 100, 100, 250][s % 4];
            match pool.buy(outcome, usdc_in, fee_bps) {
                Ok(o) => steps.push(format!(
                    "{{\"outcome\":{outcome},\"usdcIn\":\"{usdc_in}\",\"feeBps\":{fee_bps},\"ok\":true,\"shares\":\"{}\",\"net\":\"{}\",\"fee\":\"{}\",\"priceAfter\":\"{}\",\"probAfter\":{},\"pot\":\"{}\"}}",
                    o.shares, o.net, o.fee, o.price_after_e6, o.prob_after_ppm, pool.pot
                )),
                Err(e) => steps.push(format!(
                    "{{\"outcome\":{outcome},\"usdcIn\":\"{usdc_in}\",\"feeBps\":{fee_bps},\"ok\":false,\"error\":\"{e:?}\"}}"
                )),
            }
        }
        let payout = list((0..n).map(|w| pool.payout_rate(w).unwrap()), true);
        let void_rates = pool.void_rates().unwrap();
        let void = list(void_rates[..n].iter(), true);
        let prices = list((0..n).map(|i| price_e6(pool.shares(), i).unwrap()), true);
        let pr = list((0..n).map(|i| prob_ppm(pool.shares(), i).unwrap()), false);
        cases.push(format!(
            "{{\"probs\":{},\"seed\":\"{seed}\",\"q0\":{q0},\"steps\":[{}],\"qEnd\":{},\"potEnd\":\"{}\",\"payoutRates\":{payout},\"voidRates\":{void},\"prices\":{prices},\"probsEnd\":{pr}}}",
            list(p.iter(), false),
            steps.join(","),
            list(pool.shares().iter(), true),
            pool.pot
        ));
    }
    let roots: Vec<u128> = vec![
        0, 1, 2, 3, 4, 15, 16, 17, 999_999, 1_000_000,
        (1u128 << 64) - 1, 1u128 << 64, (1u128 << 100) + 12345,
        u128::MAX, 250_000_000_000_000_000, 1_000_000_000_000_000_000_000_000_000_000,
    ];
    let isqrts = list(
        roots.iter().map(|&n| format!("[\"{n}\",\"{}\"]", isqrt(n))),
        false,
    );
    println!("{{\"isqrt\":{isqrts},\"cases\":[\n{}\n]}}", cases.join(",\n"));
}
