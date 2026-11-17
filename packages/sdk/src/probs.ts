import { MAX_OUTCOMES, MAX_PROB_PPM, MIN_PROB_PPM, PPM } from "./constants";

/**
 * Turns raw outcome weights (e.g. Gemini mid prices) into seed probabilities:
 * normalize to sum 1, clamp each to [0.5%, 99.5%], renormalize, and return
 * integers in ppm that sum to exactly 1,000,000.
 *
 * Clamping is done by "water-filling": outcomes that fall under the floor are
 * pinned to it and the rest share what is left in proportion, repeated until
 * nothing is under the floor. That way every result respects the clamp exactly.
 */
export function clampNormalize(weights: readonly number[]): number[] {
  const n = weights.length;
  if (n < 2 || n > MAX_OUTCOMES) throw new Error(`need 2..${MAX_OUTCOMES} outcomes, got ${n}`);
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new Error("weights must be finite and >= 0");
  const total = weights.reduce((a, b) => a + b, 0);
  // No information at all: fall back to uniform.
  const base = total > 0 ? weights.map((w) => w / total) : weights.map(() => 1 / n);

  const lo = MIN_PROB_PPM / PPM;
  const pinned = new Array<boolean>(n).fill(false);
  let probs = base.slice();
  for (let round = 0; round < n; round++) {
    const pinnedCount = pinned.filter(Boolean).length;
    const freeMass = base.reduce((a, p, i) => (pinned[i] ? a : a + p), 0);
    const remaining = 1 - pinnedCount * lo;
    probs = base.map((p, i) => (pinned[i] ? lo : freeMass > 0 ? (p / freeMass) * remaining : remaining / (n - pinnedCount)));
    let changed = false;
    probs.forEach((p, i) => {
      if (!pinned[i] && p < lo) {
        pinned[i] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }

  // To integers: floor, never below the floor, then give the remainder to the largest.
  const ppm = probs.map((p) => Math.max(MIN_PROB_PPM, Math.floor(p * PPM)));
  let diff = PPM - ppm.reduce((a, b) => a + b, 0);
  const order = ppm.map((_, i) => i).sort((a, b) => ppm[b]! - ppm[a]!);
  // diff is tiny (at most n in magnitude); spread it over the largest entries.
  for (let k = 0; diff !== 0 && k < 4 * n; k++) {
    const i = order[k % n]!;
    const step = diff > 0 ? 1 : -1;
    const next = ppm[i]! + step;
    if (next >= MIN_PROB_PPM && next <= MAX_PROB_PPM) {
      ppm[i] = next;
      diff -= step;
    }
  }
  if (diff !== 0 || ppm.some((p) => p < MIN_PROB_PPM || p > MAX_PROB_PPM)) {
    throw new Error("could not clamp probabilities");
  }
  return ppm;
}

/**
 * Joint probabilities of two binary legs, assuming independence, in the pair
 * pool's outcome order: index = 2*a + b (a, b = 1 for YES) -> [NN, NY, YN, YY].
 */
export function pairWeights(pA: number, pB: number): [number, number, number, number] {
  return [(1 - pA) * (1 - pB), (1 - pA) * pB, pA * (1 - pB), pA * pB];
}
