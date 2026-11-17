//! Shared harness for the program's integration tests. Runs the compiled
//! program inside LiteSVM (an in-process Solana VM) with the real SPL Token program.

#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::{types::TransactionResult, LiteSVM},
    pmec::state::{Config, Market, MarketKind},
    solana_account::Account as SolAccount,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const UNIT: u64 = 1_000_000;
pub const POOL_FEE_BPS: u16 = 100;
pub const SECONDARY_FEE_BPS: u16 = 50;
pub const TREASURY_FUNDING: u64 = 1_000_000 * UNIT;
pub const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub oracle: Keypair,
    pub usdc_mint: Pubkey,
    pub config: Pubkey,
    pub treasury: Pubkey,
}

fn mint_data(authority: &Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes()); // mint authority: Some
    d[4..36].copy_from_slice(authority.as_ref());
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1; // initialized
    d
}

fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state: initialized
    d
}

impl Env {
    /// A fresh VM with the program loaded, a 6-decimal mock USDC mint, Config
    /// initialized, and the treasury funded with 1,000,000 USDC.
    pub fn new() -> Self {
        Self::with_usdc_decimals(6).expect("initialize")
    }

    pub fn with_usdc_decimals(decimals: u8) -> Result<Self, String> {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/pmec.so"));
        svm.add_program(pmec::id(), bytes).unwrap();

        let admin = Keypair::new();
        let oracle = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        svm.airdrop(&oracle.pubkey(), 100_000_000_000).unwrap();

        let usdc_mint = Pubkey::new_unique();
        let config = Pubkey::find_program_address(&[pmec::constants::CONFIG_SEED], &pmec::id()).0;
        let treasury =
            Pubkey::find_program_address(&[pmec::constants::TREASURY_SEED], &pmec::id()).0;

        let mut env = Env {
            svm,
            admin,
            oracle,
            usdc_mint,
            config,
            treasury,
        };
        let admin_key = env.admin.pubkey();
        env.put_account(usdc_mint, mint_data(&admin_key, 0, decimals));

        let ix = Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Initialize {
                oracle: env.oracle.pubkey(),
                pool_fee_bps: POOL_FEE_BPS,
                secondary_fee_bps: SECONDARY_FEE_BPS,
            }
            .data(),
            pmec::accounts::Initialize {
                admin: admin_key,
                config,
                usdc_mint,
                treasury_vault: treasury,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let admin = env.admin.insecure_clone();
        env.send(&[ix], &admin, &[]).map_err(|e| e.meta.logs.join("\n"))?;
        env.set_balance(treasury, TREASURY_FUNDING);
        // LiteSVM's clock starts at 0; move it to a realistic time (Nov 2026).
        env.warp_seconds(1_795_000_000);
        Ok(env)
    }

    fn put_account(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                SolAccount {
                    lamports,
                    data,
                    owner: TOKEN_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    /// Test-only: overwrite a token account's balance (the mock USDC faucet).
    pub fn set_balance(&mut self, token_account: Pubkey, amount: u64) {
        let mut acct = self.svm.get_account(&token_account).expect("token account");
        acct.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.svm.set_account(token_account, acct).unwrap();
    }

    /// Creates a token account for `mint` owned by `owner` holding `amount`.
    pub fn token_account(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        self.put_account(address, token_account_data(&mint, &owner, amount));
        address
    }

    /// A funded wallet plus its USDC account.
    pub fn new_user(&mut self, usdc: u64) -> (Keypair, Pubkey) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        let acct = self.token_account(self.usdc_mint, kp.pubkey(), usdc);
        (kp, acct)
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        payer: &Keypair,
        extra_signers: &[&Keypair],
    ) -> TransactionResult {
        let mut signers: Vec<&Keypair> = vec![payer];
        for s in extra_signers {
            if s.pubkey() != payer.pubkey() {
                signers.push(s);
            }
        }
        let msg =
            Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    // ---------- reads ----------

    pub fn balance(&self, token_account: Pubkey) -> u64 {
        let acct = self.svm.get_account(&token_account).expect("token account");
        u64::from_le_bytes(acct.data[64..72].try_into().unwrap())
    }

    pub fn supply(&self, mint: Pubkey) -> u64 {
        let acct = self.svm.get_account(&mint).expect("mint");
        u64::from_le_bytes(acct.data[36..44].try_into().unwrap())
    }

    pub fn market(&self, market: Pubkey) -> Market {
        let acct = self.svm.get_account(&market).expect("market");
        Market::try_deserialize(&mut &acct.data[..]).unwrap()
    }

    pub fn config_state(&self) -> Config {
        let acct = self.svm.get_account(&self.config).expect("config");
        Config::try_deserialize(&mut &acct.data[..]).unwrap()
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp_seconds(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    // ---------- addresses ----------

    pub fn market_pda(id: [u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[pmec::constants::MARKET_SEED, &id], &pmec::id()).0
    }

    pub fn vault_pda(market: Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[pmec::constants::VAULT_SEED, market.as_ref()], &pmec::id())
            .0
    }

    pub fn mint_pda(market: Pubkey, i: u8) -> Pubkey {
        Pubkey::find_program_address(
            &[pmec::constants::MINT_SEED, market.as_ref(), &[i]],
            &pmec::id(),
        )
        .0
    }

    pub fn seed_shares_pda(market: Pubkey, i: u8) -> Pubkey {
        Pubkey::find_program_address(
            &[pmec::constants::SEED_SHARES_SEED, market.as_ref(), &[i]],
            &pmec::id(),
        )
        .0
    }

    // ---------- instruction builders ----------

    pub fn create_market_ix(
        &self,
        oracle: Pubkey,
        id: [u8; 32],
        kind: MarketKind,
        refs: Vec<String>,
        n: u8,
        probs: Vec<u32>,
        seed: u64,
    ) -> Instruction {
        let market = Self::market_pda(id);
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::CreateMarket {
                market_id: id,
                kind,
                refs,
                n,
                seed_probs_ppm: probs,
                seed_usdc: seed,
            }
            .data(),
            pmec::accounts::CreateMarket {
                oracle,
                config: self.config,
                market,
                pot_vault: Self::vault_pda(market),
                treasury_vault: self.treasury,
                usdc_mint: self.usdc_mint,
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn init_mint_ix(&self, oracle: Pubkey, market: Pubkey, i: u8) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::InitOutcomeMint { i }.data(),
            pmec::accounts::InitOutcomeMint {
                oracle,
                config: self.config,
                market,
                outcome_mint: Self::mint_pda(market, i),
                seed_shares: Self::seed_shares_pda(market, i),
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn buy_ix(
        &self,
        buyer: Pubkey,
        buyer_usdc: Pubkey,
        recipient_shares: Pubkey,
        market: Pubkey,
        outcome: u8,
        usdc_in: u64,
        min_shares_out: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Buy {
                outcome,
                usdc_in,
                min_shares_out,
            }
            .data(),
            pmec::accounts::Buy {
                buyer,
                config: self.config,
                market,
                outcome_mint: Self::mint_pda(market, outcome),
                buyer_usdc,
                recipient_shares,
                pot_vault: Self::vault_pda(market),
                treasury_vault: self.treasury,
                usdc_mint: self.usdc_mint,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    fn oracle_market_accounts(&self, oracle: Pubkey, market: Pubkey) -> Vec<anchor_lang::prelude::AccountMeta> {
        pmec::accounts::OracleMarket {
            oracle,
            config: self.config,
            market,
        }
        .to_account_metas(None)
    }

    pub fn halt_ix(&self, oracle: Pubkey, market: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Halt {}.data(),
            self.oracle_market_accounts(oracle, market),
        )
    }

    pub fn unhalt_ix(&self, oracle: Pubkey, market: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Unhalt {}.data(),
            self.oracle_market_accounts(oracle, market),
        )
    }

    pub fn resolve_ix(&self, oracle: Pubkey, market: Pubkey, winner: u8) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Resolve { winner }.data(),
            self.oracle_market_accounts(oracle, market),
        )
    }

    pub fn void_ix(&self, oracle: Pubkey, market: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Void {}.data(),
            self.oracle_market_accounts(oracle, market),
        )
    }

    pub fn redeem_ix(
        &self,
        holder: Pubkey,
        holder_shares: Pubkey,
        recipient_usdc: Pubkey,
        market: Pubkey,
        outcome: u8,
        amount: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::Redeem { outcome, amount }.data(),
            pmec::accounts::Redeem {
                holder,
                market,
                outcome_mint: Self::mint_pda(market, outcome),
                holder_shares,
                recipient_usdc,
                pot_vault: Self::vault_pda(market),
                usdc_mint: self.usdc_mint,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn redeem_seed_ix(&self, market: Pubkey, outcome: u8) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::RedeemSeed { outcome }.data(),
            pmec::accounts::RedeemSeed {
                config: self.config,
                market,
                outcome_mint: Self::mint_pda(market, outcome),
                seed_shares: Self::seed_shares_pda(market, outcome),
                pot_vault: Self::vault_pda(market),
                treasury_vault: self.treasury,
                usdc_mint: self.usdc_mint,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    pub fn sweep_ix(&self, admin: Pubkey, market: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            pmec::id(),
            &pmec::instruction::SweepDust {}.data(),
            pmec::accounts::SweepDust {
                admin,
                config: self.config,
                market,
                pot_vault: Self::vault_pda(market),
                treasury_vault: self.treasury,
                usdc_mint: self.usdc_mint,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        )
    }

    // ---------- common flows ----------

    /// Oracle creates a market and all of its outcome mints (in batches of 6).
    pub fn create_full_market(
        &mut self,
        id: [u8; 32],
        kind: MarketKind,
        probs: &[u32],
        seed: u64,
    ) -> Pubkey {
        let oracle = self.oracle.insecure_clone();
        let refs = match kind {
            MarketKind::Pair => vec!["GEMI-LEG-A".to_string(), "GEMI-LEG-B".to_string()],
            _ => vec!["GEMI-TEST".to_string()],
        };
        let ix = self.create_market_ix(
            oracle.pubkey(),
            id,
            kind,
            refs,
            probs.len() as u8,
            probs.to_vec(),
            seed,
        );
        ok(self.send(&[ix], &oracle, &[]));
        let market = Self::market_pda(id);
        let n = probs.len() as u8;
        for chunk in (0..n).collect::<Vec<_>>().chunks(6) {
            let ixs: Vec<Instruction> = chunk
                .iter()
                .map(|&i| self.init_mint_ix(oracle.pubkey(), market, i))
                .collect();
            ok(self.send(&ixs, &oracle, &[]));
        }
        market
    }

    /// Buys and returns the shares received. Creates a share account for the buyer.
    pub fn buy(
        &mut self,
        buyer: &Keypair,
        buyer_usdc: Pubkey,
        market: Pubkey,
        outcome: u8,
        usdc_in: u64,
    ) -> (Pubkey, u64) {
        let shares_acct = self.token_account(Self::mint_pda(market, outcome), buyer.pubkey(), 0);
        let ix = self.buy_ix(
            buyer.pubkey(),
            buyer_usdc,
            shares_acct,
            market,
            outcome,
            usdc_in,
            0,
        );
        ok(self.send(&[ix], buyer, &[]));
        (shares_acct, self.balance(shares_acct))
    }

    /// Checks invariants 1-3 from the spec against the real token accounts, plus
    /// the treasury identity (invariant 2, second half).
    pub fn assert_invariants(&self, market: Pubkey) {
        let m = self.market(market);
        let n = m.n_outcomes as usize;
        // 1. M >= C(q) >= q_i
        let s2: u128 = m.q[..n].iter().map(|q| q * q).sum();
        // (After settlement the pot pays out and shrinks, so this applies while trading.)
        assert!((m.pot as u128) * (m.pot as u128) >= s2 || m.is_settled(), "pot below cost");
        for i in 0..n {
            assert!(m.q[i] * m.q[i] <= s2);
        }
        // 2. pot vault balance = M
        assert_eq!(self.balance(Self::vault_pda(market)), m.pot, "vault != pot");
        // 3. supply + burned = q
        for i in 0..n {
            if m.mints_ready & (1 << i) != 0 {
                let supply = self.supply(Self::mint_pda(market, i as u8)) as u128;
                assert_eq!(supply + m.burned[i] as u128, m.q[i], "supply mismatch on {i}");
            }
        }
        // 2b. treasury = funding + fees + seed payouts + dust - seeds paid
        let c = self.config_state();
        assert_eq!(
            self.balance(self.treasury),
            TREASURY_FUNDING + c.fees_collected + c.seed_payouts + c.dust_swept - c.seeds_paid,
            "treasury identity"
        );
    }
}

/// Unwraps a successful transaction, printing the program logs on failure.
pub fn ok(res: TransactionResult) -> litesvm::types::TransactionMetadata {
    match res {
        Ok(meta) => meta,
        Err(e) => panic!("transaction failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
    }
}

/// Asserts the transaction failed with the named program error.
pub fn fails_with(res: TransactionResult, error_name: &str) {
    match res {
        Ok(_) => panic!("expected {error_name}, but the transaction succeeded"),
        Err(e) => {
            let logs = e.meta.logs.join("\n");
            assert!(
                logs.contains(&format!("Error Code: {error_name}.")),
                "expected {error_name}, got {:?}\n{logs}",
                e.err
            );
        }
    }
}

pub fn id(byte: u8) -> [u8; 32] {
    [byte; 32]
}
