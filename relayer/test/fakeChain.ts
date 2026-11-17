import { type ConfigState, type MarketState, UNIT, marketPda, seedShares, toHex } from "@pmec/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { ChainApi, NewMarket } from "../src/chain";

/** In-memory stand-in for the chain: same rules for status changes, and it counts every call. */
export class FakeChain implements ChainApi {
  readonly markets = new Map<string, MarketState>();
  readonly calls: { action: string; market: string; winner?: number; outcome?: number }[] = [];
  treasury = 100_000n * UNIT;
  /** Set to make the next N resolve/void/halt/unhalt calls throw, like a dropped transaction. */
  failNext = 0;
  private sig = 0;
  private readonly usdcMint = Keypair.generate().publicKey;
  private readonly oracle = Keypair.generate().publicKey;

  private nextSig(): string {
    return `sig${++this.sig}`;
  }

  private byAddress(address: PublicKey): MarketState {
    const m = [...this.markets.values()].find((m) => m.address.equals(address));
    if (!m) throw new Error("unknown market");
    return m;
  }

  private act(action: string, address: PublicKey, extra: object = {}): MarketState {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("simulated RPC failure");
    }
    const m = this.byAddress(address);
    this.calls.push({ action, market: m.idHex, ...extra });
    return m;
  }

  count(action: string): number {
    return this.calls.filter((c) => c.action === action).length;
  }

  async getConfig(): Promise<ConfigState | null> {
    return {
      address: PublicKey.default,
      admin: PublicKey.default,
      oracle: this.oracle,
      usdcMint: this.usdcMint,
      poolFeeBps: 100,
      secondaryFeeBps: 50,
      feesCollected: 0n,
      seedsPaid: 0n,
      seedPayouts: 0n,
      dustSwept: 0n,
      marketCount: BigInt(this.markets.size),
    };
  }

  async getMarket(marketId: Uint8Array): Promise<MarketState | null> {
    return this.markets.get(toHex(marketId)) ?? null;
  }

  async listMarkets(): Promise<MarketState[]> {
    return [...this.markets.values()];
  }

  async treasuryBalance(): Promise<bigint> {
    return this.treasury;
  }

  async createMarket(m: NewMarket): Promise<{ address: PublicKey; signatures: string[] }> {
    const idHex = toHex(m.marketId);
    const address = marketPda(m.marketId);
    if (this.markets.has(idHex)) return { address, signatures: [] };
    if (this.treasury < m.seedUsdc) throw new Error("TreasuryCannotCoverSeed");
    this.treasury -= m.seedUsdc;
    const n = m.probsPpm.length;
    this.markets.set(idHex, {
      address,
      marketId: m.marketId,
      idHex,
      kind: m.kind,
      refs: m.refs,
      n,
      q: seedShares(m.probsPpm, m.seedUsdc),
      pot: m.seedUsdc,
      status: "open",
      winner: null,
      payoutPerShare: 0n,
      finalPrices: new Array<bigint>(n).fill(0n),
      createdAt: 0,
      resolvedAt: 0,
      seedUsdc: m.seedUsdc,
      burned: new Array<bigint>(n).fill(0n),
      mintsReady: n >= 32 ? 0xffffffff : (1 << n) - 1,
    });
    this.calls.push({ action: "create", market: idHex });
    return { address, signatures: [this.nextSig(), this.nextSig()] };
  }

  async resolve(market: PublicKey, winner: number): Promise<string> {
    const m = this.act("resolve", market, { winner });
    if (m.status === "resolved" || m.status === "voided") throw new Error("MarketClosed");
    m.status = "resolved";
    m.winner = winner;
    return this.nextSig();
  }

  async void(market: PublicKey): Promise<string> {
    const m = this.act("void", market);
    if (m.status === "resolved" || m.status === "voided") throw new Error("MarketClosed");
    m.status = "voided";
    return this.nextSig();
  }

  async halt(market: PublicKey): Promise<string> {
    const m = this.act("halt", market);
    if (m.status !== "open") throw new Error("MarketNotOpen");
    m.status = "halted";
    return this.nextSig();
  }

  async unhalt(market: PublicKey): Promise<string> {
    const m = this.act("unhalt", market);
    if (m.status !== "halted") throw new Error("MarketNotHalted");
    m.status = "open";
    return this.nextSig();
  }

  async redeemSeed(market: PublicKey, outcome: number): Promise<string | null> {
    const m = this.byAddress(market);
    if (m.burned[outcome]! > 0n) return null;
    m.burned[outcome] = 1n;
    this.calls.push({ action: "redeemSeed", market: m.idHex, outcome });
    return this.nextSig();
  }
}
