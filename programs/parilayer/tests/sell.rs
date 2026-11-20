//! Integration tests for selling back to the pool (spec: Testing, "Selling",
//! and milestone M4: "a wallet can buy, sell back, and the round-trip cost
//! equals the two fees").

mod common;

use {
    common::*,
    parilayer::state::{MarketKind, MarketStatus},
    parilayer_math::{redeem_value, RATE_SCALE},
    solana_signer::Signer,
};

const SEED: u64 = 500 * UNIT;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

#[test]
fn buy_then_sell_round_trip_costs_the_two_fees() {
    let mut env = Env::new();
    let market = env.create_full_market(id(1), MarketKind::Binary, &[300_000, 700_000], SEED);
    let start = 1_000 * UNIT;
    let (alice, alice_usdc) = env.new_user(start);
    let treasury_before = env.balance(env.treasury);
    let q_before = env.market(market).q;

    let x = 200 * UNIT;
    let (shares_acct, shares) = env.buy(&alice, alice_usdc, market, 0, x);
    let buy_fee = env.balance(env.treasury) - treasury_before;
    assert_eq!(buy_fee, 2 * UNIT, "1% buy fee to the treasury");
    env.assert_invariants(market);

    // Quote the sell exactly as the frontend will, then sell everything back.
    let quote = env
        .market(market)
        .pool()
        .quote_sell(0, shares, SELL_FEE_BPS, q_before[0])
        .unwrap();
    let pot_before_sell = env.market(market).pot;
    let ix = env.sell_ix(alice.pubkey(), shares_acct, alice_usdc, market, 0, shares, quote.usdc_out);
    ok(env.send(&[ix], &alice, &[]));

    // Shares burned, q back to the seed, nothing else touched.
    assert_eq!(env.balance(shares_acct), 0);
    let m = env.market(market);
    assert_eq!(m.q, q_before);
    // Seller received the refund minus 2%; the 2% stayed in the pot.
    let received = env.balance(alice_usdc) - (start - x);
    assert_eq!(received, quote.usdc_out);
    assert_eq!(m.pot, pot_before_sell - quote.usdc_out);
    // Round trip: cost = buy fee + sell fee, within 1 base unit of rounding.
    let net_in = x - buy_fee;
    assert!(net_in - quote.gross <= 1, "refund {} vs paid in {}", quote.gross, net_in);
    let round_trip_cost = x - received;
    assert!(
        round_trip_cost >= buy_fee + quote.fee && round_trip_cost - (buy_fee + quote.fee) <= 1,
        "round trip cost {round_trip_cost}, fees {} + {}",
        buy_fee,
        quote.fee
    );
    // The sell fee did not go to the treasury.
    assert_eq!(env.balance(env.treasury), treasury_before + buy_fee);
    env.assert_invariants(market);
}

#[test]
fn sell_rejections() {
    let mut env = Env::new();
    let market = env.create_full_market(id(2), MarketKind::Binary, &[500_000, 500_000], SEED);
    let (alice, alice_usdc) = env.new_user(1_000 * UNIT);
    let (bob, bob_usdc) = env.new_user(1_000 * UNIT);
    let (alice_shares, a) = env.buy(&alice, alice_usdc, market, 1, 100 * UNIT);
    env.buy(&bob, bob_usdc, market, 1, 300 * UNIT);
    let seed_q = env.balance(Env::seed_shares_pda(market, 1)) as u128;

    // min_usdc_out one unit above the quote fails and moves nothing.
    let quote = env.market(market).pool().quote_sell(1, a, SELL_FEE_BPS, seed_q).unwrap();
    let ix = env.sell_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, a, quote.usdc_out + 1);
    fails_with(env.send(&[ix], &alice, &[]), "SlippageExceeded");
    assert_eq!(env.balance(alice_shares), a);

    // Zero shares.
    let ix = env.sell_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, 0, 0);
    fails_with(env.send(&[ix], &alice, &[]), "ZeroAmount");

    // More than Alice holds (but less than q minus the seed, because Bob holds
    // shares too): the token program refuses the burn and nothing moves.
    let ix = env.sell_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, a + 1, 0);
    assert!(env.send(&[ix], &alice, &[]).is_err());
    assert_eq!(env.balance(alice_shares), a);

    // The treasury's seed shares cannot be sold: the account is owned by the
    // Config PDA, which no one can sign for.
    let seed_acct = Env::seed_shares_pda(market, 1);
    let ix = env.sell_ix(alice.pubkey(), seed_acct, alice_usdc, market, 1, UNIT, 0);
    fails_with(env.send(&[ix], &alice, &[]), "ConstraintTokenOwner");

    // Someone else's share account cannot be sold from either.
    let ix = env.sell_ix(bob.pubkey(), alice_shares, bob_usdc, market, 1, a, 0);
    fails_with(env.send(&[ix], &bob, &[]), "ConstraintTokenOwner");

    // Halted: no sells. Unhalted: sells work again.
    let oracle = env.oracle.insecure_clone();
    ok(env.send(&[env.halt_ix(oracle.pubkey(), market)], &oracle, &[]));
    let ix = env.sell_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, a / 2, 0);
    fails_with(env.send(&[ix], &alice, &[]), "MarketNotOpen");
    ok(env.send(&[env.unhalt_ix(oracle.pubkey(), market)], &oracle, &[]));
    let ix = env.sell_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, a / 2, 0);
    ok(env.send(&[ix], &alice, &[]));
    env.assert_invariants(market);

    // Resolved: no sells; holders redeem instead, at least 1 USDC a share.
    ok(env.send(&[env.resolve_ix(oracle.pubkey(), market, 1)], &oracle, &[]));
    assert_eq!(env.market(market).status, MarketStatus::Resolved);
    let left = env.balance(alice_shares);
    let ix = env.sell_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, left, 0);
    fails_with(env.send(&[ix], &alice, &[]), "MarketNotOpen");
    let before = env.balance(alice_usdc);
    ok(env.send(&[env.redeem_ix(alice.pubkey(), alice_shares, alice_usdc, market, 1, left)], &alice, &[]));
    assert!(env.balance(alice_usdc) - before >= left);
    env.assert_invariants(market);
}

#[test]
fn sell_to_a_fresh_address() {
    let mut env = Env::new();
    let market = env.create_full_market(id(3), MarketKind::Binary, &[500_000, 500_000], SEED);
    let (alice, alice_usdc) = env.new_user(1_000 * UNIT);
    let (shares_acct, shares) = env.buy(&alice, alice_usdc, market, 0, 50 * UNIT);
    let fresh = env.token_account(env.usdc_mint, anchor_lang::prelude::Pubkey::new_unique(), 0);
    let ix = env.sell_ix(alice.pubkey(), shares_acct, fresh, market, 0, shares, 0);
    ok(env.send(&[ix], &alice, &[]));
    assert!(env.balance(fresh) > 0);
    env.assert_invariants(market);
}

/// 300 random buys and sells by 4 traders on a 5-outcome market: invariants
/// hold on-chain after each, no outcome falls below its seed, and every
/// possible winner still pays each holder at least 1 USDC a share.
#[test]
fn random_buys_and_sells_keep_invariants_on_chain() {
    let mut env = Env::new();
    let probs = [100_000u32, 150_000, 200_000, 250_000, 300_000];
    let market = env.create_full_market(id(4), MarketKind::Multi, &probs, SEED);
    let seed_q = env.market(market).q;
    let mut traders = Vec::new();
    for _ in 0..4 {
        let (kp, usdc) = env.new_user(1_000_000 * UNIT);
        let accts: Vec<_> = (0..5u8)
            .map(|i| env.token_account(Env::mint_pda(market, i), kp.pubkey(), 0))
            .collect();
        traders.push((kp, usdc, accts));
    }
    let mut rng = Rng(0x5eed_5e11);
    let mut sells = 0;
    for _ in 0..300 {
        let t = (rng.next() % 4) as usize;
        let o = (rng.next() % 5) as u8;
        let (kp, usdc, accts) = &traders[t];
        let kp = kp.insecure_clone();
        let (usdc, acct) = (*usdc, accts[o as usize]);
        let held = env.balance(acct);
        if rng.next() % 2 == 0 && held > 0 {
            let s = (held * (1 + rng.next() % 100) / 100).max(1);
            let ix = env.sell_ix(kp.pubkey(), acct, usdc, market, o, s, 0);
            // A sale worth less than one base unit is rejected; anything else lands.
            if env.send(&[ix], &kp, &[]).is_ok() {
                sells += 1;
            }
        } else {
            let x = match rng.next() % 10 {
                0 => 5_000 * UNIT + rng.next() % (50_000 * UNIT),
                1..=3 => 50 * UNIT + rng.next() % (1_000 * UNIT),
                _ => 1 + rng.next() % (50 * UNIT),
            };
            let ix = env.buy_ix(kp.pubkey(), usdc, acct, market, o, x, 0);
            let _ = env.send(&[ix], &kp, &[]);
        }
        env.assert_invariants(market);
        let m = env.market(market);
        for i in 0..5 {
            assert!(m.q[i] >= seed_q[i], "outcome {i} fell below its seed");
        }
    }
    assert!(sells > 50, "only {sells} sells landed");

    let m = env.market(market);
    for w in 0..5 {
        let rate = m.pool().payout_rate(w).unwrap();
        assert!(rate >= RATE_SCALE);
        assert!(redeem_value(m.q[w] as u64, rate).unwrap() <= m.pot);
    }
}
