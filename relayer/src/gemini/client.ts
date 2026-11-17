import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EventWithRaw, GeminiCombo, GeminiCombosPage, GeminiEvent, GeminiEventsPage } from "./types";

export const GEMINI_BASE = "https://api.gemini.com";

export interface ListEventsParams {
  status?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Everything the relayer needs from Gemini. Implemented by the live client and the mock. */
export interface GeminiSource {
  /** One event with its contracts, or null if Gemini does not know the ticker. */
  getEvent(ticker: string): Promise<EventWithRaw | null>;
  listEvents(params: ListEventsParams): Promise<GeminiEventsPage>;
  /** All active combo instruments. Empty when the endpoint is unavailable. */
  listCombos(): Promise<GeminiCombo[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Live client. Public endpoints, no API key. Requests are spaced at least
 * `minIntervalMs` apart: Gemini's public limit is 120 requests/minute and it
 * recommends at most 1 per second.
 */
export class GeminiHttp implements GeminiSource {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly base = GEMINI_BASE,
    private readonly minIntervalMs = 1100,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** GET a path; returns status and body text. Retries 429 and 5xx with backoff. */
  private get(path: string): Promise<{ status: number; body: string }> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = this.last + this.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.last = Date.now();
        let res: Response;
        try {
          res = await this.fetchImpl(this.base + path, {
            headers: { accept: "application/json", "user-agent": "pmec-relayer" },
            signal: AbortSignal.timeout(20_000),
          });
        } catch (e) {
          if (attempt >= 2) throw e;
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        return { status: res.status, body: await res.text() };
      }
    };
    // Serialize so spacing holds even when callers fire in parallel.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async getEvent(ticker: string): Promise<EventWithRaw | null> {
    const { status, body } = await this.get(`/v1/prediction-markets/events/${encodeURIComponent(ticker)}`);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`Gemini GET event ${ticker}: HTTP ${status}`);
    return { event: JSON.parse(body) as GeminiEvent, raw: body };
  }

  async listEvents(params: ListEventsParams): Promise<GeminiEventsPage> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const { status, body } = await this.get(`/v1/prediction-markets/events?${qs}`);
    if (status !== 200) throw new Error(`Gemini list events: HTTP ${status}`);
    return JSON.parse(body) as GeminiEventsPage;
  }

  async listCombos(): Promise<GeminiCombo[]> {
    const out: GeminiCombo[] = [];
    for (let offset = 0; offset < 2000; offset += 500) {
      const { status, body } = await this.get(`/v1/prediction-markets/combos?limit=500&offset=${offset}`);
      // The docs warn this endpoint may be disabled; treat any failure as "no combos".
      if (status !== 200) return out;
      const page = JSON.parse(body) as GeminiCombosPage;
      out.push(...(page.combos ?? []));
      if (!page.pagination || out.length >= page.pagination.total || (page.combos ?? []).length === 0) break;
    }
    return out;
  }
}

/**
 * Offline source backed by recorded fixtures, so the demo and the tests run
 * without the network. Layout of the fixtures directory:
 *
 *   events/<TICKER>.json   one recorded GET /events/{ticker} response
 *   combos.json            one recorded GET /combos response
 *
 * `override` replaces an event in memory, which is how a demo simulates
 * Gemini settling or halting a market.
 */
export class GeminiMock implements GeminiSource {
  private readonly events = new Map<string, GeminiEvent>();
  private combos: GeminiCombo[] = [];

  constructor(fixturesDir: string) {
    const dir = join(fixturesDir, "events");
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        const ev = JSON.parse(readFileSync(join(dir, f), "utf8")) as GeminiEvent;
        this.events.set(ev.ticker, ev);
      }
    }
    const combos = join(fixturesDir, "combos.json");
    if (existsSync(combos)) this.combos = (JSON.parse(readFileSync(combos, "utf8")) as GeminiCombosPage).combos ?? [];
  }

  override(event: GeminiEvent): void {
    this.events.set(event.ticker, event);
  }

  /** Simulates Gemini settling one contract (and the event, once all are settled). */
  settle(ticker: string, instrumentSymbol: string, side: "yes" | "no"): void {
    const ev = this.events.get(ticker);
    if (!ev) throw new Error(`no fixture for ${ticker}`);
    const now = new Date().toISOString();
    const contracts = ev.contracts.map((c) =>
      c.instrumentSymbol === instrumentSymbol
        ? { ...c, status: "settled" as const, marketState: "closed" as const, resolutionSide: side, resolvedAt: now, prices: {} }
        : c,
    );
    const allSettled = contracts.every((c) => c.status === "settled");
    this.events.set(ticker, { ...ev, contracts, status: allSettled ? "settled" : ev.status, resolvedAt: allSettled ? now : ev.resolvedAt });
  }

  async getEvent(ticker: string): Promise<EventWithRaw | null> {
    const event = this.events.get(ticker);
    return event ? { event, raw: JSON.stringify(event) } : null;
  }

  async listEvents(params: ListEventsParams): Promise<GeminiEventsPage> {
    let data = [...this.events.values()];
    if (params.status) data = data.filter((e) => e.status === params.status);
    if (params.category) data = data.filter((e) => e.category.toLowerCase() === params.category!.toLowerCase());
    if (params.search) data = data.filter((e) => e.title.toLowerCase().includes(params.search!.toLowerCase()));
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return { data: data.slice(offset, offset + limit), pagination: { limit, offset, total: data.length } };
  }

  async listCombos(): Promise<GeminiCombo[]> {
    return this.combos;
  }
}
