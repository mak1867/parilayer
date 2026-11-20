use anchor_lang::prelude::*;
use parilayer_math::MathError;

#[error_code]
pub enum ErrorCode {
    #[msg("Only the oracle (relayer) can do this")]
    NotOracle,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("Collateral mint must have 6 decimals")]
    BadCollateralDecimals,
    #[msg("Fee is above the 10% maximum")]
    BadFee,
    #[msg("Outcome count does not match the market kind (binary 2, multi 3-32, pair 4)")]
    BadOutcomeCount,
    #[msg("Gemini refs do not match the market kind (pair needs 2, others 1; each 1-64 bytes)")]
    BadRefs,
    #[msg("Seed probabilities must each be 0.5%-99.5% and sum to 100%")]
    BadProbabilities,
    #[msg("Seed is below the 1 USDC minimum")]
    SeedTooSmall,
    #[msg("The treasury cannot cover this seed")]
    TreasuryCannotCoverSeed,
    #[msg("Outcome index is out of range")]
    BadOutcome,
    #[msg("Not every outcome mint has been created yet")]
    MintsNotReady,
    #[msg("Market is not open for buying")]
    MarketNotOpen,
    #[msg("Market is already resolved or voided")]
    MarketClosed,
    #[msg("Market is not resolved or voided yet")]
    MarketNotSettled,
    #[msg("Market is not halted")]
    MarketNotHalted,
    #[msg("Amount is zero or too small to mint a share")]
    ZeroAmount,
    #[msg("Trade is worse than the slippage limit (min_shares_out or min_usdc_out)")]
    SlippageExceeded,
    #[msg("This buy would push the pot above its cap")]
    PotCapExceeded,
    #[msg("Only the winning outcome's shares can be redeemed")]
    NotWinningOutcome,
    #[msg("Dust can be swept only after all claims or 30 days")]
    SweepTooEarly,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Invariant violated: pot must cover the cost function")]
    InvariantPotBelowCost,
    #[msg("Invariant violated: pot vault balance is below the recorded pot")]
    InvariantVaultBelowPot,
    #[msg("Invariant violated: mint supply plus burned shares must equal q")]
    InvariantSupplyMismatch,
    #[msg("Invariant violated: payouts would exceed the pot")]
    InvariantPayoutAbovePot,
    #[msg("The treasury's seed shares can never be sold")]
    TreasuryCannotSell,
    #[msg("Not enough shares outstanding to sell")]
    NotEnoughShares,
    #[msg("This sell would push the outcome below its seed shares")]
    BelowSeed,
}

impl From<MathError> for ErrorCode {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => ErrorCode::Overflow,
            MathError::BadOutcome => ErrorCode::BadOutcome,
            MathError::BadOutcomeCount => ErrorCode::BadOutcomeCount,
            MathError::BadProbabilities => ErrorCode::BadProbabilities,
            MathError::ZeroAmount => ErrorCode::ZeroAmount,
            MathError::SeedTooSmall => ErrorCode::SeedTooSmall,
            MathError::PotCapExceeded => ErrorCode::PotCapExceeded,
            MathError::BadFee => ErrorCode::BadFee,
            MathError::EmptyPool => ErrorCode::ZeroAmount,
            MathError::InvariantViolated => ErrorCode::InvariantPotBelowCost,
            MathError::NotEnoughShares => ErrorCode::NotEnoughShares,
            MathError::BelowSeed => ErrorCode::BelowSeed,
        }
    }
}

/// Turns a math result into a program result.
pub fn math<T>(r: core::result::Result<T, MathError>) -> Result<T> {
    r.map_err(|e| error!(ErrorCode::from(e)))
}
