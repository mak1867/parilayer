import { type MarketState, UNIT, fromHex, marketIdFromRefs, toHex } from "@pmec/sdk";
import type { ChainApi } from "./chain";
import type { GeminiSource } from "./gemini/client";
import type { GeminiCombo, GeminiEvent } from "./gemini/types";
import {
  type Decision,
  type MarketPlan,
  type MirrorEntry,
  type Reference,
  eventTickers,
  findCombo,
  planMarkets,
  referenceFor,
  settlementDecision,
} from "./mapping";
import type { AuditLog, MarketMeta, Store } from "./store";

export interface RelayerOptions {
  gemini: GeminiSource;
  chain: ChainApi;
  store: Store;
  audit: AuditLog;
  /** Default seed per market, whole USDC. */
  seedUsdc: number;
  log?: (msg: string) => void;
}

export interface MirrorResult {
  plan: MarketPlan;
  idHex: string;
  status: "created" | "exists";
  address: string;
}

export interface SettlementReport {
  idHex: string;
  decision: Decision;
  /** Signature of the transaction that carried the decision, if one was sent. */
  tx?: string;
  error?: string;
}

interface CachedEvent {
  event: GeminiEvent;
  raw: string;
  fetchedAt: number;
}

/**
 * The relayer's three jobs: mirror Gemini events as on-chain markets, keep
 * Gemini reference prices fresh, and post Gemini's settlements on-chain.
 * All Gemini and chain access goes through the injected interfaces.
 */
export class Relayer {
  private readonly events = new Map<string, CachedEvent>();
  private combos: GeminiCombo[] = [];
  private lastRefresh = 0;
  private timers: NodeJS.Timeout[] = [];
  private busy = { refresh: false, settle: false };
  private readonly log: (msg: string) => void;

  constructor(private readonly o: RelayerOptions) {
    this.log = o.log ?? (() => undefined);
  }

  get lastRefreshAt(): number {
    return this.lastRefresh;
  }

  lookup = (ticker: string): GeminiEvent | undefined => this.events.get(ticker)?.event;

  // ------------------------------------------------------------------ mirror

  /** Fetches each configured event and creates the markets it calls for. */
  async mirror(entries: MirrorEntry[], seedUsdc = this.o.seedUsdc): Promise<{ results: MirrorResult[]; errors: string[] }> {
    const results: MirrorResult[] = [];
    const errors: string[] = [];
    for (const entry of entries) {
      try {
        const fetched = await this.o.gemini.getEvent(entry.event);
        if (!fetched) throw new Error(`Gemini has no event ${entry.event}`);
        this.events.set(entry.event, { ...fetched, fetchedAt: Date.now() });
        for (const plan of planMarkets(entry, fetched.event)) {
          results.push(await this.createFromPlan(plan, { seedUsdc, geminiBodies: [{ ticker: entry.event, body: fetched.raw }] }));
        }
      } catch (e) {
        errors.push(`${entry.event}: ${(e as Error).message}`);
        this.log(`mirror ${entry.event} failed: ${(e as Error).message}`);
      }
    }
    return { results, errors };
  }

  /** Creates one market on-chain (unless it already exists) and remembers its metadata. */
  async createFromPlan(
    plan: MarketPlan,
    opts: { seedUsdc?: number; creator?: string; geminiBodies?: { ticker: string; body: string }[] } = {},
  ): Promise<MirrorResult> {
    const marketId = marketIdFromRefs(plan.refs);
    const idHex = toHex(marketId);
    const seedUnits = BigInt(opts.seedUsdc ?? this.o.seedUsdc) * UNIT;

    const existing = await this.o.chain.getMarket(marketId);
    const known = this.o.store.getMarket(idHex);
    if (existing && known) return { plan, idHex, status: "exists", address: known.address };

    if (!existing) {
      const treasury = await this.o.chain.treasuryBalance();
      if (treasury < seedUnits) {
        throw new Error(`treasury holds ${treasury / UNIT} USDC, cannot cover a ${seedUnits / UNIT} USDC seed`);
      }
    }
    // Uses the plan's probabilities for a new market; finishes a half-created one otherwise.
    const { address, signatures } = await this.o.chain.createMarket({
      marketId,
      kind: plan.kind,
      refs: plan.refs,
      probsPpm: plan.probsPpm,
      seedUsdc: seedUnits,
    });
    const meta: MarketMeta = {
      idHex,
      address: address.toBase58(),
      kind: plan.kind,
      refs: plan.refs,
      title: plan.title,
      category: plan.category,
      outcomes: plan.outcomes,
      source: plan.source,
      seedProbsPpm: plan.probsPpm,
      geminiProbsAtSeed: plan.geminiProbs,
      seedUsdc: (existing?.seedUsdc ?? seedUnits).toString(),
      createdAt: Date.now(),
      expiryDate: plan.expiryDate,
      ...(opts.creator ? { creator: opts.creator } : {}),
    };
    this.o.store.upsertMarket(meta);
    if (signatures.length > 0) {
      this.o.audit.append({
        marketId: idHex,
        action: "create",
        reason: `mirrored ${plan.refs.join(" + ")} as ${plan.kind}`,
        tx: signatures,
        gemini: opts.geminiBodies ?? [],
      });
    }
    this.log(`created ${plan.kind} market "${plan.title}" ${address.toBase58()}`);
    return { plan, idHex, status: existing ? "exists" : "created", address: address.toBase58() };
  }

  // ------------------------------------------------------------------ reference prices

  /** Refetches every Gemini event the live markets depend on, plus the combo list. */
  async refresh(): Promise<void> {
    if (this.busy.refresh) return;
    this.busy.refresh = true;
    try {
      const metas = this.o.store.listMarkets();
      const tickers = new Set<string>();
      for (const m of metas) for (const t of eventTickers(m.source)) tickers.add(t);

      const pairs = metas.filter((m) => m.source.type === "pair");
      if (pairs.length > 0) {
        try {
          this.combos = await this.o.gemini.listCombos();
        } catch (e) {
          this.log(`combo list failed: ${(e as Error).message}`);
        }
        // A combo's price lives on the combo's own event.
        for (const m of pairs) {
          if (m.source.type !== "pair") continue;
          const combo = findCombo(this.combos, m.source.legs[0].instrumentSymbol, m.source.legs[1].instrumentSymbol);
          if (combo) tickers.add(combo.contract.eventTicker);
        }
      }

      for (const ticker of tickers) {
        try {
          const fetched = await this.o.gemini.getEvent(ticker);
          if (fetched) this.events.set(ticker, { ...fetched, fetchedAt: Date.now() });
        } catch (e) {
          this.log(`refresh ${ticker} failed: ${(e as Error).message}`);
        }
      }
      this.lastRefresh = Date.now();
    } finally {
      this.busy.refresh = false;
    }
  }

  /** Gemini's reference prices for one market, from the last refresh. */
  reference(idHex: string): (Reference & { asOf: number | null }) | null {
    const meta = this.o.store.getMarket(idHex);
    if (!meta) return null;
    const ages = eventTickers(meta.source).map((t) => this.events.get(t)?.fetchedAt ?? 0);
    const asOf = ages.length && ages.every((a) => a > 0) ? Math.min(...ages) : null;
    return { ...referenceFor(meta.source, this.lookup, this.combos), asOf };
  }

  // ------------------------------------------------------------------ settlement

  /**
   * One pass of the settlement watcher: for every market not yet settled
   * on-chain, compare Gemini's state with the chain and post what is needed.
   * Uses the events fetched by the last refresh.
   */
  async settleOnce(): Promise<SettlementReport[]> {
    if (this.busy.settle) return [];
    this.busy.settle = true;
    const reports: SettlementReport[] = [];
    try {
      for (const meta of this.o.store.listMarkets()) {
        if (this.o.store.get(`settled:${meta.idHex}`)) continue;
        let state: MarketState | null;
        try {
          state = await this.o.chain.getMarket(fromHex(meta.idHex));
        } catch (e) {
          reports.push({ idHex: meta.idHex, decision: { action: "none", reason: "chain read failed" }, error: (e as Error).message });
          continue;
        }
        if (!state) continue;

        const decision = settlementDecision(meta.source, this.lookup, state.status);
        if (decision.action === "none") {
          if (decision.warning) this.log(`WARNING ${meta.title}: ${decision.warning}`);
          if (state.status === "resolved" || state.status === "voided") {
            await this.redeemSeeds(state);
            this.o.store.set(`settled:${meta.idHex}`, state.status);
          }
          continue;
        }

        const report: SettlementReport = { idHex: meta.idHex, decision };
        try {
          if (decision.action === "resolve") report.tx = await this.o.chain.resolve(state.address, decision.winner);
          else if (decision.action === "void") report.tx = await this.o.chain.void(state.address);
          else if (decision.action === "halt") report.tx = await this.o.chain.halt(state.address);
          else report.tx = await this.o.chain.unhalt(state.address);

          this.o.audit.append({
            marketId: meta.idHex,
            action: decision.action,
            ...(decision.action === "resolve" ? { winner: decision.winner } : {}),
            reason: decision.reason,
            tx: [report.tx],
            gemini: eventTickers(meta.source).flatMap((t) => {
              const cached = this.events.get(t);
              return cached ? [{ ticker: t, body: cached.raw }] : [];
            }),
          });
          this.log(`${decision.action} "${meta.title}": ${decision.reason} (${report.tx})`);
          if (decision.action === "resolve" || decision.action === "void") {
            // Mark first: even if the seed redemption below fails, the settlement is never re-posted.
            this.o.store.set(`settled:${meta.idHex}`, decision.action === "resolve" ? "resolved" : "voided");
            const after = await this.o.chain.getMarket(fromHex(meta.idHex));
            if (after) await this.redeemSeeds(after);
          }
        } catch (e) {
          report.error = (e as Error).message;
          this.log(`${decision.action} "${meta.title}" failed: ${report.error}`);
        }
        reports.push(report);
      }
    } finally {
      this.busy.settle = false;
    }
    return reports;
  }

  /** Brings the treasury's seed payouts home so they can fund future seeds. */
  private async redeemSeeds(state: MarketState): Promise<void> {
    const outcomes =
      state.status === "resolved" && state.winner !== null
        ? [state.winner]
        : state.status === "voided"
          ? Array.from({ length: state.n }, (_, i) => i)
          : [];
    for (const i of outcomes) {
      try {
        const sig = await this.o.chain.redeemSeed(state.address, i);
        if (sig) this.log(`redeemed treasury seed shares of outcome ${i} (${sig})`);
      } catch (e) {
        this.log(`redeem_seed outcome ${i} failed: ${(e as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------------ loop

  /** Starts the polling loops: reference prices every `referenceMs`, settlement every `settlementMs`. */
  start(referenceMs: number, settlementMs: number): void {
    const tick = async (settle: boolean) => {
      try {
        await this.refresh();
        if (settle) await this.settleOnce();
      } catch (e) {
        this.log(`poll failed: ${(e as Error).message}`);
      }
    };
    void tick(true);
    this.timers.push(setInterval(() => void tick(false), referenceMs));
    this.timers.push(setInterval(() => void tick(true), settlementMs));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
