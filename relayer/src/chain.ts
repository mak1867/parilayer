import {
  type ConfigState,
  type MarketKind,
  type MarketState,
  type PmecProgram,
  UNIT,
  ata,
  createMarketIx,
  fetchAllMarkets,
  fetchConfig,
  fetchMarket,
  getProgram,
  haltIx,
  initOutcomeMintIx,
  initializeIx,
  updateConfigIx,
  marketPda,
  redeemSeedIx,
  resolveIx,
  seedSharesPda,
  treasuryPda,
  unhaltIx,
  voidIx,
} from "@pmec/sdk";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export interface NewMarket {
  marketId: Uint8Array;
  kind: MarketKind;
  refs: string[];
  probsPpm: number[];
  /** Seed in base units. */
  seedUsdc: bigint;
}

/** The on-chain actions the relayer takes. Implemented for Solana below and faked in tests. */
export interface ChainApi {
  getConfig(): Promise<ConfigState | null>;
  getMarket(marketId: Uint8Array): Promise<MarketState | null>;
  listMarkets(): Promise<MarketState[]>;
  /** USDC in the treasury vault, base units. */
  treasuryBalance(): Promise<bigint>;
  /** Creates the market and every outcome mint. Safe to call again after a partial failure. */
  createMarket(m: NewMarket): Promise<{ address: PublicKey; signatures: string[] }>;
  resolve(market: PublicKey, winner: number): Promise<string>;
  void(market: PublicKey): Promise<string>;
  halt(market: PublicKey): Promise<string>;
  unhalt(market: PublicKey): Promise<string>;
  /** Redeems the treasury's seed shares of one outcome. Returns null if there is nothing to redeem. */
  redeemSeed(market: PublicKey, outcome: number): Promise<string | null>;
  /** A wallet's USDC balance, base units. */
  usdcBalance(owner: PublicKey): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Sends a transaction someone else signed and waits for confirmation. */
  submitRaw(raw: Uint8Array): Promise<string>;
}

/** Outcome mints created per transaction; 6 keeps the transaction well under the size limit. */
const MINTS_PER_TX = 6;

export class SolanaChain implements ChainApi {
  readonly program: PmecProgram;
  private usdcMint: PublicKey | null = null;

  constructor(
    readonly connection: Connection,
    /** The oracle key: signs market creation and resolutions. */
    readonly oracle: Keypair,
    /** The admin key: only needed for setup and the mock-USDC faucet. */
    readonly admin: Keypair | null = null,
  ) {
    this.program = getProgram(connection);
  }

  private send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(this.connection, tx, signers, { commitment: "confirmed" });
  }

  getConfig(): Promise<ConfigState | null> {
    return fetchConfig(this.program);
  }

  private async usdc(): Promise<PublicKey> {
    if (!this.usdcMint) {
      const cfg = await this.getConfig();
      if (!cfg) throw new Error("program is not initialized; run `npm run cli -w relayer -- setup`");
      this.usdcMint = cfg.usdcMint;
    }
    return this.usdcMint;
  }

  getMarket(marketId: Uint8Array): Promise<MarketState | null> {
    return fetchMarket(this.program, marketPda(marketId));
  }

  listMarkets(): Promise<MarketState[]> {
    return fetchAllMarkets(this.program);
  }

  async treasuryBalance(): Promise<bigint> {
    const bal = await this.connection.getTokenAccountBalance(treasuryPda(), "confirmed");
    return BigInt(bal.value.amount);
  }

  async createMarket(m: NewMarket): Promise<{ address: PublicKey; signatures: string[] }> {
    const address = marketPda(m.marketId);
    const oracle = this.oracle.publicKey;
    const signatures: string[] = [];

    let state = await fetchMarket(this.program, address);
    if (!state) {
      const ix = await createMarketIx(this.program, { oracle, usdcMint: await this.usdc(), ...m });
      signatures.push(await this.send([ix], [this.oracle]));
      state = await fetchMarket(this.program, address);
      if (!state) throw new Error("market account missing after create_market");
    }
    // Create whichever outcome mints do not exist yet (all of them on a fresh market).
    const missing = Array.from({ length: state.n }, (_, i) => i).filter((i) => (state!.mintsReady & (1 << i)) === 0);
    for (let k = 0; k < missing.length; k += MINTS_PER_TX) {
      const ixs = await Promise.all(
        missing.slice(k, k + MINTS_PER_TX).map((i) => initOutcomeMintIx(this.program, { oracle, market: address, i })),
      );
      signatures.push(await this.send(ixs, [this.oracle]));
    }
    return { address, signatures };
  }

  async resolve(market: PublicKey, winner: number): Promise<string> {
    return this.send([await resolveIx(this.program, this.oracle.publicKey, market, winner)], [this.oracle]);
  }

  async void(market: PublicKey): Promise<string> {
    return this.send([await voidIx(this.program, this.oracle.publicKey, market)], [this.oracle]);
  }

  async halt(market: PublicKey): Promise<string> {
    return this.send([await haltIx(this.program, this.oracle.publicKey, market)], [this.oracle]);
  }

  async unhalt(market: PublicKey): Promise<string> {
    return this.send([await unhaltIx(this.program, this.oracle.publicKey, market)], [this.oracle]);
  }

  async redeemSeed(market: PublicKey, outcome: number): Promise<string | null> {
    const shares = await this.connection.getTokenAccountBalance(seedSharesPda(market, outcome), "confirmed");
    if (BigInt(shares.value.amount) === 0n) return null;
    const ix = await redeemSeedIx(this.program, { market, usdcMint: await this.usdc(), outcome });
    return this.send([ix], [this.oracle]);
  }

  async usdcBalance(owner: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(ata(await this.usdc(), owner), "confirmed");
    return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
  }

  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.connection.getLatestBlockhash("confirmed");
  }

  async submitRaw(raw: Uint8Array): Promise<string> {
    const signature = await this.connection.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
    const result = await this.connection.confirmTransaction(signature, "confirmed");
    if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
    return signature;
  }

  // ------------------------------------------------------------------ setup and faucet (admin key)

  private requireAdmin(): Keypair {
    if (!this.admin) throw new Error("this action needs the admin keypair");
    return this.admin;
  }

  /** Creates the mock USDC mint (6 decimals, minted by the admin) if it does not exist. */
  async ensureMockUsdc(mintKeypair: Keypair): Promise<{ mint: PublicKey; created: boolean }> {
    const admin = this.requireAdmin();
    const mint = mintKeypair.publicKey;
    if (await this.connection.getAccountInfo(mint, "confirmed")) return { mint, created: false };
    const lamports = await this.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    await this.send(
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, admin.publicKey, null),
      ],
      [admin, mintKeypair],
    );
    return { mint, created: true };
  }

  /** Initializes the program's Config and treasury vault if needed. */
  async ensureInitialized(usdcMint: PublicKey, poolFeeBps: number, sellFeeBps: number): Promise<boolean> {
    if (await this.getConfig()) return false;
    const admin = this.requireAdmin();
    const ix = await initializeIx(this.program, {
      admin: admin.publicKey,
      oracle: this.oracle.publicKey,
      usdcMint,
      poolFeeBps,
      sellFeeBps,
    });
    await this.send([ix], [admin]);
    return true;
  }

  /** Sets the fees if they differ from the config's. Returns true if it changed them. */
  async ensureFees(poolFeeBps: number, sellFeeBps: number): Promise<boolean> {
    const cfg = await this.getConfig();
    if (!cfg) throw new Error("program config is not initialized");
    if (cfg.poolFeeBps === poolFeeBps && cfg.sellFeeBps === sellFeeBps) return false;
    const admin = this.requireAdmin();
    const ix = await updateConfigIx(this.program, { admin: admin.publicKey, oracle: cfg.oracle, poolFeeBps, sellFeeBps });
    await this.send([ix], [admin]);
    return true;
  }

  /** Mints mock USDC straight into the treasury vault until it holds `targetUsdc`. */
  async topUpTreasury(targetUsdc: number): Promise<bigint> {
    const admin = this.requireAdmin();
    const have = await this.treasuryBalance();
    const want = BigInt(targetUsdc) * UNIT;
    if (have >= want) return 0n;
    const add = want - have;
    await this.send([createMintToInstruction(await this.usdc(), treasuryPda(), admin.publicKey, add)], [admin]);
    return add;
  }

  /**
   * The mock-USDC faucet: mints `usdc` to the wallet's token account (creating
   * it if needed). If the wallet has almost no SOL and the admin can spare
   * some, also sends a little so a fresh wallet can pay transaction fees.
   */
  async faucet(wallet: PublicKey, usdc: number): Promise<{ signature: string; sol: number }> {
    const admin = this.requireAdmin();
    const mint = await this.usdc();
    const dest = ata(mint, wallet);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, dest, wallet, mint),
      createMintToInstruction(mint, dest, admin.publicKey, BigInt(usdc) * UNIT),
    ];
    let sol = 0;
    const [walletLamports, adminLamports] = await Promise.all([
      this.connection.getBalance(wallet, "confirmed"),
      this.connection.getBalance(admin.publicKey, "confirmed"),
    ]);
    if (walletLamports < 0.01 * LAMPORTS_PER_SOL && adminLamports > 1 * LAMPORTS_PER_SOL) {
      sol = 0.05;
      ixs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wallet, lamports: sol * LAMPORTS_PER_SOL }));
    }
    return { signature: await this.send(ixs, [admin]), sol };
  }
}
