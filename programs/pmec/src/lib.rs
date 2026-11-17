//! PMEC Exchange: dynamic parimutuel prediction markets on Solana.
//!
//! Every market is one pot priced by the cost function C(q) = ||q||_2 (1 USDC
//! per unit). The pool only sells shares; holders exit on the secondary market.
//! The pool price of a share is at most 1 USDC and a winning share pays at least
//! 1 USDC. All arithmetic lives in the `pmec-math` crate.

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("13ZEq3jQvpn1r9KyaS9NK9HGoqZrHf6BJtwMyEbXbPtJ");

#[program]
pub mod pmec {
    use super::*;

    /// Creates Config and the treasury vault.
    pub fn initialize(
        ctx: Context<Initialize>,
        oracle: Pubkey,
        pool_fee_bps: u16,
        secondary_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::handle_initialize(ctx, oracle, pool_fee_bps, secondary_fee_bps)
    }

    /// Admin: change the oracle or the fees.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        oracle: Pubkey,
        pool_fee_bps: u16,
        secondary_fee_bps: u16,
    ) -> Result<()> {
        instructions::admin::handle_update_config(ctx, oracle, pool_fee_bps, secondary_fee_bps)
    }

    /// Oracle: creates a market and its pot, seeded from the treasury.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: [u8; 32],
        kind: MarketKind,
        refs: Vec<String>,
        n: u8,
        seed_probs_ppm: Vec<u32>,
        seed_usdc: u64,
    ) -> Result<()> {
        instructions::market::handle_create_market(
            ctx,
            market_id,
            kind,
            refs,
            n,
            seed_probs_ppm,
            seed_usdc,
        )
    }

    /// Oracle: creates outcome i's mint and mints its seed shares to the treasury.
    pub fn init_outcome_mint(ctx: Context<InitOutcomeMint>, i: u8) -> Result<()> {
        instructions::market::handle_init_outcome_mint(ctx, i)
    }

    /// Buys shares of one outcome from the pool.
    pub fn buy(ctx: Context<Buy>, outcome: u8, usdc_in: u64, min_shares_out: u64) -> Result<()> {
        instructions::buy::handle_buy(ctx, outcome, usdc_in, min_shares_out)
    }

    /// Oracle: mirrors a Gemini trading halt.
    pub fn halt(ctx: Context<OracleMarket>) -> Result<()> {
        instructions::market::handle_set_halted(ctx, true)
    }

    /// Oracle: lifts a halt.
    pub fn unhalt(ctx: Context<OracleMarket>) -> Result<()> {
        instructions::market::handle_set_halted(ctx, false)
    }

    /// Oracle: settles the market on Gemini's resolution.
    pub fn resolve(ctx: Context<OracleMarket>, winner: u8) -> Result<()> {
        instructions::market::handle_resolve(ctx, winner)
    }

    /// Oracle: voids the market; every share redeems at its final pool price.
    pub fn void(ctx: Context<OracleMarket>) -> Result<()> {
        instructions::market::handle_void(ctx)
    }

    /// Burns shares for USDC after resolution or void.
    pub fn redeem(ctx: Context<Redeem>, outcome: u8, amount: u64) -> Result<()> {
        instructions::redeem::handle_redeem(ctx, outcome, amount)
    }

    /// Anyone: redeems the treasury's seed shares of one outcome into the treasury vault.
    pub fn redeem_seed(ctx: Context<RedeemSeed>, outcome: u8) -> Result<()> {
        instructions::redeem::handle_redeem_seed(ctx, outcome)
    }

    /// Admin: after all claims or 30 days, moves what is left in the pot to the treasury.
    pub fn sweep_dust(ctx: Context<SweepDust>) -> Result<()> {
        instructions::redeem::handle_sweep_dust(ctx)
    }
}
