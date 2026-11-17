/**
 * A simple quoter bot, so the secondary market has someone to trade with in a
 * demo. It opts in on every market where its wallet holds shares and answers
 * each RFQ with a bid and an ask around the pool price.
 *
 *   BOT_KEYPAIR=keys/bot.json npm run bot -w rfq
 *
 * Environment: SOLANA_RPC_URL, RFQ_URL (default http://127.0.0.1:8788),
 * BOT_SPREAD_BPS (default 300: bid 3% under the pool price, ask at the pool price).
 * Before signing it checks that the transaction is exactly the swap it quoted.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  type MarketState,
  type RfqClientMsg,
  type RfqServerMsg,
  ata,
  fetchAllMarkets,
  fetchConfig,
  getProgram,
  outcomeMintPda,
  priceE6,
  rfqHelloMessage,
  rfqQuoterMessage,
  swapTxMatches,
  swapValue,
} from "@pmec/sdk";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import WebSocket from "ws";

export interface BotOptions {
  connection: Connection;
  keypair: Keypair;
  /** RFQ service base URL, e.g. http://127.0.0.1:8788 */
  rfqUrl: string;
  /** Bid this far under the pool price, in basis points. The ask is the pool price. */
  spreadBps?: number;
  log?: (msg: string) => void;
}

export class QuoterBot {
  private ws: WebSocket | null = null;
  private readonly wallet: string;
  private readonly program;
  private markets = new Map<string, MarketState>();
  /** rfqId -> what we quoted, so a sign request can be checked against it. */
  private readonly quoted = new Map<string, { marketId: string; outcome: number; size: bigint; bid: bigint | null; ask: bigint | null }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log: (msg: string) => void;
  private readonly spreadBps: bigint;
  readonly fills: string[] = [];

  constructor(private readonly o: BotOptions) {
    this.wallet = o.keypair.publicKey.toBase58();
    this.program = getProgram(o.connection);
    this.log = o.log ?? (() => undefined);
    this.spreadBps = BigInt(o.spreadBps ?? 300);
  }

  private sign(message: Uint8Array): string {
    return Buffer.from(ed25519.sign(message, this.o.keypair.secretKey.slice(0, 32))).toString("base64");
  }

  private send(msg: RfqClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async balance(mint: string): Promise<bigint> {
    const info = await this.o.connection.getAccountInfo(ata(new PublicKey(mint), this.o.keypair.publicKey), "confirmed");
    return info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
  }

  /** Opts in on every tradable market where the bot holds shares of some outcome. */
  private readonly optedIn = new Set<string>();
  async refreshMarkets(): Promise<void> {
    const all = await fetchAllMarkets(this.program);
    this.markets = new Map(all.map((m) => [m.idHex, m]));
    for (const m of all) {
      if (m.status !== "open" && m.status !== "halted") continue;
      if (this.optedIn.has(m.idHex)) continue;
      const balances = await Promise.all(Array.from({ length: m.n }, (_, i) => this.balance(outcomeMintPda(m.address, i).toBase58())));
      if (!balances.some((b) => b > 0n)) continue;
      const ts = Date.now();
      this.send({ t: "quoter_on", marketId: m.idHex, ts, sig: this.sign(rfqQuoterMessage(m.idHex, this.wallet, ts)) });
    }
  }

  private async onRequest(msg: Extract<RfqServerMsg, { t: "rfq_request" }>): Promise<void> {
    const market = this.markets.get(msg.marketId);
    if (!market) return;
    // Quote around what a new share costs at the pool right now.
    const fresh = (await fetchAllMarkets(this.program)).find((m) => m.idHex === msg.marketId) ?? market;
    this.markets.set(fresh.idHex, fresh);
    const pool = priceE6(fresh.q, msg.outcome);
    const size = BigInt(msg.size);
    const cfg = await fetchConfig(this.program);
    if (!cfg) return;
    let bid: bigint | null = (pool * (10_000n - this.spreadBps)) / 10_000n;
    let ask: bigint | null = pool;
    const [shares, usdc] = await Promise.all([
      this.balance(outcomeMintPda(fresh.address, msg.outcome).toBase58()),
      this.balance(cfg.usdcMint.toBase58()),
    ]);
    if (shares < size) ask = null;
    if (bid <= 0n || usdc < swapValue(size, bid)) bid = null;
    if (bid === null && ask === null) return;
    this.quoted.set(msg.rfqId, { marketId: msg.marketId, outcome: msg.outcome, size, bid, ask });
    this.send({ t: "quote", rfqId: msg.rfqId, ...(bid !== null ? { bid: bid.toString() } : {}), ...(ask !== null ? { ask: ask.toString() } : {}) });
    this.log(`quoted ${msg.rfqId}: bid ${bid ?? "-"} ask ${ask ?? "-"} for ${size} of outcome ${msg.outcome}`);
  }

  private onSignRequest(msg: Extract<RfqServerMsg, { t: "sign_request" }>): void {
    const q = this.quoted.get(msg.rfqId);
    const t = msg.terms;
    const mine = msg.role === "seller" ? t.seller === this.wallet : t.buyer === this.wallet;
    const price = msg.role === "seller" ? q?.ask : q?.bid;
    const tx = Transaction.from(Buffer.from(msg.tx, "base64"));
    // Sign only the exact swap we quoted: our side, our price, our size, and matching bytes.
    const ok =
      !!q &&
      mine &&
      price !== null &&
      price !== undefined &&
      BigInt(t.priceE6) === price &&
      BigInt(t.size) === q.size &&
      t.marketId === q.marketId &&
      t.outcome === q.outcome &&
      t.requester !== this.wallet &&
      BigInt(t.value) === swapValue(q.size, price) &&
      swapTxMatches(tx, t);
    if (!ok) {
      this.log(`refused to sign ${msg.rfqId}: the transaction is not the swap that was quoted`);
      return;
    }
    tx.partialSign(this.o.keypair);
    this.send({ t: "signed", rfqId: msg.rfqId, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  }

  /** Connects and keeps quoting until stop() is called. Resolves once signed in. */
  start(): Promise<void> {
    return new Promise((resolveReady, reject) => {
      const url = this.o.rfqUrl.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => {
        const ts = Date.now();
        this.send({ t: "hello", wallet: this.wallet, ts, sig: this.sign(rfqHelloMessage(this.wallet, ts)) });
      });
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as RfqServerMsg;
        if (msg.t === "ready") {
          this.optedIn.clear();
          void this.refreshMarkets().then(() => resolveReady(), reject);
          this.timer ??= setInterval(() => void this.refreshMarkets().catch(() => undefined), 20_000);
        } else if (msg.t === "quoter_status") {
          if (msg.on) this.optedIn.add(msg.marketId);
          else this.optedIn.delete(msg.marketId);
          this.log(`quoting ${msg.marketId.slice(0, 8)}: ${msg.on ? "on" : "off"}`);
        } else if (msg.t === "rfq_request") {
          void this.onRequest(msg).catch((e) => this.log(`quote failed: ${(e as Error).message}`));
        } else if (msg.t === "sign_request") {
          this.onSignRequest(msg);
        } else if (msg.t === "rfq_done") {
          this.quoted.delete(msg.rfqId);
          if (msg.status === "filled" && msg.signature) {
            this.fills.push(msg.signature);
            this.log(`filled ${msg.rfqId}: ${msg.signature}`);
          }
        } else if (msg.t === "rfq_closed") {
          this.quoted.delete(msg.rfqId);
        } else if (msg.t === "error") {
          this.log(`server: ${msg.message}`);
        }
      });
      ws.on("close", () => {
        if (this.stopped) return;
        this.log("disconnected; reconnecting in 3 s");
        setTimeout(() => void this.start().catch(() => undefined), 3000);
      });
      ws.on("error", (e) => {
        if (ws.readyState !== WebSocket.OPEN) reject(e);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
  }
}

// Run as a program: `npm run bot -w rfq`.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const ROOT = resolve(import.meta.dirname, "..", "..");
  if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));
  const keyPath = process.env.BOT_KEYPAIR || "keys/bot.json";
  const abs = isAbsolute(keyPath) ? keyPath : join(ROOT, keyPath);
  if (!existsSync(abs)) {
    console.error(`No bot keypair at ${abs}. Create one with: solana-keygen new --no-bip39-passphrase -o ${keyPath}`);
    process.exit(1);
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(abs, "utf8")) as number[]));
  const bot = new QuoterBot({
    connection: new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed"),
    keypair,
    rfqUrl: process.env.RFQ_URL || "http://127.0.0.1:8788",
    spreadBps: Number(process.env.BOT_SPREAD_BPS || 300),
    log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] bot ${m}`),
  });
  console.log(`quoter bot wallet ${keypair.publicKey.toBase58()}`);
  await bot.start();
  process.on("SIGINT", () => {
    bot.stop();
    process.exit(0);
  });
}
