import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RfqFill } from "@parilayer/sdk";

export interface RfqRow {
  id: string;
  marketId: string;
  outcome: number;
  size: string;
  requester: string;
  createdAt: number;
  /** quoting | deciding | signing | filled | expired | walked | failed | no_quoters */
  status: string;
  /** True once at least one quote arrived: only those RFQs count toward the fill rate. */
  hadQuotes: boolean;
}

export interface FillRow extends RfqFill {
  rfqId: string;
  buyer: string;
  seller: string;
  value: string;
  fee: string;
}

/**
 * The operator's full log: every RFQ, every quote, every fill and every
 * signing failure. Only fills are public (the tape); the rest stays here.
 */
export class RfqStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rfqs (
        id TEXT PRIMARY KEY, market_id TEXT NOT NULL, outcome INTEGER NOT NULL, size TEXT NOT NULL,
        requester TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, had_quotes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS rfqs_requester ON rfqs (requester);
      CREATE TABLE IF NOT EXISTS quotes (
        rfq_id TEXT NOT NULL, quoter TEXT NOT NULL, bid TEXT, ask TEXT, ts INTEGER NOT NULL,
        PRIMARY KEY (rfq_id, quoter)
      );
      CREATE TABLE IF NOT EXISTS fills (
        rfq_id TEXT PRIMARY KEY, market_id TEXT NOT NULL, outcome INTEGER NOT NULL, price TEXT NOT NULL, size TEXT NOT NULL,
        value TEXT NOT NULL, fee TEXT NOT NULL, ts INTEGER NOT NULL, signature TEXT NOT NULL, buyer TEXT NOT NULL, seller TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fills_market ON fills (market_id, ts);
      CREATE TABLE IF NOT EXISTS failures (wallet TEXT NOT NULL, ts INTEGER NOT NULL, rfq_id TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS failures_wallet ON failures (wallet, ts);
    `);
  }

  insertRfq(r: RfqRow): void {
    this.db
      .prepare("INSERT INTO rfqs (id, market_id, outcome, size, requester, created_at, status, had_quotes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, r.marketId, r.outcome, r.size, r.requester, r.createdAt, r.status, r.hadQuotes ? 1 : 0);
  }

  setRfqStatus(id: string, status: string, hadQuotes?: boolean): void {
    if (hadQuotes === undefined) this.db.prepare("UPDATE rfqs SET status = ? WHERE id = ?").run(status, id);
    else this.db.prepare("UPDATE rfqs SET status = ?, had_quotes = ? WHERE id = ?").run(status, hadQuotes ? 1 : 0, id);
  }

  upsertQuote(rfqId: string, quoter: string, bid: string | null, ask: string | null, ts: number): void {
    this.db
      .prepare("INSERT INTO quotes (rfq_id, quoter, bid, ask, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(rfq_id, quoter) DO UPDATE SET bid = excluded.bid, ask = excluded.ask, ts = excluded.ts")
      .run(rfqId, quoter, bid, ask, ts);
  }

  insertFill(f: FillRow): void {
    this.db
      .prepare("INSERT INTO fills (rfq_id, market_id, outcome, price, size, value, fee, ts, signature, buyer, seller) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(f.rfqId, f.marketId, f.outcome, f.priceE6, f.size, f.value, f.fee, f.ts, f.signature, f.buyer, f.seller);
  }

  /** The public tape: newest first. No wallets. */
  tape(marketId?: string, limit = 50): RfqFill[] {
    const rows = (
      marketId
        ? this.db.prepare("SELECT * FROM fills WHERE market_id = ? ORDER BY ts DESC LIMIT ?").all(marketId, limit)
        : this.db.prepare("SELECT * FROM fills ORDER BY ts DESC LIMIT ?").all(limit)
    ) as Record<string, string | number>[];
    return rows.map((r) => ({
      marketId: String(r.market_id),
      outcome: Number(r.outcome),
      priceE6: String(r.price),
      size: String(r.size),
      ts: Number(r.ts),
      signature: String(r.signature),
    }));
  }

  /** Last traded price per outcome of a market. */
  lastPrices(marketId: string): Record<number, { priceE6: string; ts: number }> {
    const out: Record<number, { priceE6: string; ts: number }> = {};
    for (const f of this.tape(marketId, 500).reverse()) out[f.outcome] = { priceE6: f.priceE6, ts: f.ts };
    return out;
  }

  /** A wallet's own secondary trades (for its cost basis). */
  fillsOf(wallet: string): (RfqFill & { side: "buy" | "sell"; value: string; fee: string })[] {
    const rows = this.db.prepare("SELECT * FROM fills WHERE buyer = ? OR seller = ? ORDER BY ts").all(wallet, wallet) as Record<string, string | number>[];
    return rows.map((r) => ({
      marketId: String(r.market_id),
      outcome: Number(r.outcome),
      priceE6: String(r.price),
      size: String(r.size),
      ts: Number(r.ts),
      signature: String(r.signature),
      side: r.buyer === wallet ? ("buy" as const) : ("sell" as const),
      value: String(r.value),
      fee: String(r.fee),
    }));
  }

  recordFailure(wallet: string, ts: number, rfqId: string, reason: string): void {
    this.db.prepare("INSERT INTO failures (wallet, ts, rfq_id, reason) VALUES (?, ?, ?, ?)").run(wallet, ts, rfqId, reason);
  }

  failureTimes(wallet: string, since: number): number[] {
    const rows = this.db.prepare("SELECT ts FROM failures WHERE wallet = ? AND ts >= ? ORDER BY ts").all(wallet, since) as { ts: number }[];
    return rows.map((r) => Number(r.ts));
  }

  /** Share of a requester's quoted RFQs that ended in a fill. 1 for a wallet with no history. */
  fillRate(wallet: string): number {
    const row = this.db
      .prepare(
        "SELECT SUM(CASE WHEN status = 'filled' THEN 1 ELSE 0 END) AS filled, COUNT(*) AS total FROM rfqs WHERE requester = ? AND had_quotes = 1 AND status IN ('filled', 'expired', 'walked', 'failed')",
      )
      .get(wallet) as { filled: number | null; total: number };
    const total = Number(row.total);
    return total === 0 ? 1 : Number(row.filled ?? 0) / total;
  }

  close(): void {
    this.db.close();
  }
}
