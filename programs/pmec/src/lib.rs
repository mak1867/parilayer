//! PMEC Exchange program. M0 skeleton: one no-op instruction so the toolchain,
//! the build and the test harness are proven before the pool logic lands.

use anchor_lang::prelude::*;

declare_id!("13ZEq3jQvpn1r9KyaS9NK9HGoqZrHf6BJtwMyEbXbPtJ");

#[program]
pub mod pmec {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("pmec: unit = {}", pmec_math::UNIT);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping<'info> {
    pub payer: Signer<'info>,
}
