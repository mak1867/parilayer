import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MarketKind } from "@parilayer/sdk";
import type { MarketSource } from "./mapping";

/** What the relayer remembers about a market it created: names and where it came from. */
export interface MarketMeta {
  /** Hex of the on-chain market id. */
  idHex: string;
  /** The Market account address (base58). */
  address: string;
  kind: MarketKind;
  refs: string[];
  title: string;
  category: string;
  /** Outcome labels in on-chain index order. */
  outcomes: string[];
  source: MarketSource;
  seedProbsPpm: number[];
  /** Gemini's normalized probabilities at the moment of seeding. */
  geminiProbsAtSeed: number[];
  /** Seed in base units, as a string. */
  seedUsdc: string;
  createdAt: number;
  expiryDate: string | null;
  /** Wallet whose first buy created a pair pool. */
  creator?: string;
}

/** One buy from the pool or one redemption, read from the program's on-chain events. */
export interface PoolTrade {
  signature: string;
  /** Position of the event inside its transaction. */
  idx: number;
  slot: number;
  blockTime: number | null;
  /** Market account address (base58). */
  market: string;
  kind: "buy" | "sell" | "redeem";
  /** Wallet that received the shares (buy), sold them, or redeemed them. */
  wallet: string;
  /** Wallet that paid for a buy, or received the USDC of a sell. */
  payer: string;
  outcome: number;
  /** USDC paid (buy, fee included) or received (sell after its fee, redeem), base units as a string. */
  usdc: string;
  fee: string;
  shares: string;
  priceAfter: string | null;
  probAfter: number | null;
  potAfter: string | null;
}

/** What a wallet has done in one outcome of one market, from on-chain history. */
export interface PositionHistory {
  market: string;
  outcome: number;
  /** Shares bought from the pool and what they cost (fee included). */
  boughtShares: string;
  boughtUsdc: string;
  soldShares: string;
  soldUsdc: string;
  redeemedShares: string;
  redeemedUsdc: string;
}

/** Small SQLite store. Pass ":memory:" in tests. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (id_hex TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pair_creations (id_hex TEXT PRIMARY KEY, creator TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS faucet (wallet TEXT PRIMARY KEY, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pool_trades (
        signature TEXT NOT NULL, idx INTEGER NOT NULL, slot INTEGER NOT NULL, block_time INTEGER,
        market TEXT NOT NULL, kind TEXT NOT NULL, wallet TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (signature, idx)
      );
      CREATE INDEX IF NOT EXISTS pool_trades_market ON pool_trades (market, slot);
      CREATE INDEX IF NOT EXISTS pool_trades_wallet ON pool_trades (wallet);
    `);
  }

  /** Idempotent: re-indexing the same transaction changes nothing. */
  insertTrade(t: PoolTrade): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pool_trades (signature, idx, slot, block_time, market, kind, wallet, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.signature, t.idx, t.slot, t.blockTime, t.market, t.kind, t.wallet, JSON.stringify(t));
  }

  /** Most recent pool trades, newest first. */
  listTrades(filter: { market?: string; wallet?: string; limit?: number } = {}): PoolTrade[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.market) {
      where.push("market = ?");
      params.push(filter.market);
    }
    if (filter.wallet) {
      where.push("wallet = ?");
      params.push(filter.wallet);
    }
    const sql = `SELECT json FROM pool_trades ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY slot DESC, signature, idx DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, Math.min(filter.limit ?? 50, 500)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as PoolTrade);
  }

  /** Totals per (market, outcome) for one wallet: the basis for cost basis. */
  positionHistory(wallet: string): PositionHistory[] {
    const rows = this.db.prepare("SELECT json FROM pool_trades WHERE wallet = ?").all(wallet) as { json: string }[];
    const acc = new Map<string, { market: string; outcome: number; bs: bigint; bu: bigint; ss: bigint; su: bigint; rs: bigint; ru: bigint }>();
    for (const r of rows) {
      const t = JSON.parse(r.json) as PoolTrade;
      const key = `${t.market}:${t.outcome}`;
      const a = acc.get(key) ?? { market: t.market, outcome: t.outcome, bs: 0n, bu: 0n, ss: 0n, su: 0n, rs: 0n, ru: 0n };
      if (t.kind === "buy") {
        a.bs += BigInt(t.shares);
        a.bu += BigInt(t.usdc);
      } else if (t.kind === "sell") {
        a.ss += BigInt(t.shares);
        a.su += BigInt(t.usdc);
      } else {
        a.rs += BigInt(t.shares);
        a.ru += BigInt(t.usdc);
      }
      acc.set(key, a);
    }
    return [...acc.values()].map((a) => ({
      market: a.market,
      outcome: a.outcome,
      boughtShares: a.bs.toString(),
      boughtUsdc: a.bu.toString(),
      soldShares: a.ss.toString(),
      soldUsdc: a.su.toString(),
      redeemedShares: a.rs.toString(),
      redeemedUsdc: a.ru.toString(),
    }));
  }

  upsertMarket(meta: MarketMeta): void {
    this.db
      .prepare(
        "INSERT INTO markets (id_hex, created_at, json) VALUES (?, ?, ?) ON CONFLICT(id_hex) DO UPDATE SET json = excluded.json",
      )
      .run(meta.idHex, meta.createdAt, JSON.stringify(meta));
  }

  getMarket(idHex: string): MarketMeta | null {
    const row = this.db.prepare("SELECT json FROM markets WHERE id_hex = ?").get(idHex) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as MarketMeta) : null;
  }

  listMarkets(): MarketMeta[] {
    const rows = this.db.prepare("SELECT json FROM markets ORDER BY created_at, id_hex").all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as MarketMeta);
  }

  recordPairCreation(idHex: string, creator: string, ts: number): void {
    this.db.prepare("INSERT OR REPLACE INTO pair_creations (id_hex, creator, ts) VALUES (?, ?, ?)").run(idHex, creator, ts);
  }

  pairCreationsSince(ts: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM pair_creations WHERE ts >= ?").get(ts) as { n: number };
    return Number(row.n);
  }

  lastFaucet(wallet: string): number | null {
    const row = this.db.prepare("SELECT ts FROM faucet WHERE wallet = ?").get(wallet) as { ts: number } | undefined;
    return row ? Number(row.ts) : null;
  }

  recordFaucet(wallet: string, ts: number): void {
    this.db.prepare("INSERT OR REPLACE INTO faucet (wallet, ts) VALUES (?, ?)").run(wallet, ts);
  }

  get(key: string): string | null {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
    return row ? row.v : null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

export interface AuditEntry {
  ts: string;
  marketId: string;
  action: "resolve" | "void" | "halt" | "unhalt" | "create";
  winner?: number;
  reason: string;
  /** Transaction signature(s) that carried the action on-chain. */
  tx: string[];
  /** The exact Gemini responses the decision was based on, with their hashes. */
  gemini: { ticker: string; sha256: string; body: string }[];
}

/**
 * Append-only audit log, one JSON object per line. Every oracle action is
 * written here with the Gemini response that justified it and that response's
 * SHA-256, so anyone can check what the relayer saw when it acted.
 */
export class AuditLog {
  readonly entries: AuditEntry[] = [];

  /** `path` null keeps entries in memory only (tests). */
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: Omit<AuditEntry, "ts" | "gemini"> & { gemini: { ticker: string; body: string }[] }): AuditEntry {
    const full: AuditEntry = {
      ts: new Date().toISOString(),
      ...entry,
      gemini: entry.gemini.map((g) => ({ ticker: g.ticker, sha256: sha256Hex(g.body), body: g.body })),
    };
    this.entries.push(full);
    if (this.path) appendFileSync(this.path, JSON.stringify(full) + "\n");
    return full;
  }
}
