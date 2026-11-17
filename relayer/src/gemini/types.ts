/**
 * The parts of Gemini's prediction-markets API this relayer reads.
 *
 * Field names and meanings come from Gemini's OpenAPI spec
 * (https://developer.gemini.com/specs/openapi/prediction-markets.yaml) and were
 * checked against live responses recorded in ../../fixtures. Only documented
 * fields are typed here; everything else in a response is ignored.
 */

/** Documented status enum, shared by events and contracts. */
export type GeminiStatus = "approved" | "active" | "closed" | "under_review" | "settled" | "invalid";

export interface GeminiPrices {
  /** Decimal strings in dollars, 0..1. Absent when that side of the book is empty. */
  bestBid?: string | null;
  bestAsk?: string | null;
  lastTradePrice?: string | null;
}

export interface GeminiContract {
  id: string;
  /** Human-readable label of the contract's YES proposition. */
  label: string;
  ticker: string;
  /** The tradable symbol. Never build this from other strings; read it. */
  instrumentSymbol: string;
  status: GeminiStatus;
  /** Trading state of the contract. */
  marketState?: "open" | "closed" | null;
  prices?: GeminiPrices | null;
  /** Set once the contract is settled. */
  resolutionSide?: "yes" | "no" | null;
  resolvedAt?: string | null;
  settlementValue?: string | null;
  expiryDate?: string | null;
  sortOrder?: number | null;
}

export interface GeminiEvent {
  id: string;
  title: string;
  ticker: string;
  /** "categorical" does NOT imply the contracts are mutually exclusive. */
  type: "binary" | "categorical";
  category: string;
  status: GeminiStatus;
  contracts: GeminiContract[];
  expiryDate?: string | null;
  resolvedAt?: string | null;
  volume?: string | null;
}

export interface GeminiEventsPage {
  data: GeminiEvent[];
  pagination: { limit: number; offset: number; total: number };
}

export interface GeminiComboLeg {
  legIndex: number;
  requiredOutcome: "Yes" | "No";
  contract?: { instrumentSymbol?: string; contractName?: string } | null;
}

export interface GeminiCombo {
  contract: {
    contractName: string;
    /** Ticker of the combo's own event; its price is read from that event. */
    eventTicker: string;
    instrumentSymbol?: string;
    contractStatus?: string;
  };
  legs: GeminiComboLeg[];
}

export interface GeminiCombosPage {
  combos: GeminiCombo[];
  pagination: { limit: number; offset: number; total: number };
}

/** A fetched event together with the exact bytes Gemini sent, for the audit log. */
export interface EventWithRaw {
  event: GeminiEvent;
  raw: string;
}
