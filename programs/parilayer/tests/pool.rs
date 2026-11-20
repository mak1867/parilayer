//! Integration tests for the pool program: the paths listed in the build spec
//! under "Program (Anchor integration tests)", plus the edges around them.

mod common;

use {
    common::*,
    parilayer::state::{MarketKind, MarketStatus},
    parilayer_math::{redeem_value, Pool, RATE_SCALE},
    solana_signer::Signer,
};

const SEED: u64 = 500 * UNIT;

/// Tiny deterministic generator so the random-buy test is reproducible.
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
fn create_buy_resolve_redeem() {
    let mut env = Env::new();
    // Binary market: index 0 = NO at 38%, index 1 = YES at 62%.
    let probs = [380_000u32, 620_000];
    let market = env.create_full_market(id(1), MarketKind::Binary, &probs, SEED);

    // Seeded exactly as the math says, paid by the treasury.
    let m = env.market(market);
    let model = Pool::seeded(&probs, SEED).unwrap();
    assert_eq!(m.status, MarketStatus::Open);
    assert_eq!(m.n_outcomes, 2);
    assert_eq!(m.q, model.q);
    assert_eq!(m.pot, SEED);
    assert_eq!(m.winner, parilayer::constants::NO_WINNER);
    assert_eq!(env.balance(env.treasury), TREASURY_FUNDING - SEED);
    for i in 0..2u8 {
        assert_eq!(
            env.balance(Env::seed_shares_pda(market, i)) as u128,
            m.q[i as usize],
            "treasury holds the seed shares"
        );
    }
    env.assert_invariants(market);

    // Alice buys 100 USDC of YES.
    let (alice, alice_usdc) = env.new_user(1_000 * UNIT);
    let quote = model.quote_buy(1, 100 * UNIT, POOL_FEE_BPS).unwrap();
    let (alice_yes, alice_shares) = env.buy(&alice, alice_usdc, market, 1, 100 * UNIT);
    assert_eq!(alice_shares, quote.shares);
    assert_eq!(quote.fee, UNIT, "1% fee");
    assert_eq!(env.balance(alice_usdc), 900 * UNIT);
    assert_eq!(env.market(market).pot, SEED + 99 * UNIT);
    assert_eq!(env.config_state().fees_collected, UNIT);
    // Pool price <= 1 USDC: she got at least one share per USDC that reached the pot.
    assert!(alice_shares >= 99 * UNIT);
    env.assert_invariants(market);

    // Bob buys NO and has the shares delivered to a fresh address he does not own.
    let (bob, bob_usdc) = env.new_user(1_000 * UNIT);
    let fresh_owner = anchor_lang::prelude::Pubkey::new_unique();
    let fresh_acct = env.token_account(Env::mint_pda(market, 0), fresh_owner, 0);
    let ix = env.buy_ix(bob.pubkey(), bob_usdc, fresh_acct, market, 0, 250 * UNIT, 0);
    ok(env.send(&[ix], &bob, &[]));
    assert!(env.balance(fresh_acct) > 0);
    let (bob_no, bob_no_shares) = env.buy(&bob, bob_usdc, market, 0, 50 * UNIT);
    env.assert_invariants(market);

    // A whale floods YES with 50,000 USDC: 100x the seed.
    let (whale, whale_usdc) = env.new_user(100_000 * UNIT);
    let (whale_yes, whale_shares) = env.buy(&whale, whale_usdc, market, 1, 50_000 * UNIT);
    env.assert_invariants(market);

    // Nothing can be redeemed before resolution.
    let ix = env.redeem_ix(alice.pubkey(), alice_yes, alice_usdc, market, 1, alice_shares);
    fails_with(env.send(&[ix], &alice, &[]), "MarketNotSettled");

    // The oracle resolves YES.
    let oracle = env.oracle.insecure_clone();
    let ix = env.resolve_ix(oracle.pubkey(), market, 1);
    ok(env.send(&[ix], &oracle, &[]));
    let m = env.market(market);
    assert_eq!(m.status, MarketStatus::Resolved);
    assert_eq!(m.winner, 1);
    assert!(m.payout_per_share >= RATE_SCALE, "a winning share pays at least 1 USDC");
    assert!(m.payout_per_share * m.q[1] <= (m.pot as u128) * RATE_SCALE); // invariant 4
    let pot_at_resolution = m.pot;
    let rate = m.payout_per_share;

    // Resolving twice, or buying after resolution, fails.
    let ix = env.resolve_ix(oracle.pubkey(), market, 0);
    fails_with(env.send(&[ix], &oracle, &[]), "MarketClosed");
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, alice_yes, market, 1, UNIT, 0);
    fails_with(env.send(&[ix], &alice, &[]), "MarketNotOpen");

    // Losing shares pay nothing: redeeming them is rejected.
    let ix = env.redeem_ix(bob.pubkey(), bob_no, bob_usdc, market, 0, bob_no_shares);
    fails_with(env.send(&[ix], &bob, &[]), "NotWinningOutcome");
    // And nobody can redeem from an account they do not own.
    let ix = env.redeem_ix(bob.pubkey(), alice_yes, bob_usdc, market, 1, 1);
    assert!(env.send(&[ix], &bob, &[]).is_err());

    // Alice redeems everything. Even after the whale diluted her, she is paid at
    // least 1 USDC per share, which is at least what her shares cost at the pool.
    let before = env.balance(alice_usdc);
    let ix = env.redeem_ix(alice.pubkey(), alice_yes, alice_usdc, market, 1, alice_shares);
    ok(env.send(&[ix], &alice, &[]));
    let alice_paid = env.balance(alice_usdc) - before;
    assert_eq!(alice_paid, redeem_value(alice_shares, rate).unwrap());
    assert!(alice_paid >= alice_shares, "floor: 1 USDC per share");
    assert!(alice_paid >= 99 * UNIT, "she gets back at least what reached the pot");
    assert_eq!(env.balance(alice_yes), 0);
    env.assert_invariants(market);

    // The whale redeems in two pieces.
    let half = whale_shares / 2;
    let before = env.balance(whale_usdc);
    let ix = env.redeem_ix(whale.pubkey(), whale_yes, whale_usdc, market, 1, half);
    ok(env.send(&[ix], &whale, &[]));
    let ix = env.redeem_ix(whale.pubkey(), whale_yes, whale_usdc, market, 1, whale_shares - half);
    ok(env.send(&[ix], &whale, &[]));
    let whale_paid = env.balance(whale_usdc) - before;
    assert!(whale_paid >= whale_shares);
    // Redeeming more than you hold fails.
    let ix = env.redeem_ix(whale.pubkey(), whale_yes, whale_usdc, market, 1, 1);
    assert!(env.send(&[ix], &whale, &[]).is_err());
    env.assert_invariants(market);

    // Dust cannot be swept while the treasury's seed shares are unclaimed.
    let admin = env.admin.insecure_clone();
    let ix = env.sweep_ix(admin.pubkey(), market);
    fails_with(env.send(&[ix], &admin, &[]), "SweepTooEarly");

    // Anyone can redeem the treasury's seed shares; the payout goes to the treasury.
    let ix = env.redeem_seed_ix(market, 0);
    fails_with(env.send(&[ix], &bob, &[]), "NotWinningOutcome");
    let ix = env.redeem_seed_ix(market, 1);
    ok(env.send(&[ix], &bob, &[]));
    let seed_paid = env.config_state().seed_payouts;
    assert!(seed_paid as u128 >= env.market(market).q[1] - alice_shares as u128 - whale_shares as u128);
    env.assert_invariants(market);

    // Every winning share is burned; what is left in the pot is rounding dust.
    let m = env.market(market);
    assert_eq!(m.burned[1] as u128, m.q[1]);
    assert_eq!(alice_paid + whale_paid + seed_paid + m.pot, pot_at_resolution);
    assert!(m.pot < 10, "dust is a few base units, got {}", m.pot);

    // Only the admin can sweep it.
    let ix = env.sweep_ix(bob.pubkey(), market);
    fails_with(env.send(&[ix], &bob, &[]), "NotAdmin");
    let ix = env.sweep_ix(admin.pubkey(), market);
    ok(env.send(&[ix], &admin, &[]));
    assert_eq!(env.balance(Env::vault_pda(market)), 0);
    assert_eq!(env.market(market).pot, 0);
    env.assert_invariants(market);
}

#[test]
fn void_path() {
    let mut env = Env::new();
    let probs = [200_000u32, 300_000, 500_000];
    let market = env.create_full_market(id(2), MarketKind::Multi, &probs, SEED);

    let (alice, alice_usdc) = env.new_user(10_000 * UNIT);
    let (bob, bob_usdc) = env.new_user(10_000 * UNIT);
    let (a_acct, a_shares) = env.buy(&alice, alice_usdc, market, 0, 400 * UNIT);
    let (b_acct, b_shares) = env.buy(&bob, bob_usdc, market, 2, 1_500 * UNIT);
    env.assert_invariants(market);

    // Only the oracle can void.
    let ix = env.void_ix(alice.pubkey(), market);
    fails_with(env.send(&[ix], &alice, &[]), "NotOracle");

    let oracle = env.oracle.insecure_clone();
    let ix = env.void_ix(oracle.pubkey(), market);
    ok(env.send(&[ix], &oracle, &[]));
    let m = env.market(market);
    assert_eq!(m.status, MarketStatus::Voided);
    assert_eq!(m.resolved_at, env.now());
    assert!(m.created_at > 0);
    let pot_at_void = m.pot;

    // Final prices are the pool prices at the void, and the pot covers all of them.
    let model = m.pool();
    let rates = model.void_rates().unwrap();
    assert_eq!(m.final_prices, rates);
    let owed: u128 = (0..3)
        .map(|i| redeem_value(m.q[i] as u64, rates[i] as u128).unwrap() as u128)
        .sum();
    assert!(owed <= pot_at_void as u128, "void prices sum to at most the pot");

    // No buying, no resolving after a void.
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, a_acct, market, 0, UNIT, 0);
    fails_with(env.send(&[ix], &alice, &[]), "MarketNotOpen");
    let ix = env.resolve_ix(oracle.pubkey(), market, 0);
    fails_with(env.send(&[ix], &oracle, &[]), "MarketClosed");

    // Every holder of every outcome redeems at that outcome's final price.
    let before = env.balance(alice_usdc);
    let ix = env.redeem_ix(alice.pubkey(), a_acct, alice_usdc, market, 0, a_shares);
    ok(env.send(&[ix], &alice, &[]));
    let a_paid = env.balance(alice_usdc) - before;
    assert_eq!(a_paid, redeem_value(a_shares, rates[0] as u128).unwrap());
    assert!(a_paid <= 396 * UNIT, "a void refunds at the final price, never more than was paid in");

    let before = env.balance(bob_usdc);
    let ix = env.redeem_ix(bob.pubkey(), b_acct, bob_usdc, market, 2, b_shares);
    ok(env.send(&[ix], &bob, &[]));
    let b_paid = env.balance(bob_usdc) - before;
    assert_eq!(b_paid, redeem_value(b_shares, rates[2] as u128).unwrap());
    env.assert_invariants(market);

    // Seed shares of outcomes 0 and 1 redeemed; outcome 2's are left unclaimed.
    for i in 0..2u8 {
        let ix = env.redeem_seed_ix(market, i);
        ok(env.send(&[ix], &bob, &[]));
    }
    env.assert_invariants(market);

    // With claims outstanding the sweep must wait 30 days.
    let admin = env.admin.insecure_clone();
    let ix = env.sweep_ix(admin.pubkey(), market);
    fails_with(env.send(&[ix], &admin, &[]), "SweepTooEarly");
    env.warp_seconds(parilayer::constants::SWEEP_DELAY_SECS - 10);
    let ix = env.sweep_ix(admin.pubkey(), market);
    fails_with(env.send(&[ix], &admin, &[]), "SweepTooEarly");
    env.warp_seconds(20);
    let ix = env.sweep_ix(admin.pubkey(), market);
    ok(env.send(&[ix], &admin, &[]));
    assert_eq!(env.balance(Env::vault_pda(market)), 0);
    env.assert_invariants(market);
}

#[test]
fn only_the_oracle_can_resolve_void_or_halt() {
    let mut env = Env::new();
    let market = env.create_full_market(id(3), MarketKind::Binary, &[500_000, 500_000], SEED);
    let (mallory, _) = env.new_user(0);
    let admin = env.admin.insecure_clone();

    // A random wallet, and even the admin, are rejected: only the oracle key works.
    for signer in [&mallory, &admin] {
        let ix = env.resolve_ix(signer.pubkey(), market, 1);
        fails_with(env.send(&[ix], signer, &[]), "NotOracle");
        let ix = env.void_ix(signer.pubkey(), market);
        fails_with(env.send(&[ix], signer, &[]), "NotOracle");
        let ix = env.halt_ix(signer.pubkey(), market);
        fails_with(env.send(&[ix], signer, &[]), "NotOracle");
        let ix = env.unhalt_ix(signer.pubkey(), market);
        fails_with(env.send(&[ix], signer, &[]), "NotOracle");
    }
    assert_eq!(env.market(market).status, MarketStatus::Open);

    // Creating markets and mints is oracle-only too.
    let ix = env.create_market_ix(
        mallory.pubkey(),
        id(4),
        MarketKind::Binary,
        vec!["X".into()],
        2,
        vec![500_000, 500_000],
        SEED,
    );
    fails_with(env.send(&[ix], &mallory, &[]), "NotOracle");

    // Config changes are admin-only.
    let ix = anchor_lang::solana_program::instruction::Instruction::new_with_bytes(
        parilayer::id(),
        &anchor_lang::InstructionData::data(&parilayer::instruction::UpdateConfig {
            oracle: mallory.pubkey(),
            pool_fee_bps: 0,
            sell_fee_bps: 0,
        }),
        anchor_lang::ToAccountMetas::to_account_metas(
            &parilayer::accounts::UpdateConfig {
                admin: mallory.pubkey(),
                config: env.config,
            },
            None,
        ),
    );
    fails_with(env.send(&[ix], &mallory, &[]), "NotAdmin");
    assert_eq!(env.config_state().oracle, env.oracle.pubkey());
}

#[test]
fn min_shares_out_and_halt() {
    let mut env = Env::new();
    let probs = [500_000u32, 500_000];
    let market = env.create_full_market(id(5), MarketKind::Binary, &probs, SEED);
    let (alice, alice_usdc) = env.new_user(10_000 * UNIT);
    let shares_acct = env.token_account(Env::mint_pda(market, 1), alice.pubkey(), 0);

    // Asking for one base unit more than the pool gives fails; the exact amount passes.
    let quote = env.market(market).pool().quote_buy(1, 100 * UNIT, POOL_FEE_BPS).unwrap();
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, shares_acct, market, 1, 100 * UNIT, quote.shares + 1);
    fails_with(env.send(&[ix], &alice, &[]), "SlippageExceeded");
    assert_eq!(env.balance(alice_usdc), 10_000 * UNIT, "a failed buy moves nothing");
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, shares_acct, market, 1, 100 * UNIT, quote.shares);
    ok(env.send(&[ix], &alice, &[]));
    assert_eq!(env.balance(shares_acct), quote.shares);

    // Zero and dust buys are rejected.
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, shares_acct, market, 1, 0, 0);
    fails_with(env.send(&[ix], &alice, &[]), "ZeroAmount");
    // An outcome index beyond n has no mint, so the transaction cannot even load.
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, shares_acct, market, 2, UNIT, 0);
    assert!(env.send(&[ix], &alice, &[]).is_err());

    // Halted: buying fails. Unhalted: it works again.
    let oracle = env.oracle.insecure_clone();
    let ix = env.halt_ix(oracle.pubkey(), market);
    ok(env.send(&[ix], &oracle, &[]));
    assert_eq!(env.market(market).status, MarketStatus::Halted);
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, shares_acct, market, 1, 10 * UNIT, 0);
    fails_with(env.send(&[ix], &alice, &[]), "MarketNotOpen");
    let ix = env.halt_ix(oracle.pubkey(), market);
    fails_with(env.send(&[ix], &oracle, &[]), "MarketNotOpen");

    let ix = env.unhalt_ix(oracle.pubkey(), market);
    ok(env.send(&[ix], &oracle, &[]));
    let ix = env.unhalt_ix(oracle.pubkey(), market);
    fails_with(env.send(&[ix], &oracle, &[]), "MarketNotHalted");
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, shares_acct, market, 1, 10 * UNIT, 0);
    ok(env.send(&[ix], &alice, &[]));

    // A halted market can still be resolved.
    let ix = env.halt_ix(oracle.pubkey(), market);
    ok(env.send(&[ix], &oracle, &[]));
    let ix = env.resolve_ix(oracle.pubkey(), market, 1);
    ok(env.send(&[ix], &oracle, &[]));
    assert_eq!(env.market(market).status, MarketStatus::Resolved);
    // ...and a settled market can no longer be halted.
    let ix = env.halt_ix(oracle.pubkey(), market);
    fails_with(env.send(&[ix], &oracle, &[]), "MarketClosed");
    env.assert_invariants(market);
}

#[test]
fn thirty_two_outcome_market() {
    let mut env = Env::new();
    let oracle = env.oracle.insecure_clone();
    // 32 outcomes: one favourite, 31 long shots at the 0.5% floor... plus the rest spread evenly.
    let mut probs = vec![25_000u32; 32];
    probs[7] = 1_000_000 - 31 * 25_000;
    let ix = env.create_market_ix(
        oracle.pubkey(),
        id(6),
        MarketKind::Multi,
        vec!["GEMI-BIGRACE".into()],
        32,
        probs.clone(),
        SEED,
    );
    ok(env.send(&[ix], &oracle, &[]));
    let market = Env::market_pda(id(6));

    // First batch of mints only: buying is blocked until all 32 exist.
    let ixs: Vec<_> = (0..6u8).map(|i| env.init_mint_ix(oracle.pubkey(), market, i)).collect();
    ok(env.send(&ixs, &oracle, &[]));
    let (alice, alice_usdc) = env.new_user(10_000 * UNIT);
    let early = env.token_account(Env::mint_pda(market, 0), alice.pubkey(), 0);
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, early, market, 0, UNIT, 0);
    fails_with(env.send(&[ix], &alice, &[]), "MintsNotReady");
    let ix = env.resolve_ix(oracle.pubkey(), market, 0);
    fails_with(env.send(&[ix], &oracle, &[]), "MintsNotReady");

    // A mint cannot be created twice, and index 32 does not exist.
    let ix = env.init_mint_ix(oracle.pubkey(), market, 0);
    assert!(env.send(&[ix], &oracle, &[]).is_err());
    let ix = env.init_mint_ix(oracle.pubkey(), market, 32);
    fails_with(env.send(&[ix], &oracle, &[]), "BadOutcome");

    // The rest, in batches of 6.
    for chunk in (6..32u8).collect::<Vec<_>>().chunks(6) {
        let ixs: Vec<_> = chunk.iter().map(|&i| env.init_mint_ix(oracle.pubkey(), market, i)).collect();
        ok(env.send(&ixs, &oracle, &[]));
    }
    let m = env.market(market);
    assert_eq!(m.mints_ready, u32::MAX);
    assert_eq!(m.n_outcomes, 32);
    for i in 0..32u8 {
        assert_eq!(env.supply(Env::mint_pda(market, i)) as u128, m.q[i as usize]);
    }
    env.assert_invariants(market);

    // Buy the last outcome and the favourite; report compute use.
    let last = env.token_account(Env::mint_pda(market, 31), alice.pubkey(), 0);
    let ix = env.buy_ix(alice.pubkey(), alice_usdc, last, market, 31, 200 * UNIT, 0);
    let meta = ok(env.send(&[ix], &alice, &[]));
    println!("buy on a 32-outcome market: {} compute units", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < 200_000, "buy must fit the default compute budget");
    let (_, fav_shares) = env.buy(&alice, alice_usdc, market, 7, 300 * UNIT);
    assert!(fav_shares > 0);
    env.assert_invariants(market);

    // The long shot wins; payout per share is well above 1 USDC.
    let ix = env.resolve_ix(oracle.pubkey(), market, 31);
    ok(env.send(&[ix], &oracle, &[]));
    let m = env.market(market);
    assert!(m.payout_per_share >= RATE_SCALE);
    let shares = env.balance(last);
    let before = env.balance(alice_usdc);
    let ix = env.redeem_ix(alice.pubkey(), last, alice_usdc, market, 31, shares);
    ok(env.send(&[ix], &alice, &[]));
    assert!(env.balance(alice_usdc) - before >= shares);
    env.assert_invariants(market);
}

#[test]
fn create_market_validation() {
    let mut env = Env::new();
    let oracle = env.oracle.insecure_clone();
    let o = oracle.pubkey();
    let one = || vec!["GEMI-A".to_string()];
    let two = || vec!["GEMI-A".to_string(), "GEMI-B".to_string()];

    // Outcome count must fit the kind.
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, one(), 3, vec![300_000, 300_000, 400_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadOutcomeCount");
    let ix = env.create_market_ix(o, id(10), MarketKind::Multi, one(), 2, vec![500_000, 500_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadOutcomeCount");
    let ix = env.create_market_ix(o, id(10), MarketKind::Pair, two(), 2, vec![500_000, 500_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadOutcomeCount");
    // n must match the number of probabilities.
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, one(), 2, vec![500_000, 250_000, 250_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadOutcomeCount");
    // Refs must fit the kind.
    let ix = env.create_market_ix(o, id(10), MarketKind::Pair, one(), 4, vec![250_000; 4], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadRefs");
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, two(), 2, vec![500_000, 500_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadRefs");
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, vec!["X".repeat(65)], 2, vec![500_000, 500_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadRefs");
    // Probabilities must be clamped and sum to 100%.
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, one(), 2, vec![999_000, 1_000], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadProbabilities");
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, one(), 2, vec![500_000, 499_999], SEED);
    fails_with(env.send(&[ix], &oracle, &[]), "BadProbabilities");
    // Seed too small, and seed larger than the treasury.
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, one(), 2, vec![500_000, 500_000], UNIT - 1);
    fails_with(env.send(&[ix], &oracle, &[]), "SeedTooSmall");
    let ix = env.create_market_ix(o, id(10), MarketKind::Binary, one(), 2, vec![500_000, 500_000], TREASURY_FUNDING + 1);
    fails_with(env.send(&[ix], &oracle, &[]), "TreasuryCannotCoverSeed");
    assert_eq!(env.balance(env.treasury), TREASURY_FUNDING, "failed creations cost the treasury nothing");

    // A valid pair pool: 4 joint outcomes seeded from the product of two legs (60% and 30%).
    // index = 2a + b: NN, NY, YN, YY.
    let probs = vec![280_000u32, 120_000, 420_000, 180_000];
    let market = env.create_full_market(id(11), MarketKind::Pair, &probs, SEED);
    let m = env.market(market);
    assert_eq!(m.kind, MarketKind::Pair);
    assert_eq!(m.gemini_refs.len(), 2);
    for i in 0..4 {
        let got = parilayer_math::prob_ppm(&m.q[..4], i).unwrap() as i64;
        assert!((got - probs[i] as i64).abs() <= 1_000, "seed reproduces the probability");
    }
    // The same market id cannot be created twice.
    let ix = env.create_market_ix(o, id(11), MarketKind::Pair, two(), 4, probs.clone(), SEED);
    assert!(env.send(&[ix], &oracle, &[]).is_err());
    assert_eq!(env.config_state().market_count, 1);
    env.assert_invariants(market);
}

#[test]
fn collateral_must_have_six_decimals() {
    let err = Env::with_usdc_decimals(9).err().expect("9-decimal collateral must be rejected");
    assert!(err.contains("BadCollateralDecimals"), "{err}");
}

#[test]
fn random_buys_keep_invariants_on_chain() {
    let mut env = Env::new();
    let probs = [280_000u32, 120_000, 420_000, 180_000];
    let market = env.create_full_market(id(20), MarketKind::Pair, &probs, SEED);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut model = env.market(market).pool();

    let mut holders = Vec::new();
    for round in 0..120 {
        let outcome = (rng.next() % 4) as u8;
        // Mostly small buys, every tenth one a whale of up to 200,000 USDC.
        let usdc_in = if round % 10 == 9 {
            1_000 * UNIT + rng.next() % (200_000 * UNIT)
        } else {
            1 + rng.next() % (300 * UNIT)
        };
        let (user, user_usdc) = env.new_user(usdc_in);
        let expected = model.buy(outcome as usize, usdc_in, POOL_FEE_BPS);
        let acct = env.token_account(Env::mint_pda(market, outcome), user.pubkey(), 0);
        let ix = env.buy_ix(user.pubkey(), user_usdc, acct, market, outcome, usdc_in, 0);
        let res = env.send(&[ix], &user, &[]);
        match expected {
            Ok(out) => {
                ok(res);
                assert_eq!(env.balance(acct), out.shares, "program and model agree");
                holders.push((user, user_usdc, acct, outcome, out.shares));
            }
            Err(_) => assert!(res.is_err()),
        }
        let m = env.market(market);
        assert_eq!(m.q, model.q);
        assert_eq!(m.pot, model.pot);
        env.assert_invariants(market);
    }

    // Whichever outcome wins, a share would pay at least 1 USDC.
    let m = env.market(market);
    for w in 0..4 {
        assert!(m.pool().payout_rate(w).unwrap() >= RATE_SCALE);
    }

    // Resolve outcome 2 and let every winner redeem: each gets >= 1 USDC per share.
    let oracle = env.oracle.insecure_clone();
    let ix = env.resolve_ix(oracle.pubkey(), market, 2);
    ok(env.send(&[ix], &oracle, &[]));
    for (user, user_usdc, acct, outcome, shares) in holders {
        if outcome != 2 {
            continue;
        }
        let before = env.balance(user_usdc);
        let ix = env.redeem_ix(user.pubkey(), acct, user_usdc, market, 2, shares);
        ok(env.send(&[ix], &user, &[]));
        assert!(env.balance(user_usdc) - before >= shares);
    }
    let ix = env.redeem_seed_ix(market, 2);
    ok(env.send(&[ix], &oracle, &[]));
    env.assert_invariants(market);
    assert!(env.market(market).pot < 200, "only rounding dust is left");
}
