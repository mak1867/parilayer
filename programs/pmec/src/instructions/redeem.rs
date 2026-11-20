use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::{math, ErrorCode},
    state::*,
};

/// USDC owed for `amount` shares of `outcome` in a settled market.
fn redemption_value(market: &Market, outcome: u8, amount: u64) -> Result<u64> {
    require!(outcome < market.n_outcomes, ErrorCode::BadOutcome);
    match market.status {
        MarketStatus::Resolved => {
            require!(outcome == market.winner, ErrorCode::NotWinningOutcome);
            math(pmec_math::redeem_value(amount, market.payout_per_share))
        }
        MarketStatus::Voided => math(pmec_math::redeem_value(
            amount,
            market.final_prices[outcome as usize] as u128,
        )),
        _ => err!(ErrorCode::MarketNotSettled),
    }
}

/// Bookkeeping shared by redeem and redeem_seed, after the burn and the payout.
fn record_redemption(market: &mut Market, outcome: u8, amount: u64, pay: u64) -> Result<()> {
    market.pot = market
        .pot
        .checked_sub(pay)
        .ok_or(ErrorCode::InvariantPayoutAbovePot)?;
    let burned = &mut market.burned[outcome as usize];
    *burned = burned.checked_add(amount).ok_or(ErrorCode::Overflow)?;
    Ok(())
}

// ---------------------------------------------------------------- redeem

#[derive(Accounts)]
#[instruction(outcome: u8)]
pub struct Redeem<'info> {
    pub holder: Signer<'info>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        seeds = [MINT_SEED, market.key().as_ref(), &[outcome]],
        bump,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = outcome_mint, token::authority = holder)]
    pub holder_shares: Box<Account<'info, TokenAccount>>,
    /// Where the USDC goes. Any USDC token account.
    #[account(mut, token::mint = usdc_mint)]
    pub recipient_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub pot_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = pot_vault.mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// `redeem` (any holder). After resolution or void, burns shares and pays USDC
/// from the pot vault: amount × payout_per_share / 1e12 for winning shares, or
/// the void price. Checks: the market is settled, the amount is not zero, and
/// (when resolved) the outcome is the winner; losing shares pay nothing and
/// cannot be redeemed. Rounds down. Invariants 2 and 3 are re-checked.
pub fn handle_redeem(ctx: Context<Redeem>, outcome: u8, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    let market = &ctx.accounts.market;
    let pay = redemption_value(market, outcome, amount)?;
    let token_program = ctx.accounts.token_program.key();

    token::burn(
        CpiContext::new(
            token_program,
            Burn {
                mint: ctx.accounts.outcome_mint.to_account_info(),
                from: ctx.accounts.holder_shares.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        amount,
    )?;

    if pay > 0 {
        let market_seeds: &[&[u8]] = &[MARKET_SEED, market.market_id.as_ref(), &[market.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: ctx.accounts.pot_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.recipient_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[market_seeds],
            ),
            pay,
            DECIMALS,
        )?;
    }

    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    record_redemption(market, outcome, amount, pay)?;

    ctx.accounts.pot_vault.reload()?;
    require!(
        ctx.accounts.pot_vault.amount >= market.pot,
        ErrorCode::InvariantVaultBelowPot
    );
    ctx.accounts.outcome_mint.reload()?;
    require!(
        ctx.accounts.outcome_mint.supply as u128 + market.burned[outcome as usize] as u128
            == market.q[outcome as usize],
        ErrorCode::InvariantSupplyMismatch
    );

    emit!(RedeemEvent {
        market: market_key,
        holder: ctx.accounts.holder.key(),
        outcome,
        shares: amount,
        usdc_out: pay,
    });
    Ok(())
}

// ---------------------------------------------------------------- redeem_seed

/// The treasury's seed shares are owned by the Config PDA, which cannot sign a
/// normal redeem, so this permissionless instruction redeems them into the
/// treasury vault. Same payout rule as any other holder.
#[derive(Accounts)]
#[instruction(outcome: u8)]
pub struct RedeemSeed<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        seeds = [MINT_SEED, market.key().as_ref(), &[outcome]],
        bump,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [SEED_SHARES_SEED, market.key().as_ref(), &[outcome]],
        bump,
    )]
    pub seed_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub pot_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// `redeem_seed` (anyone). Same payout rule as `redeem`, for the treasury's
/// seed shares of one outcome: burns them and pays the treasury vault, so seed
/// money comes home to fund future markets. A PDA cannot sign a normal redeem,
/// which is why this separate, permissionless instruction exists.
pub fn handle_redeem_seed(ctx: Context<RedeemSeed>, outcome: u8) -> Result<()> {
    let amount = ctx.accounts.seed_shares.amount;
    require!(amount > 0, ErrorCode::ZeroAmount);
    let market = &ctx.accounts.market;
    let pay = redemption_value(market, outcome, amount)?;
    let token_program = ctx.accounts.token_program.key();

    let config_seeds: &[&[u8]] = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
    token::burn(
        CpiContext::new_with_signer(
            token_program,
            Burn {
                mint: ctx.accounts.outcome_mint.to_account_info(),
                from: ctx.accounts.seed_shares.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[config_seeds],
        ),
        amount,
    )?;

    if pay > 0 {
        let market_seeds: &[&[u8]] = &[MARKET_SEED, market.market_id.as_ref(), &[market.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: ctx.accounts.pot_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[market_seeds],
            ),
            pay,
            DECIMALS,
        )?;
    }

    let market_key = ctx.accounts.market.key();
    let config_key = ctx.accounts.config.key();
    let market = &mut ctx.accounts.market;
    record_redemption(market, outcome, amount, pay)?;

    let config = &mut ctx.accounts.config;
    config.seed_payouts = config
        .seed_payouts
        .checked_add(pay)
        .ok_or(ErrorCode::Overflow)?;

    ctx.accounts.pot_vault.reload()?;
    require!(
        ctx.accounts.pot_vault.amount >= market.pot,
        ErrorCode::InvariantVaultBelowPot
    );

    emit!(RedeemEvent {
        market: market_key,
        holder: config_key,
        outcome,
        shares: amount,
        usdc_out: pay,
    });
    Ok(())
}

// ---------------------------------------------------------------- sweep_dust

#[derive(Accounts)]
pub struct SweepDust<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::NotAdmin,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub pot_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// `sweep_dust` (admin only). Moves whatever is left in a settled market's pot
/// (rounding dust, sell fees left behind, unclaimed winnings) to the treasury.
/// Checks: every claim has been paid (all winning shares, or on void all
/// shares, are burned) or 30 days have passed since settlement.
pub fn handle_sweep_dust(ctx: Context<SweepDust>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.is_settled(), ErrorCode::MarketNotSettled);

    // Allowed once every claim is paid, or 30 days after settlement.
    let n = market.n_outcomes as usize;
    let all_claimed = match market.status {
        MarketStatus::Resolved => {
            let w = market.winner as usize;
            market.burned[w] as u128 == market.q[w]
        }
        _ => (0..n).all(|i| market.burned[i] as u128 == market.q[i]),
    };
    let now = Clock::get()?.unix_timestamp;
    let waited = now >= market.resolved_at.saturating_add(SWEEP_DELAY_SECS);
    require!(all_claimed || waited, ErrorCode::SweepTooEarly);

    let amount = ctx.accounts.pot_vault.amount;
    if amount > 0 {
        let market_seeds: &[&[u8]] = &[MARKET_SEED, market.market_id.as_ref(), &[market.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pot_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                &[market_seeds],
            ),
            amount,
            DECIMALS,
        )?;
    }

    let market = &mut ctx.accounts.market;
    market.pot = 0;
    let config = &mut ctx.accounts.config;
    config.dust_swept = config
        .dust_swept
        .checked_add(amount)
        .ok_or(ErrorCode::Overflow)?;
    Ok(())
}
