use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const TREASURY_SEED: &[u8] = b"fees";
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const MINT_SEED: &[u8] = b"mint";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const SEED_SHARES_SEED: &[u8] = b"seed_shares";

/// Outcome shares and USDC both use 6 decimals.
#[constant]
pub const DECIMALS: u8 = 6;
/// Longest Gemini ticker stored on a market.
#[constant]
pub const MAX_REF_LEN: u32 = 64;
/// Unclaimed pot funds can be swept to the treasury this long after resolution.
#[constant]
pub const SWEEP_DELAY_SECS: i64 = 30 * 24 * 60 * 60;
/// `Market.winner` before resolution.
#[constant]
pub const NO_WINNER: u8 = 255;
