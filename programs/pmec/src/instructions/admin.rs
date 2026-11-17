use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, error::ErrorCode, state::Config};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// Receives every fee and the seed shares' payouts, and pays every seed.
    #[account(
        init,
        payer = admin,
        seeds = [TREASURY_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
        token::token_program = token_program,
    )]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    oracle: Pubkey,
    pool_fee_bps: u16,
    secondary_fee_bps: u16,
) -> Result<()> {
    require!(
        ctx.accounts.usdc_mint.decimals == DECIMALS,
        ErrorCode::BadCollateralDecimals
    );
    require!(pool_fee_bps <= pmec_math::MAX_FEE_BPS, ErrorCode::BadFee);
    require!(
        secondary_fee_bps <= pmec_math::MAX_FEE_BPS,
        ErrorCode::BadFee
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle = oracle;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.pool_fee_bps = pool_fee_bps;
    config.secondary_fee_bps = secondary_fee_bps;
    config.fees_collected = 0;
    config.seeds_paid = 0;
    config.seed_payouts = 0;
    config.dust_swept = 0;
    config.market_count = 0;
    config.bump = ctx.bumps.config;
    config.treasury_bump = ctx.bumps.treasury_vault;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::NotAdmin,
    )]
    pub config: Box<Account<'info, Config>>,
}

pub fn handle_update_config(
    ctx: Context<UpdateConfig>,
    oracle: Pubkey,
    pool_fee_bps: u16,
    secondary_fee_bps: u16,
) -> Result<()> {
    require!(pool_fee_bps <= pmec_math::MAX_FEE_BPS, ErrorCode::BadFee);
    require!(
        secondary_fee_bps <= pmec_math::MAX_FEE_BPS,
        ErrorCode::BadFee
    );
    let config = &mut ctx.accounts.config;
    config.oracle = oracle;
    config.pool_fee_bps = pool_fee_bps;
    config.secondary_fee_bps = secondary_fee_bps;
    Ok(())
}
