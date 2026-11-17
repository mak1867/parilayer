//! Integer math for the PMEC pool: Pennock's dynamic parimutuel market with the
//! cost function `C(q) = ||q||_2` (kappa = 1 USDC).
//!
//! Everything here is pure, deterministic integer arithmetic so the on-chain
//! program, the property tests and the off-chain services agree bit for bit.
//!
//! Units
//! - USDC and shares both have 6 decimals: `1_000_000` base units = 1 USDC = 1 share.
//! - Rates (payout per share, void price per share) are scaled by `RATE_SCALE` (1e12).
//! - Probabilities are in parts per million (ppm).
//!
//! Rounding rule: every rounding goes against the trader and in favour of the
//! pot. Shares minted round down, fees round up, payouts round down. That is
//! what keeps the invariant `pot >= C(q)` true forever.

#![cfg_attr(not(test), no_std)]

/// Maximum number of outcomes in one market.
pub const MAX_OUTCOMES: usize = 32;
/// Base units in 1 USDC and in 1 share.
pub const UNIT: u64 = 1_000_000;
/// Scale of payout-per-share and void-price rates.
pub const RATE_SCALE: u128 = 1_000_000_000_000;
/// Parts per million in 100%.
pub const PPM: u32 = 1_000_000;
/// Seed probabilities are clamped to at least 0.5% ...
pub const MIN_PROB_PPM: u32 = 5_000;
/// ... and at most 99.5%.
pub const MAX_PROB_PPM: u32 = 995_000;
/// Basis points in 100%.
pub const BPS: u64 = 10_000;
/// Largest fee the math accepts (10%).
pub const MAX_FEE_BPS: u16 = 1_000;
/// Hard cap on the pot: 1e15 base units = 1 billion USDC. With this cap every
/// square below stays under 1e30, far inside u128.
pub const MAX_POT: u64 = 1_000_000_000_000_000;
/// Smallest seed: 1 USDC. Below this, rounding distorts the seed probabilities.
pub const MIN_SEED: u64 = UNIT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// An intermediate value did not fit.
    Overflow,
    /// Outcome index is not below `n`.
    BadOutcome,
    /// Outcome count is not in 2..=32.
    BadOutcomeCount,
    /// Probabilities are out of the clamp range or do not sum to 1e6 ppm.
    BadProbabilities,
    /// Amount is zero (or becomes zero after the fee).
    ZeroAmount,
    /// Seed is below `MIN_SEED`.
    SeedTooSmall,
    /// The buy would push the pot above `MAX_POT`.
    PotCapExceeded,
    /// Fee is above `MAX_FEE_BPS`.
    BadFee,
    /// The pool has no shares outstanding.
    EmptyPool,
    /// `pot >= C(q)` would be violated. Never expected; checked defensively.
    InvariantViolated,
}

pub type Result<T> = core::result::Result<T, MathError>;

/// Integer square root, rounded down, by Newton's method.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // First guess: a power of two that is >= sqrt(n), so the iteration
    // decreases monotonically to floor(sqrt(n)).
    let bits = 128 - n.leading_zeros();
    let mut x: u128 = 1u128 << bits.div_ceil(2);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Sum of squares of the outstanding shares: `||q||^2`, exact.
pub fn sum_squares(q: &[u128]) -> Result<u128> {
    let mut s: u128 = 0;
    for &qi in q {
        let sq = qi.checked_mul(qi).ok_or(MathError::Overflow)?;
        s = s.checked_add(sq).ok_or(MathError::Overflow)?;
    }
    Ok(s)
}

/// `floor(||q||)`.
pub fn norm_floor(q: &[u128]) -> Result<u128> {
    Ok(isqrt(sum_squares(q)?))
}

/// `ceil(||q||)`.
pub fn norm_ceil(q: &[u128]) -> Result<u128> {
    let s = sum_squares(q)?;
    let r = isqrt(s);
    Ok(if r * r == s { r } else { r + 1 })
}

/// True when `pot >= C(q)`, compared exactly as `pot^2 >= ||q||^2`.
pub fn pot_covers_cost(pot: u64, q: &[u128]) -> Result<bool> {
    let p = pot as u128;
    Ok(p * p >= sum_squares(q)?)
}

/// Validates seed probabilities: 2..=32 outcomes, each within the clamp range,
/// summing to exactly 1e6 ppm.
pub fn validate_probs(probs_ppm: &[u32]) -> Result<()> {
    if probs_ppm.len() < 2 || probs_ppm.len() > MAX_OUTCOMES {
        return Err(MathError::BadOutcomeCount);
    }
    let mut sum: u64 = 0;
    for &p in probs_ppm {
        if !(MIN_PROB_PPM..=MAX_PROB_PPM).contains(&p) {
            return Err(MathError::BadProbabilities);
        }
        sum += p as u64;
    }
    if sum != PPM as u64 {
        return Err(MathError::BadProbabilities);
    }
    Ok(())
}

/// Seed shares for a budget of `seed` base units: `q_i = floor(seed * sqrt(pi_i))`.
///
/// Because every `q_i` is rounded down, `C(q) <= seed`, so a pot holding exactly
/// `seed` covers the cost from the first block.
pub fn seed_shares(probs_ppm: &[u32], seed: u64) -> Result<[u128; MAX_OUTCOMES]> {
    validate_probs(probs_ppm)?;
    if seed < MIN_SEED {
        return Err(MathError::SeedTooSmall);
    }
    if seed > MAX_POT {
        return Err(MathError::PotCapExceeded);
    }
    let s2 = (seed as u128) * (seed as u128); // <= 1e30
    let mut q = [0u128; MAX_OUTCOMES];
    for (i, &p) in probs_ppm.iter().enumerate() {
        // s2 * p <= 1e36, fits in u128.
        q[i] = isqrt(s2 * (p as u128) / (PPM as u128));
    }
    Ok(q)
}

/// Splits a gross payment into `(net, fee)`. The fee rounds up.
pub fn split_fee(usdc_in: u64, fee_bps: u16) -> Result<(u64, u64)> {
    if fee_bps > MAX_FEE_BPS {
        return Err(MathError::BadFee);
    }
    let fee = ((usdc_in as u128) * (fee_bps as u128)).div_ceil(BPS as u128) as u64;
    Ok((usdc_in - fee, fee))
}

/// Shares of outcome `i` minted for `x` base units of USDC (fee already removed).
///
/// Closed form: `delta = sqrt((N + x)^2 - (N^2 - q_i^2)) - q_i`, with `N = ||q||`.
/// Expanded as `q_i'^2 = q_i^2 + 2*N*x + x^2` so the only irrational term is
/// `2*N*x`; `N` is taken with extra fractional bits and rounded down, and the
/// final square root rounds down, so the result never exceeds the exact value.
pub fn shares_for_buy(q: &[u128], i: usize, x: u64) -> Result<u64> {
    if i >= q.len() {
        return Err(MathError::BadOutcome);
    }
    if x == 0 {
        return Err(MathError::ZeroAmount);
    }
    let s2 = sum_squares(q)?;
    if s2 == 0 {
        return Err(MathError::EmptyPool);
    }
    let n_ceil = {
        let r = isqrt(s2);
        if r * r == s2 {
            r
        } else {
            r + 1
        }
    };
    if n_ceil + (x as u128) > MAX_POT as u128 {
        return Err(MathError::PotCapExceeded);
    }
    // N with `half` fractional bits: n_scaled = floor(sqrt(s2 << 2*half)).
    let shift = s2.leading_zeros() & !1; // even, keeps s2 << shift inside u128
    let half = shift / 2;
    let n_scaled = isqrt(s2 << shift); // < 2^64
    let x = x as u128; // <= 1e15 < 2^50
    let cross = (2 * x * n_scaled) >> half; // floor(2*N*x), 2*x*n_scaled < 2^115
    let qi = q[i];
    let qi_new_sq = qi * qi + cross + x * x; // <= (N + x)^2 <= 1e30
    let qi_new = isqrt(qi_new_sq);
    let delta = qi_new - qi;
    u64::try_from(delta).map_err(|_| MathError::Overflow)
}

/// Pool price of one share of outcome `i`, in base units of USDC (1e6 = 1 USDC).
/// `p_i = q_i / N`, rounded down. Always <= 1 USDC.
pub fn price_e6(q: &[u128], i: usize) -> Result<u64> {
    if i >= q.len() {
        return Err(MathError::BadOutcome);
    }
    let n = norm_ceil(q)?;
    if n == 0 {
        return Err(MathError::EmptyPool);
    }
    Ok((q[i] * (UNIT as u128) / n) as u64)
}

/// Implied probability of outcome `i` in ppm: `pi_i = q_i^2 / ||q||^2`.
/// This is the current value of i's shares divided by the pot, not a money ratio.
pub fn prob_ppm(q: &[u128], i: usize) -> Result<u32> {
    if i >= q.len() {
        return Err(MathError::BadOutcome);
    }
    let s2 = sum_squares(q)?;
    if s2 == 0 {
        return Err(MathError::EmptyPool);
    }
    // q_i^2 <= 1e30, times 1e6 <= 1e36.
    Ok((q[i] * q[i] * (PPM as u128) / s2) as u32)
}

/// Payout per winning share at resolution, scaled by 1e12: `floor(pot * 1e12 / q_winner)`.
pub fn payout_rate_e12(pot: u64, q_winner: u128) -> Result<u128> {
    if q_winner == 0 {
        return Err(MathError::EmptyPool);
    }
    Ok((pot as u128) * RATE_SCALE / q_winner)
}

/// Void price per share for every outcome, scaled by 1e12:
/// `floor(q_i * 1e12 / ceil(N))`. Sum over i of `rate_i * q_i` is at most `C(q) <= pot`.
pub fn void_rates_e12(q: &[u128]) -> Result<[u64; MAX_OUTCOMES]> {
    if q.len() > MAX_OUTCOMES {
        return Err(MathError::BadOutcomeCount);
    }
    let n = norm_ceil(q)?;
    if n == 0 {
        return Err(MathError::EmptyPool);
    }
    let mut out = [0u64; MAX_OUTCOMES];
    for (i, &qi) in q.iter().enumerate() {
        // q_i <= N so the rate is <= 1e12; q_i * 1e12 <= 1e27.
        out[i] = (qi * RATE_SCALE / n) as u64;
    }
    Ok(out)
}

/// USDC paid for burning `amount` shares at `rate_e12`, rounded down.
pub fn redeem_value(amount: u64, rate_e12: u128) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(rate_e12)
        .ok_or(MathError::Overflow)?
        / RATE_SCALE;
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// What a buy did, for events and for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuyOutcome {
    /// Shares minted to the buyer.
    pub shares: u64,
    /// USDC added to the pot (payment minus fee).
    pub net: u64,
    /// USDC sent to the treasury.
    pub fee: u64,
    /// Pool price of the bought outcome after the trade (1e6 = 1 USDC).
    pub price_after_e6: u64,
    /// Implied probability of the bought outcome after the trade, in ppm.
    pub prob_after_ppm: u32,
}

/// The pool state the math needs: share counts and the pot. The on-chain Market
/// account stores exactly these and runs every state change through this type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pool {
    pub n: usize,
    pub q: [u128; MAX_OUTCOMES],
    pub pot: u64,
}

impl Pool {
    /// A freshly seeded pool. The pot holds exactly `seed`.
    pub fn seeded(probs_ppm: &[u32], seed: u64) -> Result<Pool> {
        let q = seed_shares(probs_ppm, seed)?;
        let pool = Pool {
            n: probs_ppm.len(),
            q,
            pot: seed,
        };
        pool.check()?;
        Ok(pool)
    }

    pub fn shares(&self) -> &[u128] {
        &self.q[..self.n]
    }

    /// Invariant 1: `pot >= C(q) >= q_i`.
    pub fn check(&self) -> Result<()> {
        if self.n < 2 || self.n > MAX_OUTCOMES {
            return Err(MathError::BadOutcomeCount);
        }
        if !pot_covers_cost(self.pot, self.shares())? {
            return Err(MathError::InvariantViolated);
        }
        Ok(())
    }

    /// Quote a buy without changing the pool.
    pub fn quote_buy(&self, outcome: usize, usdc_in: u64, fee_bps: u16) -> Result<BuyOutcome> {
        let mut copy = self.clone();
        copy.buy(outcome, usdc_in, fee_bps)
    }

    /// Apply a buy: take the fee, add the rest to the pot, mint shares.
    pub fn buy(&mut self, outcome: usize, usdc_in: u64, fee_bps: u16) -> Result<BuyOutcome> {
        if outcome >= self.n {
            return Err(MathError::BadOutcome);
        }
        let (net, fee) = split_fee(usdc_in, fee_bps)?;
        if net == 0 {
            return Err(MathError::ZeroAmount);
        }
        let new_pot = self
            .pot
            .checked_add(net)
            .filter(|&p| p <= MAX_POT)
            .ok_or(MathError::PotCapExceeded)?;
        let shares = shares_for_buy(self.shares(), outcome, net)?;
        if shares == 0 {
            return Err(MathError::ZeroAmount);
        }
        self.q[outcome] += shares as u128;
        self.pot = new_pot;
        self.check()?;
        Ok(BuyOutcome {
            shares,
            net,
            fee,
            price_after_e6: price_e6(self.shares(), outcome)?,
            prob_after_ppm: prob_ppm(self.shares(), outcome)?,
        })
    }

    /// Payout per winning share (scaled 1e12) if `winner` wins now. Always >= 1e12.
    pub fn payout_rate(&self, winner: usize) -> Result<u128> {
        if winner >= self.n {
            return Err(MathError::BadOutcome);
        }
        payout_rate_e12(self.pot, self.q[winner])
    }

    /// Void price per share (scaled 1e12) for every outcome.
    pub fn void_rates(&self) -> Result<[u64; MAX_OUTCOMES]> {
        void_rates_e12(self.shares())
    }
}

#[cfg(test)]
mod tests;
