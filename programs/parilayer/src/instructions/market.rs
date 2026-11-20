use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked};
use parilayer_math::Pool;

use crate::{
    constants::*,
    error::{math, ErrorCode},
    state::*,
};

// ---------------------------------------------------------------- create_market

#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ ErrorCode::NotOracle,
        has_one = usdc_mint,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = oracle,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, market_id.as_ref()],
        bump
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = oracle,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = market,
        token::token_program = token_program,
    )]
    pub pot_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `create_market` (oracle only). Creates a market and its pot vault, seeded
/// from the treasury at Gemini's probabilities.
/// Checks: outcome count and Gemini refs fit the kind (binary 2, multi 3-32,
/// pair 4 with two refs); probabilities are each 0.5%-99.5% and sum to 100%;
/// the seed is at least 1 USDC; the treasury can cover it.
/// Moves: `seed_usdc` from the treasury vault to the pot vault, signed by the
/// Config PDA. Formula: qᵢ = S·√πᵢ, which costs exactly C(q) = S. The market's address is a PDA of `market_id`, so the same Gemini
/// refs can never create two markets. Invariant 2 is checked at the end.
pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    market_id: [u8; 32],
    kind: MarketKind,
    refs: Vec<String>,
    n: u8,
    seed_probs_ppm: Vec<u32>,
    seed_usdc: u64,
) -> Result<()> {
    // Shape checks: outcome count and refs must fit the kind.
    require!(
        seed_probs_ppm.len() == n as usize,
        ErrorCode::BadOutcomeCount
    );
    let (n_ok, refs_wanted) = match kind {
        MarketKind::Binary => (n == 2, 1),
        MarketKind::Multi => ((3..=32).contains(&n), 1),
        MarketKind::Pair => (n == 4, 2),
    };
    require!(n_ok, ErrorCode::BadOutcomeCount);
    require!(refs.len() == refs_wanted, ErrorCode::BadRefs);
    for r in refs.iter() {
        require!(
            !r.is_empty() && r.len() <= MAX_REF_LEN as usize,
            ErrorCode::BadRefs
        );
    }

    // q_i = seed * sqrt(pi_i); this validates the probabilities and the seed size.
    let pool = math(Pool::seeded(&seed_probs_ppm, seed_usdc))?;

    require!(
        ctx.accounts.treasury_vault.amount >= seed_usdc,
        ErrorCode::TreasuryCannotCoverSeed
    );

    // Seed USDC: treasury vault -> pot vault, signed by the Config PDA.
    let config_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.treasury_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.pot_vault.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[config_seeds],
        ),
        seed_usdc,
        DECIMALS,
    )?;

    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    market.market_id = market_id;
    market.kind = kind;
    market.gemini_refs = refs;
    market.n_outcomes = n;
    market.q = pool.q;
    market.pot = pool.pot;
    market.status = MarketStatus::Open;
    market.winner = NO_WINNER;
    market.payout_per_share = 0;
    market.final_prices = [0u64; 32];
    market.created_at = Clock::get()?.unix_timestamp;
    market.resolved_at = 0;
    market.seed_usdc = seed_usdc;
    market.burned = [0u64; 32];
    market.mints_ready = 0;
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.pot_vault;

    let config = &mut ctx.accounts.config;
    config.seeds_paid = config
        .seeds_paid
        .checked_add(seed_usdc)
        .ok_or(ErrorCode::Overflow)?;
    config.market_count += 1;

    // Invariant 2: the pot vault holds exactly the pot.
    ctx.accounts.pot_vault.reload()?;
    require!(
        ctx.accounts.pot_vault.amount >= market.pot,
        ErrorCode::InvariantVaultBelowPot
    );

    emit!(MarketCreated {
        market: market_key,
        market_id,
        kind,
        n_outcomes: n,
        seed_usdc,
    });
    Ok(())
}

// ---------------------------------------------------------------- init_outcome_mint

#[derive(Accounts)]
#[instruction(i: u8)]
pub struct InitOutcomeMint<'info> {
    #[account(mut)]
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ ErrorCode::NotOracle,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    /// Outcome i's share mint: a classic SPL token whose only minter is the Market PDA.
    #[account(
        init,
        payer = oracle,
        seeds = [MINT_SEED, market.key().as_ref(), &[i]],
        bump,
        mint::decimals = DECIMALS,
        mint::authority = market,
        mint::token_program = token_program,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,
    /// The treasury's seed shares of outcome i, owned by the Config PDA.
    #[account(
        init,
        payer = oracle,
        seeds = [SEED_SHARES_SEED, market.key().as_ref(), &[i]],
        bump,
        token::mint = outcome_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub seed_shares: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `init_outcome_mint` (oracle only). Creates outcome i's share mint (an SPL
/// token, like one ERC-20 per outcome, with the Market PDA as mint authority)
/// and mints its seed shares qᵢ into a treasury-owned account. Called in
/// batches so a 32-outcome market fits in transaction limits; nobody can buy
/// or sell until every mint exists. Invariant 3 is checked at the end.
pub fn handle_init_outcome_mint(ctx: Context<InitOutcomeMint>, i: u8) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(i < market.n_outcomes, ErrorCode::BadOutcome);

    // Nobody can buy outcome i before its mint exists, so q[i] is still the seed amount.
    let seed_shares = u64::try_from(market.q[i as usize]).map_err(|_| ErrorCode::Overflow)?;

    let market_seeds: &[&[u8]] = &[MARKET_SEED, market.market_id.as_ref(), &[market.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.outcome_mint.to_account_info(),
                to: ctx.accounts.seed_shares.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[market_seeds],
        ),
        seed_shares,
    )?;

    let market = &mut ctx.accounts.market;
    market.mints_ready |= 1u32 << i;

    // Invariant 3: supply + burned = q.
    ctx.accounts.outcome_mint.reload()?;
    require!(
        ctx.accounts.outcome_mint.supply as u128 + market.burned[i as usize] as u128
            == market.q[i as usize],
        ErrorCode::InvariantSupplyMismatch
    );
    Ok(())
}

// ---------------------------------------------------------------- halt / unhalt / resolve / void

/// Accounts for the oracle-only instructions that just change market state.
#[derive(Accounts)]
pub struct OracleMarket<'info> {
    pub oracle: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = oracle @ ErrorCode::NotOracle,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
}

/// `halt` / `unhalt` (oracle only). Mirrors Gemini stopping or restarting
/// trading on the event. Halted: no buys and no sells; resolve and void still
/// work. Checks: the market is not settled, and is Open (to halt) or Halted
/// (to unhalt). Moves: nothing.
pub fn handle_set_halted(ctx: Context<OracleMarket>, halted: bool) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    require!(!market.is_settled(), ErrorCode::MarketClosed);
    if halted {
        require!(
            market.status == MarketStatus::Open,
            ErrorCode::MarketNotOpen
        );
        market.status = MarketStatus::Halted;
    } else {
        require!(
            market.status == MarketStatus::Halted,
            ErrorCode::MarketNotHalted
        );
        market.status = MarketStatus::Open;
    }
    emit!(HaltEvent {
        market: market_key,
        halted,
    });
    Ok(())
}

/// `resolve(winner)` (oracle only). Records Gemini's result.
/// Checks: not already settled, every mint exists, the winner index exists.
/// Sets payout_per_share = floor(M × 1e12 / q_winner), which is at least 1 USDC
/// because M ≥ C(q) ≥ q_winner (invariant 1). Checks invariant 4
/// (payout_per_share × q_winner ≤ M) before saving. Moves: nothing; holders
/// collect with `redeem`.
pub fn handle_resolve(ctx: Context<OracleMarket>, winner: u8) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    require!(!market.is_settled(), ErrorCode::MarketClosed);
    require!(market.all_mints_ready(), ErrorCode::MintsNotReady);
    require!(winner < market.n_outcomes, ErrorCode::BadOutcome);

    let pool = market.pool();
    math(pool.check())?;
    // payout_per_share = floor(M * 1e12 / q_winner) >= 1e12, i.e. at least 1 USDC.
    let rate = math(pool.payout_rate(winner as usize))?;

    // Invariant 4: payout_per_share * q_winner <= M.
    require!(
        rate.checked_mul(market.q[winner as usize])
            .ok_or(ErrorCode::Overflow)?
            <= (market.pot as u128) * parilayer_math::RATE_SCALE,
        ErrorCode::InvariantPayoutAbovePot
    );

    market.status = MarketStatus::Resolved;
    market.winner = winner;
    market.payout_per_share = rate;
    market.resolved_at = Clock::get()?.unix_timestamp;

    emit!(ResolveEvent {
        market: market_key,
        winner,
        payout_per_share: rate,
        pot: market.pot,
    });
    Ok(())
}

/// `void` (oracle only). Gemini voided the event: every share of outcome i
/// will redeem at its final pool price pᵢ = qᵢ / N (stored scaled by 1e12).
/// Because Σ pᵢqᵢ = C(q) ≤ M, the pot covers every claim. Moves: nothing.
pub fn handle_void(ctx: Context<OracleMarket>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    require!(!market.is_settled(), ErrorCode::MarketClosed);
    require!(market.all_mints_ready(), ErrorCode::MintsNotReady);

    let pool = market.pool();
    math(pool.check())?;
    // Each share of outcome i redeems at its final price p_i = q_i / N.
    // Sum of p_i * q_i = C(q) <= M, so the pot covers every claim.
    market.final_prices = math(pool.void_rates())?;
    market.status = MarketStatus::Voided;
    market.resolved_at = Clock::get()?.unix_timestamp;

    emit!(VoidEvent {
        market: market_key,
        pot: market.pot,
    });
    Ok(())
}
