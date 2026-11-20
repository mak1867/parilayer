import { type PmecProgram, ata, fetchConfig, fetchMarketById, fromHex, getProgram, outcomeMintPda, treasuryPda } from "@pmec/sdk";
/** The RFQ prototype charges a fixed 0.5% fee. The on-chain config now holds the pool sell fee instead. */
const RFQ_FEE_BPS = 50;
import { type Connection, PublicKey, type Transaction } from "@solana/web3.js";
import type { MarketInfo, RfqChain } from "./engine";

/** RfqChain over a Solana RPC connection. Read-only apart from submitting swaps the traders signed. */
export class SolanaRfqChain implements RfqChain {
  private readonly program: PmecProgram;
  private readonly markets = new Map<string, { info: MarketInfo; at: number }>();
  private ex: { usdcMint: string; treasuryVault: string; secondaryFeeBps: number; at: number } | null = null;

  constructor(private readonly connection: Connection) {
    this.program = getProgram(connection);
  }

  async market(marketId: string): Promise<MarketInfo | null> {
    if (!/^[0-9a-f]{64}$/.test(marketId)) return null;
    const cached = this.markets.get(marketId);
    // Status can change (a market resolves), so the cache is short-lived.
    if (cached && Date.now() - cached.at < 5_000) return cached.info;
    const m = await fetchMarketById(this.program, fromHex(marketId));
    if (!m) return null;
    const info: MarketInfo = {
      marketId,
      mints: Array.from({ length: m.n }, (_, i) => outcomeMintPda(m.address, i).toBase58()),
      tradable: m.status === "open" || m.status === "halted",
    };
    this.markets.set(marketId, { info, at: Date.now() });
    return info;
  }

  async exchange(): Promise<{ usdcMint: string; treasuryVault: string; secondaryFeeBps: number }> {
    if (!this.ex || Date.now() - this.ex.at > 60_000) {
      const cfg = await fetchConfig(this.program);
      if (!cfg) throw new Error("the program is not initialized on this cluster");
      this.ex = { usdcMint: cfg.usdcMint.toBase58(), treasuryVault: treasuryPda().toBase58(), secondaryFeeBps: RFQ_FEE_BPS, at: Date.now() };
    }
    return this.ex;
  }

  async balance(owner: string, mint: string): Promise<bigint> {
    const account = ata(new PublicKey(mint), new PublicKey(owner));
    const info = await this.connection.getAccountInfo(account, "confirmed");
    // A token account stores its amount as a u64 at byte 64.
    if (!info || info.data.length < 72) return 0n;
    return info.data.readBigUInt64LE(64);
  }

  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.connection.getLatestBlockhash("confirmed");
  }

  async simulate(tx: Transaction): Promise<string | null> {
    const res = await this.connection.simulateTransaction(tx);
    if (!res.value.err) return null;
    const hint = (res.value.logs ?? []).find((l) => /insufficient|Error|failed/i.test(l));
    return hint ?? JSON.stringify(res.value.err);
  }

  async submit(raw: Uint8Array): Promise<string> {
    const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
    const result = await this.connection.confirmTransaction(signature, "confirmed");
    if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
    return signature;
  }
}
