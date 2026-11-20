import type { GeminiSource, ListEventsParams } from "./client";
import type { EventWithRaw, GeminiCombo, GeminiEventsPage } from "./types";

/**
 * Wraps a Gemini source with a short-lived cache, for the pair builder's
 * endpoints. Without it each page load refetched every event one by one (the
 * live client spaces requests 1.1 s apart), which took 10-20 seconds.
 * Concurrent requests for the same ticker share one fetch.
 */
export class CachedGemini implements GeminiSource {
  private readonly events = new Map<string, { at: number; value: Promise<EventWithRaw | null> }>();
  private combos: { at: number; value: Promise<GeminiCombo[]> } | null = null;

  constructor(
    private readonly inner: GeminiSource,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  getEvent(ticker: string): Promise<EventWithRaw | null> {
    const hit = this.events.get(ticker);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = this.inner.getEvent(ticker);
    this.events.set(ticker, { at: this.now(), value });
    // Never cache a failure.
    value.catch(() => this.events.delete(ticker));
    return value;
  }

  listEvents(params: ListEventsParams): Promise<GeminiEventsPage> {
    return this.inner.listEvents(params);
  }

  listCombos(): Promise<GeminiCombo[]> {
    if (this.combos && this.now() - this.combos.at < this.ttlMs) return this.combos.value;
    const value = this.inner.listCombos();
    this.combos = { at: this.now(), value };
    value.catch(() => (this.combos = null));
    return value;
  }

  /** Fetches the given events now, so the first visitor does not wait. */
  async warm(tickers: string[]): Promise<void> {
    for (const t of tickers) await this.getEvent(t).catch(() => null);
    await this.listCombos().catch(() => []);
  }
}
