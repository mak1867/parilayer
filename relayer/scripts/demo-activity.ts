/**
 * Generates realistic demo activity on the exchange: a handful of bot wallets
 * buy and sell in the live markets and open the curated pair pools.
 *
 *   npm run demo -w relayer -- --steps 40 --delay 1500 [--bots 5] [--hunch 0.35]
 *
 * How the bots behave, so the result looks like a market and not noise:
 * - Most buys lean toward Gemini: a bot buys the outcome whose pool odds are
 *   furthest below Gemini's, which is what an arbitrageur would do.
 * - Some buys are opinions: a random outcome weighted by Gemini's odds, 10-80 USDC.
 * - Sometimes a bot sells part of a position back to the pool.
 * - Gap-closing buys are sized to close about 60% of the gap (up to 5,000
 *   USDC), so the pool converges toward Gemini without overshooting.
 *
 * Needs the relayer running (RELAYER_URL, default http://127.0.0.1:8787) and
 * the admin keypair, which funds the bots with SOL and mock USDC. Bot keys are
 * kept in keys/demo-bots.json (git-ignored) so reruns reuse the same wallets.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  UNIT,
  ata,
  buyIxs,
  fetchConfig,
  fetchMarket,
  getProgram,
  outcomeMintPda,
  probPpm,
  quoteBuy,
  quoteSell,
  seedSharesPda,
  sellIxs,
} from "@pmec/sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { loadConfig, loadKeypair } from "../src/config";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const STEPS = Number(flag("steps") ?? 30);
const DELAY_MS = Number(flag("delay") ?? 1500);
const BOTS = Number(flag("bots") ?? 5);
/** Share of buys that are opinions rather than gap-closing trades. */
const HUNCH = Number(flag("hunch") ?? 0.35);
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:8787";

const cfg = loadConfig();
const connection = new Connection(cfg.rpcUrl, "confirmed");
const program = getProgram(connection);
const admin = loadKeypair(cfg.adminKeypairPath);
// Next to the admin key, in the git-ignored keys/ folder.
const BOT_FILE = join(dirname(cfg.adminKeypairPath), "demo-bots.json");
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const usdc = (x: bigint) => (Number(x) / Number(UNIT)).toFixed(2);

interface MarketMeta {
  idHex: string;
  address: string;
  kind: string;
  title: string;
  outcomes: string[];
  reference: { normalized: (number | null)[] } | null;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${RELAYER}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path}: HTTP ${res.status}`);
  return json;
}

function loadBots(): Keypair[] {
  const saved: number[][] = existsSync(BOT_FILE) ? JSON.parse(readFileSync(BOT_FILE, "utf8")) : [];
  while (saved.length < BOTS) saved.push(Array.from(Keypair.generate().secretKey));
  writeFileSync(BOT_FILE, JSON.stringify(saved));
  return saved.slice(0, BOTS).map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
}

async function send(ixs: TransactionInstruction[], signer: Keypair): Promise<string> {
  return sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
}

/** Tops every bot up to 0.05 SOL and 5,000 mock USDC (the admin is the mint authority). */
async function fund(bots: Keypair[], usdcMint: PublicKey) {
  for (const bot of bots) {
    const ixs: TransactionInstruction[] = [];
    const sol = await connection.getBalance(bot.publicKey);
    if (sol < 0.03 * LAMPORTS_PER_SOL) {
      ixs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: bot.publicKey, lamports: 0.06 * LAMPORTS_PER_SOL - sol }));
    }
    const acct = ata(usdcMint, bot.publicKey);
    const have = await connection
      .getTokenAccountBalance(acct)
      .then((b) => BigInt(b.value.amount))
      .catch(() => 0n);
    if (have < 2_000n * UNIT) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, acct, bot.publicKey, usdcMint));
      ixs.push(createMintToInstruction(usdcMint, acct, admin.publicKey, 5_000n * UNIT - have));
    }
    if (ixs.length) {
      await send(ixs, admin);
      log(`funded bot ${bot.publicKey.toBase58().slice(0, 6)}`);
    }
  }
}

async function balance(account: PublicKey): Promise<bigint> {
  return connection
    .getTokenAccountBalance(account)
    .then((b) => BigInt(b.value.amount))
    .catch(() => 0n);
}

/** Opens each curated pair that has no pool yet, with a first buy on Yes/Yes. */
async function openCuratedPairs(bot: Keypair) {
  const curated = await api<{ exists: boolean; title: string; legRefs: { event: string; contract: string }[]; minFirstBuyUsdc: number }[]>(
    "/pairs/curated",
  );
  for (const c of curated) {
    if (c.exists) continue;
    const usdcIn = BigInt(Math.max(c.minFirstBuyUsdc, 40)) * UNIT;
    const prep = await api<{ prepareId: string; tx: string }>("/pairs/prepare", {
      a: c.legRefs[0],
      b: c.legRefs[1],
      buyer: bot.publicKey.toBase58(),
      outcome: 3,
      usdcIn: usdcIn.toString(),
    });
    const tx = Transaction.from(Buffer.from(prep.tx, "base64"));
    tx.partialSign(bot);
    const out = await api<{ address: string; buySignature: string | null; buyError: string | null }>("/pairs", {
      prepareId: prep.prepareId,
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    });
    log(`opened pair "${c.title}" at ${out.address}${out.buyError ? ` (first buy failed: ${out.buyError})` : ""}`);
  }
}

/** One trade by one bot. Returns a line for the log, or null if it skipped. */
async function step(bot: Keypair, markets: MarketMeta[], usdcMint: PublicKey, feeBuy: number, feeSell: number): Promise<string | null> {
  const meta = markets[Math.floor(Math.random() * markets.length)]!;
  const m = await fetchMarket(program, new PublicKey(meta.address));
  if (!m || m.status !== "open") return null;
  const n = m.q.length;
  const who = bot.publicKey.toBase58().slice(0, 6);

  // Sometimes sell part of a position this bot holds in this market.
  if (Math.random() < 0.3) {
    for (let i = 0; i < n; i++) {
      const held = await balance(ata(outcomeMintPda(m.address, i), bot.publicKey));
      if (held < 5n * UNIT) continue;
      const shares = (held * BigInt(Math.round(rand(20, 100)))) / 100n;
      const seedFloor = await balance(seedSharesPda(m.address, i));
      const q = quoteSell(m.q, m.pot, i, shares, feeSell, seedFloor);
      await send(await sellIxs(program, { seller: bot.publicKey, market: m.address, usdcMint, outcome: i, shares, minUsdcOut: (q.usdcOut * 97n) / 100n }), bot);
      return `${who} sold ${usdc(shares)} ${meta.outcomes[i]} in "${meta.title}" for ${usdc(q.usdcOut)} USDC`;
    }
  }

  // Otherwise buy. Usually the outcome the pool underprices most against Gemini.
  const gem = meta.reference?.normalized ?? [];
  const pool = m.q.map((_, i) => probPpm(m.q, i) / 1e6);
  let outcome: number;
  let why: string;
  const gaps = pool.map((p, i) => (gem[i] ?? p) - p);
  const best = gaps.indexOf(Math.max(...gaps));
  if (Math.random() >= HUNCH && gaps[best]! > 0.01) {
    outcome = best;
    why = `pool ${(pool[best]! * 100).toFixed(1)}% vs Gemini ${((gem[best] ?? 0) * 100).toFixed(1)}%`;
  } else {
    // An opinion: pick an outcome weighted by Gemini's odds (the crowd's view).
    const w = pool.map((p, i) => gem[i] ?? p);
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    outcome = w.findIndex((p) => (r -= p) <= 0);
    if (outcome < 0) outcome = n - 1;
    why = "a hunch";
  }
  // Opinions are small (10-80 USDC). A gap-closing buy is sized exactly, by
  // binary search on the real quote, to close about 60% of the gap, so the
  // pool converges toward Gemini without overshooting.
  let usdcIn: bigint;
  if (why === "a hunch") {
    usdcIn = BigInt(Math.round(Math.exp(rand(Math.log(10), Math.log(80))))) * UNIT;
  } else {
    const target = pool[outcome]! + 0.6 * gaps[outcome]!;
    let lo = 1n;
    let hi = 5_000n;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      const p = quoteBuy(m.q, m.pot, outcome, mid * UNIT, feeBuy).probAfterPpm / 1e6;
      if (p <= target) lo = mid;
      else hi = mid;
    }
    if (lo < 5n) return null;
    usdcIn = lo * UNIT;
  }
  const q = quoteBuy(m.q, m.pot, outcome, usdcIn, feeBuy);
  await send(
    await buyIxs(program, { buyer: bot.publicKey, market: m.address, usdcMint, outcome, usdcIn, minSharesOut: (q.shares * 97n) / 100n }),
    bot,
  );
  return `${who} bought ${usdc(q.shares)} ${meta.outcomes[outcome]} in "${meta.title}" for ${usdc(usdcIn)} USDC (${why})`;
}

async function main() {
  const config = await fetchConfig(program);
  if (!config) throw new Error("program config not initialized");
  const bots = loadBots();
  log(`${bots.length} bots, ${STEPS} steps, relayer ${RELAYER}, RPC ${cfg.rpcUrl}`);
  await fund(bots, config.usdcMint);
  try {
    await openCuratedPairs(bots[0]!);
  } catch (e) {
    log(`curated pairs: ${(e as Error).message}`);
  }
  let done = 0;
  for (let s = 0; s < STEPS; s++) {
    const markets = await api<MarketMeta[]>("/markets");
    const bot = bots[s % bots.length]!;
    try {
      const line = await step(bot, markets, config.usdcMint, config.poolFeeBps, config.sellFeeBps);
      if (line) {
        done++;
        log(line);
      }
    } catch (e) {
      log(`step ${s} skipped: ${(e as Error).message.split("\n")[0]}`);
    }
    await sleep(DELAY_MS);
  }
  log(`${done} trades`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
