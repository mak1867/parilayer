import { sha256 } from "@noble/hashes/sha256";

/**
 * Deterministic market id: sha256 of the sorted Gemini refs joined by "|".
 * Sorting makes a pair's id independent of leg order, so the same two
 * contracts can never become two pools.
 */
export function marketIdFromRefs(refs: readonly string[]): Uint8Array {
  if (refs.length === 0) throw new Error("need at least one ref");
  for (const r of refs) {
    if (r.length === 0 || r.includes("|")) throw new Error(`bad ref: ${JSON.stringify(r)}`);
  }
  const sorted = [...refs].sort();
  return sha256(new TextEncoder().encode(sorted.join("|")));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
