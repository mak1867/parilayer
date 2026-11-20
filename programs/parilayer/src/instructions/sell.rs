//! `sell`: a holder sells shares back to the pool.
//!
//! In plain English: the pool runs its buy formula backwards. The seller burns
//! `shares` of one outcome and gets back what those shares added to the cost
//! function, `R = C(q) - C(q')` (spec, Core mechanism, "Exits"), minus a sell
//! fee. The fee is NOT sent anywhere: it stays in the pot, so the remaining
//! holders are paid for the seller leaving.
//!
//! Why it is safe: the pot shrinks by `R - fee` while the cost function shrinks
//! by the full `R`, so invariant 1 (`M >= C(q)`) still holds and every winning
//! share still pays at least 1 USDC.
//!
//! Solidity mental model: this is like a `sell(uint8 outcome, uint256 shares,
//! uint256 minOut)` function on a bonding-curve contract. The differences on
//! Solana: every account the function touches is passed in explicitly (the
//! `Sell` struct below), and the "contract-owned" pot is a token account whose
//! owner is the Market PDA, so the program signs the payout with the PDA's seeds.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::{math, ErrorCode},
    state::*,
};

#[derive(Accounts)]
#[instruction(outcome: u8)]
pub struct Sell<'info> {
    /// The holder. Must sign, like `msg.sender` must own the tokens in Solidity.
    pub seller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = usdc_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,
    /// The outcome's share mint (like the ERC-20 contract for that outcome).
    #[account(
        mut,
        seeds = [MINT_SEED, market.key().as_ref(), &[outcome]],
        bump,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,
    /// Where the shares come from. Must belong to the signer, which also rules
    /// out the treasury: its seed shares sit in an account owned by the Config
    /// PDA, and a PDA can never be a transaction signer.
    #[account(mut, token::mint = outcome_mint, token::authority = seller)]
    pub seller_shares: Box<Account<'info, TokenAccount>>,
    /// Where the USDC goes. Any USDC account, so a seller can be paid at a fresh address.
    #[account(mut, token::mint = usdc_mint)]
    pub recipient_usdc: Box<Account<'info, TokenAccount>>,
    /// The treasury's seed shares of this outcome. Read only, to enforce the
    /// rule that no sell may push q_i below the seed.
    #[account(seeds = [SEED_SHARES_SEED, market.key().as_ref(), &[outcome]], bump)]
    pub seed_shares: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub pot_vault: Box<Account<'info, TokenAccount>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_sell(ctx: Context<Sell>, outcome: u8, shares: u64, min_usdc_out: u64) -> Result<()> {
    let market = &ctx.accounts.market;

    // Checks. Sells only while Open: never once Halted, Resolved or Voided
    // (spec, Exits). A halt mirrors Gemini stopping trading, which is exactly
    // when a late seller could otherwise front-run the result.
    require!(market.status == MarketStatus::Open, ErrorCode::MarketNotOpen);
    require!(market.all_mints_ready(), ErrorCode::MintsNotReady);
    require!(outcome < market.n_outcomes, ErrorCode::BadOutcome);
    // Belt and braces for "the treasury can never sell its seed shares": the
    // token::authority constraint above already makes this impossible.
    require_keys_neq!(
        ctx.accounts.seller_shares.owner,
        ctx.accounts.config.key(),
        ErrorCode::TreasuryCannotSell
    );

    // The math: refund R, sell fee rounded up and kept in the pot, q_i lowered,
    // pot lowered, then invariant 1 re-checked inside pool.sell. It also refuses
    // to push q_i below the seed held by the treasury.
    let seed_floor = ctx.accounts.seed_shares.amount as u128;
    let mut pool = market.pool();
    let out = math(pool.sell(
        outcome as usize,
        shares,
        ctx.accounts.config.sell_fee_bps,
        seed_floor,
    ))?;
    require!(out.usdc_out >= min_usdc_out, ErrorCode::SlippageExceeded);

    let token_program = ctx.accounts.token_program.key();

    // Move 1: burn the seller's shares (the seller signs, like an ERC-20 burn
    // from msg.sender).
    token::burn(
        CpiContext::new(
            token_program,
            Burn {
                mint: ctx.accounts.outcome_mint.to_account_info(),
                from: ctx.accounts.seller_shares.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        shares,
    )?;

    // Move 2: pay R minus the fee from the pot vault. The vault is owned by the
    // Market PDA, so the program signs with the market's seeds.
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
        out.usdc_out,
        DECIMALS,
    )?;

    // Record the new state. Sold shares lower q_i directly; they are not added
    // to `burned`, which counts only shares redeemed after settlement.
    let market_key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    market.q = pool.q;
    market.pot = pool.pot;

    // Invariant 2: the pot vault still covers the recorded pot.
    ctx.accounts.pot_vault.reload()?;
    require!(
        ctx.accounts.pot_vault.amount >= market.pot,
        ErrorCode::InvariantVaultBelowPot
    );
    // Invariant 3: mint supply + burned = q_i.
    ctx.accounts.outcome_mint.reload()?;
    require!(
        ctx.accounts.outcome_mint.supply as u128 + market.burned[outcome as usize] as u128
            == market.q[outcome as usize],
        ErrorCode::InvariantSupplyMismatch
    );

    emit!(SellEvent {
        market: market_key,
        seller: ctx.accounts.seller.key(),
        recipient: ctx.accounts.recipient_usdc.owner,
        outcome,
        shares_in: shares,
        refund: out.gross,
        fee: out.fee,
        usdc_out: out.usdc_out,
        price_after: out.price_after_e6,
        prob_after: out.prob_after_ppm,
        pot_after: market.pot,
    });
    Ok(())
}
