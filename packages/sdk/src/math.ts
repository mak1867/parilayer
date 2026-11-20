/**
 * The pool math in BigInt, mirroring crates/parilayer-math bit for bit.
 *
 * Cost function C(q) = ||q||_2. All amounts are base units (1e6 = 1 USDC = 1 share).
 * Every rounding goes against the trader: shares round down, fees round up,
 * payouts round down. test/vectors.json (generated from the Rust crate) pins
 * the two implementations together.
 */
import {
  BPS,
  MAX_FEE_BPS,
  MAX_OUTCOMES,
  MAX_POT,
  MAX_PROB_PPM,
  MIN_PROB_PPM,
  MIN_SEED,
  PPM,
  RATE_SCALE,
  UNIT,
} from "./constants";

export class MathError extends Error {
  constructor(public readonly code: MathErrorCode) {
    super(code);
    this.name = "MathError";
  }
}

export type MathErrorCode =
  | "Overflow"
  | "BadOutcome"
  | "BadOutcomeCount"
  | "BadProbabilities"
  | "ZeroAmount"
  | "SeedTooSmall"
  | "PotCapExceeded"
  | "BadFee"
  | "EmptyPool"
  | "InvariantViolated"
  | "NotEnoughShares"
  | "BelowSeed";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/** Integer square root, rounded down (Newton's method). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new MathError("Overflow");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** ||q||^2, exact. */
export function sumSquares(q: readonly bigint[]): bigint {
  let s = 0n;
  for (const qi of q) s += qi * qi;
  if (s > U128_MAX) throw new MathError("Overflow");
  return s;
}

export function normCeil(q: readonly bigint[]): bigint {
  const s = sumSquares(q);
  const r = isqrt(s);
  return r * r === s ? r : r + 1n;
}

/** True when pot >= C(q). */
export function potCoversCost(pot: bigint, q: readonly bigint[]): boolean {
  return pot * pot >= sumSquares(q);
}

export function validateProbs(probsPpm: readonly number[]): void {
  if (probsPpm.length < 2 || probsPpm.length > MAX_OUTCOMES) throw new MathError("BadOutcomeCount");
  let sum = 0;
  for (const p of probsPpm) {
    if (!Number.isInteger(p) || p < MIN_PROB_PPM || p > MAX_PROB_PPM) throw new MathError("BadProbabilities");
    sum += p;
  }
  if (sum !== PPM) throw new MathError("BadProbabilities");
}

/** q_i = floor(seed * sqrt(pi_i)). Costs at most `seed`. */
export function seedShares(probsPpm: readonly number[], seed: bigint): bigint[] {
  validateProbs(probsPpm);
  if (seed < MIN_SEED) throw new MathError("SeedTooSmall");
  if (seed > MAX_POT) throw new MathError("PotCapExceeded");
  const s2 = seed * seed;
  return probsPpm.map((p) => isqrt((s2 * BigInt(p)) / BigInt(PPM)));
}

/** Splits a gross payment into [net, fee]. The fee rounds up. */
export function splitFee(usdcIn: bigint, feeBps: number): [bigint, bigint] {
  if (feeBps > MAX_FEE_BPS || feeBps < 0) throw new MathError("BadFee");
  const fee = (usdcIn * BigInt(feeBps) + BPS - 1n) / BPS;
  return [usdcIn - fee, fee];
}

/** Shares of outcome i minted for x base units (fee already removed). */
export function sharesForBuy(q: readonly bigint[], i: number, x: bigint): bigint {
  if (i < 0 || i >= q.length) throw new MathError("BadOutcome");
  if (x === 0n) throw new MathError("ZeroAmount");
  const s2 = sumSquares(q);
  if (s2 === 0n) throw new MathError("EmptyPool");
  const r = isqrt(s2);
  const nCeil = r * r === s2 ? r : r + 1n;
  if (nCeil + x > MAX_POT) throw new MathError("PotCapExceeded");
  // N with `half` fractional bits, exactly as the Rust code does with u128.
  const leadingZeros = 128 - bitLength(s2);
  const shift = leadingZeros & ~1;
  const half = BigInt(shift / 2);
  const nScaled = isqrt(s2 << BigInt(shift));
  const cross = (2n * x * nScaled) >> half;
  const qi = q[i]!;
  const qiNew = isqrt(qi * qi + cross + x * x);
  const delta = qiNew - qi;
  if (delta > U64_MAX) throw new MathError("Overflow");
  return delta;
}

/** ceil(sqrt(n)). */
function isqrtCeil(n: bigint): bigint {
  const r = isqrt(n);
  return r * r === n ? r : r + 1n;
}

/**
 * USDC the pool gives back for `s` shares of outcome i, before the sell fee:
 * R = N - sqrt(N^2 - q_i^2 + (q_i - s)^2), rounded down, exactly as the Rust crate.
 */
export function sellRefund(q: readonly bigint[], i: number, s: bigint): bigint {
  if (i < 0 || i >= q.length) throw new MathError("BadOutcome");
  if (s === 0n) throw new MathError("ZeroAmount");
  const qi = q[i]!;
  if (s > qi) throw new MathError("NotEnoughShares");
  const s2 = sumSquares(q);
  const rest = qi - s;
  const s2New = s2 - qi * qi + rest * rest;
  const shift = (128 - bitLength(s2)) & ~1;
  const half = BigInt(shift / 2);
  const nOld = isqrt(s2 << BigInt(shift));
  const nNew = isqrtCeil(s2New << BigInt(shift));
  const r = nOld > nNew ? (nOld - nNew) >> half : 0n;
  if (r > U64_MAX) throw new MathError("Overflow");
  return r;
}

/** Pool price of one share of outcome i, in base units (1e6 = 1 USDC). <= 1 USDC. */
export function priceE6(q: readonly bigint[], i: number): bigint {
  if (i < 0 || i >= q.length) throw new MathError("BadOutcome");
  const n = normCeil(q);
  if (n === 0n) throw new MathError("EmptyPool");
  return (q[i]! * UNIT) / n;
}

/** Implied probability in ppm: q_i^2 / ||q||^2. */
export function probPpm(q: readonly bigint[], i: number): number {
  if (i < 0 || i >= q.length) throw new MathError("BadOutcome");
  const s2 = sumSquares(q);
  if (s2 === 0n) throw new MathError("EmptyPool");
  return Number((q[i]! * q[i]! * BigInt(PPM)) / s2);
}

/** Payout per winning share, scaled 1e12. */
export function payoutRateE12(pot: bigint, qWinner: bigint): bigint {
  if (qWinner === 0n) throw new MathError("EmptyPool");
  return (pot * RATE_SCALE) / qWinner;
}

/** Void price per share for each outcome, scaled 1e12. */
export function voidRatesE12(q: readonly bigint[]): bigint[] {
  const n = normCeil(q);
  if (n === 0n) throw new MathError("EmptyPool");
  return q.map((qi) => (qi * RATE_SCALE) / n);
}

/** USDC paid for burning `amount` shares at `rateE12`, rounded down. */
export function redeemValue(amount: bigint, rateE12: bigint): bigint {
  return (amount * rateE12) / RATE_SCALE;
}

export interface BuyQuote {
  /** Shares minted to the buyer. */
  shares: bigint;
  /** USDC added to the pot. */
  net: bigint;
  /** USDC sent to the treasury. */
  fee: bigint;
  priceAfterE6: bigint;
  probAfterPpm: number;
  /** Share counts and pot after the buy. */
  qAfter: bigint[];
  potAfter: bigint;
}

/** What a buy would do. Does not mutate its inputs. */
export function quoteBuy(
  q: readonly bigint[],
  pot: bigint,
  outcome: number,
  usdcIn: bigint,
  feeBps: number,
): BuyQuote {
  if (outcome < 0 || outcome >= q.length) throw new MathError("BadOutcome");
  const [net, fee] = splitFee(usdcIn, feeBps);
  if (net === 0n) throw new MathError("ZeroAmount");
  const potAfter = pot + net;
  if (potAfter > MAX_POT) throw new MathError("PotCapExceeded");
  const shares = sharesForBuy(q, outcome, net);
  if (shares === 0n) throw new MathError("ZeroAmount");
  const qAfter = q.slice();
  qAfter[outcome] = qAfter[outcome]! + shares;
  if (!potCoversCost(potAfter, qAfter)) throw new MathError("InvariantViolated");
  return {
    shares,
    net,
    fee,
    priceAfterE6: priceE6(qAfter, outcome),
    probAfterPpm: probPpm(qAfter, outcome),
    qAfter,
    potAfter,
  };
}

export interface SellQuote {
  /** USDC paid to the seller (refund minus fee). */
  usdcOut: bigint;
  /** Refund before the fee. */
  gross: bigint;
  /** Sell fee, kept in the pot. */
  fee: bigint;
  priceAfterE6: bigint;
  probAfterPpm: number;
  qAfter: bigint[];
  potAfter: bigint;
}

/**
 * What selling `shares` of `outcome` back to the pool would do. `seedFloor` is
 * the outcome's seed shares (no sell may go below it). Does not mutate inputs.
 */
export function quoteSell(
  q: readonly bigint[],
  pot: bigint,
  outcome: number,
  shares: bigint,
  feeBps: number,
  seedFloor: bigint,
): SellQuote {
  if (outcome < 0 || outcome >= q.length) throw new MathError("BadOutcome");
  const qi = q[outcome]!;
  if (shares > qi) throw new MathError("NotEnoughShares");
  if (qi - shares < seedFloor) throw new MathError("BelowSeed");
  const gross = sellRefund(q, outcome, shares);
  const [usdcOut, fee] = splitFee(gross, feeBps);
  if (usdcOut === 0n) throw new MathError("ZeroAmount");
  if (usdcOut > pot) throw new MathError("InvariantViolated");
  const potAfter = pot - usdcOut;
  const qAfter = q.slice();
  qAfter[outcome] = qi - shares;
  if (!potCoversCost(potAfter, qAfter)) throw new MathError("InvariantViolated");
  return {
    usdcOut,
    gross,
    fee,
    priceAfterE6: priceE6(qAfter, outcome),
    probAfterPpm: probPpm(qAfter, outcome),
    qAfter,
    potAfter,
  };
}
