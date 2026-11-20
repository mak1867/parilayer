import { PPM, UNIT } from "@parilayer/sdk";

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

/** Base units (6 decimals) to a number. Fine for display; never use for math. */
export const toNumber = (units: bigint) => Number(units) / Number(UNIT);

/** "1,234.56" */
export function fmtUsdc(units: bigint, decimals = 2): string {
  return nf(decimals, decimals).format(toNumber(units));
}

/** Shares with up to 2 decimals, e.g. "158.21". */
export function fmtShares(units: bigint): string {
  return nf(2, 2).format(toNumber(units));
}

/** A whole-number-friendly USDC amount, e.g. pot sizes: "12,340". */
export function fmtWhole(units: bigint): string {
  return nf(0, 0).format(toNumber(units));
}

/** Probability 0..1 to "38.8%". */
export function fmtPct(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "–";
  return `${(p * 100).toFixed(digits)}%`;
}

export const ppmToProb = (ppm: number) => ppm / PPM;

/** A price in USDC per share (1e6 base units = 1 USDC) to "0.623". */
export function fmtPrice(priceE6: bigint | number | null | undefined, digits = 3): string {
  if (priceE6 === null || priceE6 === undefined) return "–";
  return (Number(priceE6) / 1e6).toFixed(digits);
}

/** Parses what a person typed ("100", "12.5") into base units; null if not a valid amount. */
export function parseAmount(text: string): bigint | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d*(\.\d{0,6})?$/.test(t) || t === "" || t === ".") return null;
  const [whole = "0", frac = ""] = t.split(".");
  return BigInt(whole || "0") * UNIT + BigInt(frac.padEnd(6, "0"));
}

export function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
