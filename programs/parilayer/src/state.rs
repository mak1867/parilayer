use anchor_lang::prelude::*;
use parilayer_math::{Pool, MAX_OUTCOMES};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketKind {
    /// 2 outcomes mirrored from one Gemini contract: index 0 = NO, 1 = YES.
    Binary,
    /// 3 to 32 mutually exclusive outcomes mirrored from one Gemini event.
    Multi,
    /// 4 joint outcomes of two Gemini contracts: index = 2*a + b (a, b = 1 for YES).
    Pair,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Open,
    Halted,
    Resolved,
    Voided,
}

/// Global settings and the treasury's running totals. PDA: ["config"].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// The relayer key. Trusted: it creates markets and posts Gemini's resolutions.
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub pool_fee_bps: u16,
    /// Fee on selling back to the pool. It stays in the pot for the remaining
    /// holders. (This field was `secondary_fee_bps` before sell-back existed;
    /// renamed in place so the account layout is unchanged.)
    pub sell_fee_bps: u16,
    /// Pool fees received by the treasury vault.
    pub fees_collected: u64,
    /// Seeds the treasury vault has paid into pots.
    pub seeds_paid: u64,
    /// Payouts the treasury has received for its seed shares.
    pub seed_payouts: u64,
    /// Leftover pot dust swept to the treasury.
    pub dust_swept: u64,
    pub market_count: u64,
    pub bump: u8,
    pub treasury_bump: u8,
}

/// One market = one pot. PDA: ["market", market_id].
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// Deterministic id: sha256 of the sorted Gemini refs (computed by the relayer).
    pub market_id: [u8; 32],
    pub kind: MarketKind,
    /// Gemini tickers this market mirrors (1, or 2 for a pair pool).
    #[max_len(2, 64)]
    pub gemini_refs: Vec<String>,
    pub n_outcomes: u8,
    /// Shares outstanding per outcome, seed included. Never decreases.
    pub q: [u128; 32],
    /// USDC the pot owes to holders (fees excluded). Goes down only on redeem and sweep.
    pub pot: u64,
    pub status: MarketStatus,
    /// Winning outcome index, or 255 before resolution.
    pub winner: u8,
    /// USDC per winning share, scaled 1e12. Set by resolve.
    pub payout_per_share: u128,
    /// Void price per share for each outcome, scaled 1e12. Set by void.
    pub final_prices: [u64; 32],
    pub created_at: i64,
    /// When the market was resolved or voided (0 before).
    pub resolved_at: i64,
    pub seed_usdc: u64,
    /// Shares burned by redemptions, per outcome. mint supply + burned = q.
    pub burned: [u64; 32],
    /// Bit i is set once outcome i's mint exists.
    pub mints_ready: u32,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Market {
    pub fn pool(&self) -> Pool {
        Pool {
            n: self.n_outcomes as usize,
            q: self.q,
            pot: self.pot,
        }
    }

    pub fn all_mints_ready(&self) -> bool {
        let n = self.n_outcomes as u32;
        let want = if n as usize >= MAX_OUTCOMES {
            u32::MAX
        } else {
            (1u32 << n) - 1
        };
        self.mints_ready == want
    }

    pub fn is_settled(&self) -> bool {
        matches!(self.status, MarketStatus::Resolved | MarketStatus::Voided)
    }
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub market_id: [u8; 32],
    pub kind: MarketKind,
    pub n_outcomes: u8,
    pub seed_usdc: u64,
}

#[event]
pub struct BuyEvent {
    pub market: Pubkey,
    /// Wallet that paid.
    pub buyer: Pubkey,
    /// Wallet that owns the token account the shares went to (usually the buyer).
    pub recipient: Pubkey,
    pub outcome: u8,
    /// Gross USDC paid, fee included.
    pub usdc_in: u64,
    pub fee: u64,
    pub shares_out: u64,
    /// Pool price of the outcome after the buy (1e6 = 1 USDC).
    pub price_after: u64,
    /// Implied probability after the buy, in ppm.
    pub prob_after: u32,
    pub pot_after: u64,
}

#[event]
pub struct SellEvent {
    pub market: Pubkey,
    pub seller: Pubkey,
    /// Owner of the USDC account that received the payment.
    pub recipient: Pubkey,
    pub outcome: u8,
    /// Shares burned.
    pub shares_in: u64,
    /// Refund before the sell fee: C(q) - C(q').
    pub refund: u64,
    /// Sell fee, kept in the pot.
    pub fee: u64,
    /// USDC paid to the seller (refund minus fee).
    pub usdc_out: u64,
    pub price_after: u64,
    pub prob_after: u32,
    pub pot_after: u64,
}

#[event]
pub struct HaltEvent {
    pub market: Pubkey,
    pub halted: bool,
}

#[event]
pub struct ResolveEvent {
    pub market: Pubkey,
    pub winner: u8,
    /// USDC per winning share, scaled 1e12.
    pub payout_per_share: u128,
    pub pot: u64,
}

#[event]
pub struct VoidEvent {
    pub market: Pubkey,
    pub pot: u64,
}

#[event]
pub struct RedeemEvent {
    pub market: Pubkey,
    pub holder: Pubkey,
    pub outcome: u8,
    pub shares: u64,
    pub usdc_out: u64,
}
