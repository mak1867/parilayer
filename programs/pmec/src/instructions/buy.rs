use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::{math, ErrorCode},
    state::*,
};

#[derive(Accounts)]
#[instruction(outcome: u8)]
pub struct Buy<'info> {
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = usdc_mint,
    )]
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
    /// The buyer's USDC.
    #[account(mut, token::mint = usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<Account<'info, TokenAccount>>,
    /// Where the new shares go. Any token account of the outcome mint, so a buyer
    /// can send shares straight to a fresh address.
    #[account(mut, token::mint = outcome_mint)]
    pub recipient_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub pot_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = config.treasury_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_buy(ctx: Context<Buy>, outcome: u8, usdc_in: u64, min_shares_out: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(
        market.status == MarketStatus::Open,
        ErrorCode::MarketNotOpen
    );
    require!(market.all_mints_ready(), ErrorCode::MintsNotReady);
    require!(outcome < market.n_outcomes, ErrorCode::BadOutcome);

    // Fee off the top, the rest prices along the curve. All rounding is against the buyer.
    let mut pool = market.pool();
    let out = math(pool.buy(
        outcome as usize,
        usdc_in,
        ctx.accounts.config.pool_fee_bps,
    ))?;
    require!(out.shares >= min_shares_out, ErrorCode::SlippageExceeded);

    let token_program = ctx.accounts.token_program.key();

    // Fee -> treasury vault.
    if out.fee > 0 {
        token::transfer_checked(
            CpiContext::new(
                token_program,
                TransferChecked {
                    from: ctx.accounts.buyer_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            out.fee,
            DECIMALS,
        )?;
    }

    // The rest -> pot vault.
    token::transfer_checked(
        CpiContext::new(
            token_program,
            TransferChecked {
                from: ctx.accounts.buyer_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.pot_vault.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        out.net,
        DECIMALS,
    )?;

    // Mint the shares, signed by the Market PDA.
    let market_seeds: &[&[u8]] = &[MARKET_SEED, market.market_id.as_ref(), &[market.bump]];
    token::mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint: ctx.accounts.outcome_mint.to_account_info(),
                to: ctx.accounts.recipient_shares.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            &[market_seeds],
        ),
        out.shares,
    )?;

    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    market.q = pool.q;
    market.pot = pool.pot;

    let config = &mut ctx.accounts.config;
    config.fees_collected = config
        .fees_collected
        .checked_add(out.fee)
        .ok_or(ErrorCode::Overflow)?;

    // Invariants, checked against the real token accounts after the transfers.
    // 1. M >= C(q): enforced inside pool.buy (pool.check).
    // 2. Pot vault balance covers M. (>= rather than ==, so a stray donation to
    //    the vault cannot brick the market.)
    ctx.accounts.pot_vault.reload()?;
    require!(
        ctx.accounts.pot_vault.amount >= market.pot,
        ErrorCode::InvariantVaultBelowPot
    );
    // 3. Mint supply + burned = q.
    ctx.accounts.outcome_mint.reload()?;
    require!(
        ctx.accounts.outcome_mint.supply as u128 + market.burned[outcome as usize] as u128
            == market.q[outcome as usize],
        ErrorCode::InvariantSupplyMismatch
    );

    emit!(BuyEvent {
        market: market_key,
        buyer: ctx.accounts.buyer.key(),
        outcome,
        usdc_in,
        fee: out.fee,
        shares_out: out.shares,
        price_after: out.price_after_e6,
        prob_after: out.prob_after_ppm,
        pot_after: market.pot,
    });
    Ok(())
}
