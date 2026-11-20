import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  RFQ_DECIDE_WINDOW_MS,
  RFQ_MIN_SIZE,
  RFQ_QUOTE_WINDOW_MS,
  RFQ_SIGN_WINDOW_MS,
  type RfqDoneStatus,
  type RfqFill,
  type RfqServerMsg,
  type SwapTerms,
  buildSwapTx,
  rfqHelloMessage,
  rfqQuoterMessage,
  secondaryFee,
  swapValue,
} from "@parilayer/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { RfqStore } from "./store";

/** What the engine needs to know about a market. */
export interface MarketInfo {
  marketId: string;
  /** Share mint of each outcome, in index order (base58). */
  mints: string[];
  /** False once the market is resolved or voided: shares no longer trade. */
  tradable: boolean;
}

/** Chain access, injected so the rules can be tested without a validator. */
export interface RfqChain {
  market(marketId: string): Promise<MarketInfo | null>;
  exchange(): Promise<{ usdcMint: string; treasuryVault: string; secondaryFeeBps: number }>;
  /** Balance of the wallet's associated token account for `mint`, base units (0 if it has none). */
  balance(owner: string, mint: string): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Dry-runs the swap. Returns an error description, or null if it would succeed. */
  simulate(tx: Transaction): Promise<string | null>;
  /** Sends a fully signed transaction and waits for confirmation. Returns its signature. */
  submit(raw: Uint8Array): Promise<string>;
}

export interface Outbox {
  /** Deliver to every socket of one wallet. */
  send(wallet: string, msg: RfqServerMsg): void;
  /** Deliver to everyone connected (the public tape). */
  broadcast(msg: RfqServerMsg): void;
}

export interface EngineOptions {
  minSize?: bigint;
  quoteWindowMs?: number;
  decideWindowMs?: number;
  signWindowMs?: number;
  /** Signing failures within `failureWindowMs` that trigger a cooldown. */
  failureLimit?: number;
  failureWindowMs?: number;
  cooldownMs?: number;
  /** Highest quote accepted, USDC base units per share. */
  maxPriceE6?: bigint;
  /** How old a signed hello / opt-in message may be. */
  authWindowMs?: number;
  now?: () => number;
}

interface Quote {
  bid: bigint | null;
  ask: bigint | null;
  receiver: string | null;
  ts: number;
}

interface Rfq {
  id: string;
  marketId: string;
  outcome: number;
  mint: string;
  size: bigint;
  requester: string;
  status: "quoting" | "deciding" | "signing";
  quoteDeadline: number;
  decideDeadline: number;
  invited: Set<string>;
  quotes: Map<string, Quote>;
  signing?: {
    quoter: string;
    terms: SwapTerms;
    message: Uint8Array;
    sigs: Map<string, Uint8Array>;
    deadline: number;
    submitting: boolean;
  };
}

export class RfqError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

function parseKey(s: string, what: string): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new RfqError("bad_request", `${what} is not a Solana address`);
  }
}

function parseUnits(s: unknown, what: string): bigint {
  if (typeof s !== "string" || !/^\d{1,20}$/.test(s)) throw new RfqError("bad_request", `${what} must be a whole number of base units`);
  return BigInt(s);
}

/**
 * The secondary market's rules. Transport-free: the WebSocket server feeds it
 * messages and it answers through the Outbox.
 *
 * Privacy rules enforced here:
 * - an RFQ never says whether the requester wants to buy or sell;
 * - quoters never learn who is asking, and never see each other's quotes;
 * - the requester sees only the best bid and the best ask, never who quoted.
 */
export class RfqEngine {
  private readonly quoters = new Map<string, Map<string, { minFillRate: number }>>();
  private readonly rfqs = new Map<string, Rfq>();
  private readonly o: Required<EngineOptions>;

  constructor(
    private readonly chain: RfqChain,
    private readonly store: RfqStore,
    private readonly out: Outbox,
    options: EngineOptions = {},
  ) {
    this.o = {
      minSize: options.minSize ?? RFQ_MIN_SIZE,
      quoteWindowMs: options.quoteWindowMs ?? RFQ_QUOTE_WINDOW_MS,
      decideWindowMs: options.decideWindowMs ?? RFQ_DECIDE_WINDOW_MS,
      signWindowMs: options.signWindowMs ?? RFQ_SIGN_WINDOW_MS,
      failureLimit: options.failureLimit ?? 3,
      failureWindowMs: options.failureWindowMs ?? 60 * 60 * 1000,
      cooldownMs: options.cooldownMs ?? 60 * 60 * 1000,
      maxPriceE6: options.maxPriceE6 ?? 1_000_000_000n, // 1,000 USDC a share
      authWindowMs: options.authWindowMs ?? 5 * 60 * 1000,
      now: options.now ?? Date.now,
    };
  }

  get minSize(): bigint {
    return this.o.minSize;
  }

  // ------------------------------------------------------------------ identity

  private verifySigned(wallet: string, ts: number, sig: string, message: Uint8Array): void {
    const key = parseKey(wallet, "wallet");
    if (!Number.isFinite(ts) || Math.abs(this.o.now() - ts) > this.o.authWindowMs) {
      throw new RfqError("stale_signature", "That signature is too old. Sign again.");
    }
    let ok = false;
    try {
      ok = ed25519.verify(b64(sig), message, key.toBytes());
    } catch {
      ok = false;
    }
    if (!ok) throw new RfqError("bad_signature", "The signature does not match the wallet.");
  }

  /** Checks a connection's hello. Throws if the signature is not the wallet's. */
  verifyHello(wallet: string, ts: number, sig: string): void {
    this.verifySigned(wallet, ts, sig, rfqHelloMessage(wallet, ts));
  }

  /** End of the wallet's cooldown, or null if it is not in one. */
  cooldownUntil(wallet: string): number | null {
    const now = this.o.now();
    const times = this.store.failureTimes(wallet, now - this.o.failureWindowMs - this.o.cooldownMs);
    let until: number | null = null;
    // A cooldown starts at any failure that is the Nth within the window before it.
    for (let i = this.o.failureLimit - 1; i < times.length; i++) {
      if (times[i]! - times[i - (this.o.failureLimit - 1)]! <= this.o.failureWindowMs) until = times[i]! + this.o.cooldownMs;
    }
    return until !== null && until > now ? until : null;
  }

  stats(wallet: string): { fillRate: number; cooldownUntil: number | null } {
    return { fillRate: this.store.fillRate(wallet), cooldownUntil: this.cooldownUntil(wallet) };
  }

  private requireNoCooldown(wallet: string): void {
    const until = this.cooldownUntil(wallet);
    if (until !== null) {
      throw new RfqError(
        "cooldown",
        `This wallet is in a cooldown after ${this.o.failureLimit} unsigned trades. It ends in ${Math.ceil((until - this.o.now()) / 60000)} minutes.`,
      );
    }
  }

  // ------------------------------------------------------------------ quoters

  /** A holder opts in as a quoter for one market by signing a message; their share balance is checked on-chain. */
  async quoterOn(wallet: string, marketId: string, ts: number, sig: string, minFillRate = 0): Promise<void> {
    this.verifySigned(wallet, ts, sig, rfqQuoterMessage(marketId, wallet, ts));
    this.requireNoCooldown(wallet);
    if (!(minFillRate >= 0 && minFillRate <= 1)) throw new RfqError("bad_request", "minFillRate must be between 0 and 1");
    const market = await this.chain.market(marketId);
    if (!market) throw new RfqError("unknown_market", "There is no such market.");
    if (!market.tradable) throw new RfqError("market_settled", "This market is settled; its shares no longer trade.");
    const balances = await Promise.all(market.mints.map((m) => this.chain.balance(wallet, m)));
    if (!balances.some((b) => b > 0n)) {
      throw new RfqError("not_a_holder", "Only holders can quote. Buy shares in this market first.");
    }
    let m = this.quoters.get(marketId);
    if (!m) this.quoters.set(marketId, (m = new Map()));
    m.set(wallet, { minFillRate });
    this.out.send(wallet, { t: "quoter_status", marketId, on: true });
  }

  quoterOff(wallet: string, marketId: string): void {
    this.quoters.get(marketId)?.delete(wallet);
    this.out.send(wallet, { t: "quoter_status", marketId, on: false });
  }

  /** Call when a wallet's last connection closes: it can no longer answer RFQs. */
  walletOffline(wallet: string): void {
    for (const m of this.quoters.values()) m.delete(wallet);
  }

  quoterCount(marketId: string): number {
    return this.quoters.get(marketId)?.size ?? 0;
  }

  // ------------------------------------------------------------------ requesting

  /** A two-sided RFQ: market, outcome and size. It does not say buy or sell. */
  async createRfq(requester: string, marketId: string, outcome: number, sizeText: string): Promise<string> {
    this.requireNoCooldown(requester);
    const size = parseUnits(sizeText, "size");
    if (size < this.o.minSize) {
      throw new RfqError("too_small", `The smallest request is ${this.o.minSize / 1_000_000n} shares.`);
    }
    for (const r of this.rfqs.values()) {
      if (r.requester === requester) throw new RfqError("busy", "Finish or walk away from your open request first.");
    }
    const market = await this.chain.market(marketId);
    if (!market) throw new RfqError("unknown_market", "There is no such market.");
    if (!market.tradable) throw new RfqError("market_settled", "This market is settled; its shares no longer trade.");
    const mint = Number.isInteger(outcome) ? market.mints[outcome] : undefined;
    if (!mint) throw new RfqError("bad_request", "No such outcome.");

    const now = this.o.now();
    const id = randomBytes(8).toString("hex");
    const fillRate = this.store.fillRate(requester);
    const invited = new Set<string>();
    for (const [wallet, q] of this.quoters.get(marketId) ?? []) {
      if (wallet !== requester && fillRate >= q.minFillRate && this.cooldownUntil(wallet) === null) invited.add(wallet);
    }

    this.store.insertRfq({ id, marketId, outcome, size: size.toString(), requester, createdAt: now, status: invited.size ? "quoting" : "no_quoters", hadQuotes: false });
    if (invited.size === 0) {
      this.out.send(requester, { t: "rfq_done", rfqId: id, status: "no_quoters", reason: "No quoters are online for this market right now." });
      return id;
    }

    const rfq: Rfq = {
      id,
      marketId,
      outcome,
      mint,
      size,
      requester,
      status: "quoting",
      quoteDeadline: now + this.o.quoteWindowMs,
      decideDeadline: now + this.o.quoteWindowMs + this.o.decideWindowMs,
      invited,
      quotes: new Map(),
    };
    this.rfqs.set(id, rfq);
    this.out.send(requester, { t: "rfq_open", rfqId: id, marketId, outcome, size: size.toString(), expiresAt: rfq.quoteDeadline, quoters: invited.size });
    for (const wallet of invited) {
      this.out.send(wallet, { t: "rfq_request", rfqId: id, marketId, outcome, size: size.toString(), expiresAt: rfq.quoteDeadline });
    }
    return id;
  }

  private best(rfq: Rfq): { bid: { quoter: string; price: bigint } | null; ask: { quoter: string; price: bigint } | null } {
    let bid: { quoter: string; price: bigint; ts: number } | null = null;
    let ask: { quoter: string; price: bigint; ts: number } | null = null;
    for (const [quoter, q] of rfq.quotes) {
      // Highest bid and lowest ask win; the earlier quote wins a tie.
      if (q.bid !== null && (!bid || q.bid > bid.price || (q.bid === bid.price && q.ts < bid.ts))) bid = { quoter, price: q.bid, ts: q.ts };
      if (q.ask !== null && (!ask || q.ask < ask.price || (q.ask === ask.price && q.ts < ask.ts))) ask = { quoter, price: q.ask, ts: q.ts };
    }
    return { bid, ask };
  }

  private sendBest(rfq: Rfq): void {
    const { bid, ask } = this.best(rfq);
    this.out.send(rfq.requester, {
      t: "rfq_quotes",
      rfqId: rfq.id,
      bestBid: bid ? bid.price.toString() : null,
      bestAsk: ask ? ask.price.toString() : null,
      decideBy: rfq.decideDeadline,
    });
  }

  /** A quoter answers with a bid, an ask, or both. Balances are checked so a quote can actually settle. */
  async quote(quoter: string, rfqId: string, bidText?: string, askText?: string, receiver?: string): Promise<void> {
    const rfq = this.rfqs.get(rfqId);
    const now = this.o.now();
    // The same answer whether the RFQ never existed or the quoter was not invited: nothing leaks.
    if (!rfq || !rfq.invited.has(quoter) || rfq.status !== "quoting" || now >= rfq.quoteDeadline) {
      throw new RfqError("closed", "That request is closed.");
    }
    const bid = bidText === undefined ? null : parseUnits(bidText, "bid");
    const ask = askText === undefined ? null : parseUnits(askText, "ask");
    if (bid === null && ask === null) throw new RfqError("bad_request", "Send a bid, an ask, or both.");
    for (const p of [bid, ask]) {
      if (p !== null && (p <= 0n || p > this.o.maxPriceE6)) throw new RfqError("bad_request", "Price is out of range.");
    }
    if (bid !== null && ask !== null && bid >= ask) throw new RfqError("bad_request", "Your bid must be below your ask.");
    if (receiver !== undefined) parseKey(receiver, "receiver");

    const { usdcMint } = await this.chain.exchange();
    if (ask !== null && (await this.chain.balance(quoter, rfq.mint)) < rfq.size) {
      throw new RfqError("insufficient", "You do not hold enough shares to offer that size.");
    }
    if (bid !== null && (await this.chain.balance(quoter, usdcMint)) < swapValue(rfq.size, bid)) {
      throw new RfqError("insufficient", "You do not hold enough USDC to bid for that size.");
    }
    if (rfq.status !== "quoting" || this.o.now() >= rfq.quoteDeadline) throw new RfqError("closed", "That request is closed.");

    rfq.quotes.set(quoter, { bid, ask, receiver: receiver ?? null, ts: now });
    this.store.upsertQuote(rfq.id, quoter, bid?.toString() ?? null, ask?.toString() ?? null, now);
    // Nothing is sent to the requester yet: they see the best bid and ask once,
    // when the window closes, so a running "best so far" cannot reveal the other quotes.
  }

  private finish(rfq: Rfq, status: RfqDoneStatus, extra: { signature?: string; reason?: string } = {}): void {
    this.rfqs.delete(rfq.id);
    this.store.setRfqStatus(rfq.id, status, rfq.quotes.size > 0);
    this.out.send(rfq.requester, { t: "rfq_done", rfqId: rfq.id, status, ...extra });
    for (const wallet of rfq.invited) {
      if (wallet === rfq.signing?.quoter) this.out.send(wallet, { t: "rfq_done", rfqId: rfq.id, status, ...extra });
      else this.out.send(wallet, { t: "rfq_closed", rfqId: rfq.id });
    }
  }

  /** The requester walks away. Allowed any time before accepting. */
  walk(requester: string, rfqId: string): void {
    const rfq = this.rfqs.get(rfqId);
    if (!rfq || rfq.requester !== requester || rfq.status === "signing") throw new RfqError("closed", "That request is closed.");
    this.finish(rfq, "walked");
  }

  /** The requester picks a side: "buy" takes the best ask, "sell" hits the best bid. */
  async accept(requester: string, rfqId: string, side: "buy" | "sell", receiver?: string): Promise<void> {
    const rfq = this.rfqs.get(rfqId);
    if (!rfq || rfq.requester !== requester) throw new RfqError("closed", "That request is closed.");
    if (rfq.status === "quoting") throw new RfqError("too_early", "Quotes are still coming in. Wait for the countdown.");
    if (rfq.status !== "deciding") throw new RfqError("closed", "That request is already being settled.");
    if (side !== "buy" && side !== "sell") throw new RfqError("bad_request", "side must be buy or sell");
    if (receiver !== undefined) parseKey(receiver, "receiver");

    const { bid, ask } = this.best(rfq);
    const chosen = side === "buy" ? ask : bid;
    if (!chosen) throw new RfqError("no_quote", side === "buy" ? "Nobody offered to sell." : "Nobody bid.");
    const quote = rfq.quotes.get(chosen.quoter)!;

    const buyer = side === "buy" ? requester : chosen.quoter;
    const seller = side === "buy" ? chosen.quoter : requester;
    // The buyer may name a fresh receiving address.
    const receiverKey = side === "buy" ? (receiver ?? requester) : (quote.receiver ?? chosen.quoter);

    rfq.status = "signing"; // claim the RFQ before any await so it cannot be accepted twice
    try {
      const ex = await this.chain.exchange();
      const value = swapValue(rfq.size, chosen.price);
      const fee = secondaryFee(value, ex.secondaryFeeBps);
      const [sellerShares, buyerUsdc, requesterUsdc] = await Promise.all([
        this.chain.balance(seller, rfq.mint),
        this.chain.balance(buyer, ex.usdcMint),
        this.chain.balance(requester, ex.usdcMint),
      ]);
      if (sellerShares < rfq.size) throw new RfqError("insufficient", "The seller no longer holds enough shares.");
      if (buyerUsdc < value + (buyer === requester ? fee : 0n)) throw new RfqError("insufficient", "The buyer does not hold enough USDC.");
      if (requesterUsdc < fee + (buyer === requester ? value : 0n)) {
        throw new RfqError("insufficient", "You need enough USDC to cover the 0.5% secondary fee.");
      }

      const { blockhash, lastValidBlockHeight } = await this.chain.latestBlockhash();
      const terms: SwapTerms = {
        marketId: rfq.marketId,
        outcome: rfq.outcome,
        shareMint: rfq.mint,
        usdcMint: ex.usdcMint,
        treasuryVault: ex.treasuryVault,
        seller,
        buyer,
        requester,
        receiver: receiverKey,
        size: rfq.size.toString(),
        priceE6: chosen.price.toString(),
        value: value.toString(),
        fee: fee.toString(),
        blockhash,
        lastValidBlockHeight,
      };
      const tx = buildSwapTx(terms);
      const simError = await this.chain.simulate(tx);
      if (simError) throw new RfqError("would_fail", `The swap would not settle: ${simError}`);

      const deadline = this.o.now() + this.o.signWindowMs;
      rfq.signing = { quoter: chosen.quoter, terms, message: Uint8Array.from(tx.serializeMessage()), sigs: new Map(), deadline, submitting: false };
      this.store.setRfqStatus(rfq.id, "signing", true);
      const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
      this.out.send(buyer, { t: "sign_request", rfqId: rfq.id, role: "buyer", terms, tx: raw, signBy: deadline });
      this.out.send(seller, { t: "sign_request", rfqId: rfq.id, role: "seller", terms, tx: raw, signBy: deadline });
      // Everyone else's quote is done; they are told nothing about who won.
      for (const wallet of rfq.invited) if (wallet !== chosen.quoter) this.out.send(wallet, { t: "rfq_closed", rfqId: rfq.id });
    } catch (e) {
      // Could not even start settling: nobody is penalized.
      this.finish(rfq, "failed", { reason: e instanceof RfqError ? e.message : "The swap could not be prepared." });
      if (!(e instanceof RfqError)) throw e;
    }
  }

  /**
   * A party returns the transaction signed. Only their signature is taken from
   * it, and it is checked against the transaction the server built, so a
   * tampered transaction is simply rejected.
   */
  async signed(wallet: string, rfqId: string, txBase64: string): Promise<void> {
    const rfq = this.rfqs.get(rfqId);
    const s = rfq?.signing;
    if (!rfq || !s || (wallet !== s.terms.buyer && wallet !== s.terms.seller)) throw new RfqError("closed", "That request is closed.");
    if (this.o.now() > s.deadline) throw new RfqError("too_late", "The 30 seconds to sign have passed.");

    let sig: Uint8Array | null = null;
    try {
      const tx = Transaction.from(Buffer.from(txBase64, "base64"));
      const mine = tx.signatures.find((x) => x.publicKey.toBase58() === wallet)?.signature;
      sig = mine ? Uint8Array.from(mine) : null;
    } catch {
      sig = null;
    }
    if (!sig || !ed25519.verify(sig, s.message, new PublicKey(wallet).toBytes())) {
      throw new RfqError("bad_signature", "That is not a valid signature of the agreed swap.");
    }
    s.sigs.set(wallet, sig);
    if (s.sigs.size < 2 || s.submitting) return;

    s.submitting = true;
    const tx = buildSwapTx(s.terms);
    tx.addSignature(new PublicKey(s.terms.buyer), Buffer.from(s.sigs.get(s.terms.buyer)!));
    tx.addSignature(new PublicKey(s.terms.seller), Buffer.from(s.sigs.get(s.terms.seller)!));
    let signature: string;
    try {
      signature = await this.chain.submit(tx.serialize());
    } catch (e) {
      // The transaction is atomic: if anything in it failed, nothing moved.
      this.finish(rfq, "failed", { reason: `The swap did not settle; nothing moved. ${(e as Error).message}`.slice(0, 300) });
      return;
    }
    const fill: RfqFill = {
      marketId: rfq.marketId,
      outcome: rfq.outcome,
      priceE6: s.terms.priceE6,
      size: s.terms.size,
      ts: this.o.now(),
      signature,
    };
    this.store.insertFill({ ...fill, rfqId: rfq.id, buyer: s.terms.buyer, seller: s.terms.seller, value: s.terms.value, fee: s.terms.fee });
    this.finish(rfq, "filled", { signature });
    // The trade is public the moment it settles: price, size and time, no names.
    this.out.broadcast({ t: "fill", fill });
  }

  /** Advances the clocks: closes quote windows, expires undecided RFQs, and penalizes unsigned trades. */
  sweep(): void {
    const now = this.o.now();
    for (const rfq of [...this.rfqs.values()]) {
      if (rfq.status === "quoting" && now >= rfq.quoteDeadline) {
        if (rfq.quotes.size === 0) {
          this.finish(rfq, "expired", { reason: "No quotes came in." });
        } else {
          rfq.status = "deciding";
          this.store.setRfqStatus(rfq.id, "deciding", true);
          this.sendBest(rfq);
        }
      } else if (rfq.status === "deciding" && now >= rfq.decideDeadline) {
        this.finish(rfq, "expired", { reason: "You did not pick a side in time." });
      } else if (rfq.status === "signing" && rfq.signing && !rfq.signing.submitting && now > rfq.signing.deadline) {
        // Accepting and then not signing in time is a failure for whoever did not sign.
        const s = rfq.signing;
        const late = [s.terms.buyer, s.terms.seller].filter((w) => !s.sigs.has(w));
        for (const w of late) this.store.recordFailure(w, now, rfq.id, "did not sign in time");
        this.finish(rfq, "failed", { reason: "The swap was not signed within 30 seconds." });
      }
    }
  }
}
