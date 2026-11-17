import { EventParser } from "@anchor-lang/core";
import { PROGRAM_ID, getProgram } from "@pmec/sdk";
import { Connection } from "@solana/web3.js";
import type { PoolTrade, Store } from "./store";

const big = (x: { toString(): string }) => x.toString();

// The program handle converts the IDL to camelCase, so events decode as
// "buyEvent" with camelCase fields. No network access happens here.
const parser = new EventParser(PROGRAM_ID, getProgram(new Connection("http://127.0.0.1:8899")).coder);

/** Turns one transaction's program logs into pool trades (buys and redemptions). */
export function tradesFromLogs(
  logs: string[],
  ctx: { signature: string; slot: number; blockTime: number | null },
): PoolTrade[] {
  const out: PoolTrade[] = [];
  let idx = 0;
  for (const ev of parser.parseLogs(logs)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = ev.data as any;
    const base = { signature: ctx.signature, idx: idx++, slot: ctx.slot, blockTime: ctx.blockTime, market: d.market?.toBase58?.() ?? "" };
    if (ev.name === "buyEvent") {
      out.push({
        ...base,
        kind: "buy",
        wallet: d.recipient.toBase58(),
        payer: d.buyer.toBase58(),
        outcome: d.outcome,
        usdc: big(d.usdcIn),
        fee: big(d.fee),
        shares: big(d.sharesOut),
        priceAfter: big(d.priceAfter),
        probAfter: d.probAfter,
        potAfter: big(d.potAfter),
      });
    } else if (ev.name === "redeemEvent") {
      out.push({
        ...base,
        kind: "redeem",
        wallet: d.holder.toBase58(),
        payer: d.holder.toBase58(),
        outcome: d.outcome,
        usdc: big(d.usdcOut),
        fee: "0",
        shares: big(d.shares),
        priceAfter: null,
        probAfter: null,
        potAfter: null,
      });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows the program's transactions and records every buy and redemption, so
 * the frontend can show a pool trade tape and each wallet's cost basis from
 * on-chain history. Everything stored here can be rebuilt from the chain.
 */
export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly connection: Connection,
    private readonly store: Store,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  /** Fetches transactions newer than the last one indexed. Returns how many trades were added. */
  async poll(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let added = 0;
    try {
      const until = this.store.get("indexer:last") ?? undefined;
      // Newest first; walk back until we reach what we already have.
      const fresh: { signature: string; slot: number; blockTime?: number | null; err: unknown }[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await this.connection.getSignaturesForAddress(PROGRAM_ID, { limit: 200, ...(until ? { until } : {}), ...(before ? { before } : {}) }, "confirmed");
        fresh.push(...page);
        if (page.length < 200) break;
        before = page[page.length - 1]!.signature;
      }
      // Oldest first, so the cursor only moves past transactions that were stored.
      for (const s of fresh.reverse()) {
        if (!s.err) {
          const tx = await this.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx) {
            // Not available yet; stop here and pick it up on the next poll.
            break;
          }
          const trades = tradesFromLogs(tx.meta?.logMessages ?? [], {
            signature: s.signature,
            slot: s.slot,
            blockTime: tx.blockTime ?? s.blockTime ?? null,
          });
          for (const t of trades) this.store.insertTrade(t);
          added += trades.length;
          await sleep(120); // stay gentle on public RPC endpoints
        }
        this.store.set("indexer:last", s.signature);
      }
    } catch (e) {
      this.log(`indexer: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return added;
  }

  start(intervalMs: number): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
