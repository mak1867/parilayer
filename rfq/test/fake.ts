import { ed25519 } from "@noble/curves/ed25519";
import { type RfqServerMsg, UNIT, ata, rfqHelloMessage, rfqQuoterMessage } from "@pmec/sdk";
import { TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { MarketInfo, Outbox, RfqChain } from "../src/engine";

export const MARKET = "ab".repeat(32);
export const sharesOf = (n: number) => BigInt(Math.round(n * 1e6));
export const usdcOf = sharesOf;
export { UNIT };

/**
 * In-memory chain. It executes the real settlement transaction the engine
 * builds: it checks both signatures and applies the token transfers
 * all-or-nothing, like the real runtime does.
 */
export class FakeChain implements RfqChain {
  readonly usdcMint = Keypair.generate().publicKey.toBase58();
  readonly treasuryVault = Keypair.generate().publicKey.toBase58();
  readonly mints = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  tradable = true;
  feeBps = 50;
  /** token account address -> balance */
  readonly accounts = new Map<string, bigint>();
  submitted = 0;

  private account(owner: string, mint: string): string {
    return ata(new PublicKey(mint), new PublicKey(owner)).toBase58();
  }

  fund(owner: string, mint: string, amount: bigint): void {
    const key = this.account(owner, mint);
    this.accounts.set(key, (this.accounts.get(key) ?? 0n) + amount);
  }

  /** Moves a wallet's whole balance away, e.g. a seller dumping shares after quoting. */
  drain(owner: string, mint: string): void {
    this.accounts.set(this.account(owner, mint), 0n);
  }

  async market(marketId: string): Promise<MarketInfo | null> {
    return marketId === MARKET ? { marketId, mints: this.mints, tradable: this.tradable } : null;
  }

  async exchange() {
    return { usdcMint: this.usdcMint, treasuryVault: this.treasuryVault, secondaryFeeBps: this.feeBps };
  }

  async balance(owner: string, mint: string): Promise<bigint> {
    return this.accounts.get(this.account(owner, mint)) ?? 0n;
  }

  get treasury(): bigint {
    return this.accounts.get(this.treasuryVault) ?? 0n;
  }

  async latestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
  }

  /** Applies the transaction's token transfers to a copy; throws if any would overdraw. */
  private run(tx: Transaction): Map<string, bigint> {
    const next = new Map(this.accounts);
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(TOKEN_PROGRAM_ID)) continue; // associated-token-account creates: nothing to move
      const d = decodeTransferCheckedInstruction(ix);
      const from = d.keys.source.pubkey.toBase58();
      const to = d.keys.destination.pubkey.toBase58();
      const have = next.get(from) ?? 0n;
      if (have < d.data.amount) throw new Error("insufficient funds");
      next.set(from, have - d.data.amount);
      next.set(to, (next.get(to) ?? 0n) + d.data.amount);
    }
    return next;
  }

  async simulate(tx: Transaction): Promise<string | null> {
    try {
      this.run(tx);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async submit(raw: Uint8Array): Promise<string> {
    const tx = Transaction.from(Buffer.from(raw));
    if (!tx.verifySignatures()) throw new Error("signature verification failed");
    const next = this.run(tx); // throws before anything is written: all or nothing
    this.accounts.clear();
    for (const [k, v] of next) this.accounts.set(k, v);
    this.submitted++;
    return `sig${this.submitted}`;
  }
}

/** Records everything the engine sends, per wallet. */
export class Recorder implements Outbox {
  readonly sent: { to: string; msg: RfqServerMsg }[] = [];
  readonly broadcasts: RfqServerMsg[] = [];

  send(to: string, msg: RfqServerMsg): void {
    this.sent.push({ to, msg });
  }

  broadcast(msg: RfqServerMsg): void {
    this.broadcasts.push(msg);
  }

  to(wallet: string): RfqServerMsg[] {
    return this.sent.filter((s) => s.to === wallet).map((s) => s.msg);
  }

  last<T extends RfqServerMsg["t"]>(wallet: string, t: T): Extract<RfqServerMsg, { t: T }> | undefined {
    return this.to(wallet)
      .filter((m): m is Extract<RfqServerMsg, { t: T }> => m.t === t)
      .at(-1);
  }
}

export class Trader {
  readonly kp = Keypair.generate();
  readonly wallet = this.kp.publicKey.toBase58();

  private sign(message: Uint8Array): string {
    return Buffer.from(ed25519.sign(message, this.kp.secretKey.slice(0, 32))).toString("base64");
  }

  hello(ts: number) {
    return { t: "hello" as const, wallet: this.wallet, ts, sig: this.sign(rfqHelloMessage(this.wallet, ts)) };
  }

  quoterSig(marketId: string, ts: number): string {
    return this.sign(rfqQuoterMessage(marketId, this.wallet, ts));
  }

  /** Signs the transaction from a sign_request, as a wallet would, and returns it base64. */
  signTx(txBase64: string): string {
    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    tx.partialSign(this.kp);
    return tx.serialize({ requireAllSignatures: false }).toString("base64");
  }
}
