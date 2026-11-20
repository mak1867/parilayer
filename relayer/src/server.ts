import cors from "@fastify/cors";
import { PROGRAM_ID } from "@pmec/sdk";
import { PublicKey } from "@solana/web3.js";
import Fastify, { type FastifyInstance } from "fastify";
import type { ChainApi } from "./chain";
import type { GeminiMock, GeminiSource } from "./gemini/client";
import { type CuratedPair, type LegRef, PairError, type PairService, legChoices } from "./pairs";
import type { Relayer } from "./relayer";
import type { MarketMeta, Store } from "./store";

export interface ServerDeps {
  relayer: Relayer;
  store: Store;
  chain: ChainApi;
  rpcUrl: string;
  seedUsdc: number;
  /** Present only when a faucet is available (admin key loaded). */
  faucet?: { usdc: number; cooldownMs: number; drip: (wallet: PublicKey, usdc: number) => Promise<{ signature: string; sol: number }> };
  /** Present only in mock mode: lets a demo simulate Gemini settling a contract. */
  mock?: GeminiMock;
  /** Pair joint pools. */
  pairs?: { service: PairService; curated: CuratedPair[]; gemini: GeminiSource };
}

const HEX64 = /^[0-9a-f]{64}$/;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  const view = (meta: MarketMeta) => ({ ...meta, reference: deps.relayer.reference(meta.idHex) });

  app.get("/health", async () => ({
    ok: true,
    mock: !!deps.mock,
    markets: deps.store.listMarkets().length,
    lastRefresh: deps.relayer.lastRefreshAt || null,
  }));

  /** Everything a client needs to talk to the chain. */
  app.get("/config", async () => {
    const cfg = await deps.chain.getConfig();
    return {
      programId: PROGRAM_ID.toBase58(),
      rpcUrl: deps.rpcUrl,
      usdcMint: cfg?.usdcMint.toBase58() ?? null,
      oracle: cfg?.oracle.toBase58() ?? null,
      poolFeeBps: cfg?.poolFeeBps ?? null,
      sellFeeBps: cfg?.sellFeeBps ?? null,
      seedUsdc: deps.seedUsdc,
      faucet: deps.faucet ? { usdc: deps.faucet.usdc } : null,
      mock: !!deps.mock,
    };
  });

  /** Names, outcome labels and Gemini references for every mirrored market. */
  app.get("/markets", async () => deps.store.listMarkets().map(view));

  app.get<{ Params: { id: string } }>("/markets/:id", async (req, reply) => {
    const meta = HEX64.test(req.params.id) ? deps.store.getMarket(req.params.id) : null;
    if (!meta) return reply.code(404).send({ error: "unknown market" });
    return view(meta);
  });

  /** Gemini's price per outcome. For pair pools also the product of the legs and Gemini's combo price. */
  app.get<{ Params: { id: string } }>("/reference/:id", async (req, reply) => {
    const meta = HEX64.test(req.params.id) ? deps.store.getMarket(req.params.id) : null;
    const ref = meta ? deps.relayer.reference(meta.idHex) : null;
    if (!meta || !ref) return reply.code(404).send({ error: "unknown market" });
    return {
      marketId: meta.idHex,
      asOf: ref.asOf,
      outcomes: meta.outcomes.map((label, i) => ({
        index: i,
        label,
        gemini: ref.prices[i] ?? null,
        geminiNormalized: ref.normalized[i] ?? null,
      })),
      ...(ref.pair ? { pair: ref.pair } : {}),
    };
  });

  /** Pool trade tape: recent buys and redemptions, newest first. `market` is a market id (hex). */
  app.get<{ Querystring: { market?: string; limit?: string } }>("/activity", async (req, reply) => {
    let market: string | undefined;
    if (req.query.market) {
      const meta = HEX64.test(req.query.market) ? deps.store.getMarket(req.query.market) : null;
      if (!meta) return reply.code(404).send({ error: "unknown market" });
      market = meta.address;
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 500));
    return deps.store.listTrades({ ...(market ? { market } : {}), limit });
  });

  /** What a wallet bought from the pool and redeemed, per market and outcome (for cost basis). */
  app.get<{ Params: { wallet: string } }>("/positions/:wallet", async (req, reply) => {
    try {
      new PublicKey(req.params.wallet);
    } catch {
      return reply.code(400).send({ error: "wallet must be a Solana address" });
    }
    return deps.store.positionHistory(req.params.wallet);
  });

  /** Mock USDC for a wallet, once per cooldown. */
  app.post<{ Body: { wallet?: string } }>("/faucet", async (req, reply) => {
    if (!deps.faucet) return reply.code(503).send({ error: "faucet is not enabled on this relayer" });
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(req.body?.wallet ?? "");
    } catch {
      return reply.code(400).send({ error: "wallet must be a Solana address" });
    }
    const key = wallet.toBase58();
    const last = deps.store.lastFaucet(key);
    const now = Date.now();
    if (last !== null && now - last < deps.faucet.cooldownMs) {
      return reply.code(429).send({ error: "faucet already used recently", retryInMs: deps.faucet.cooldownMs - (now - last) });
    }
    // Record first so parallel requests cannot both pass the cooldown check.
    deps.store.recordFaucet(key, now);
    try {
      const { signature, sol } = await deps.faucet.drip(wallet, deps.faucet.usdc);
      return { signature, usdc: deps.faucet.usdc, sol };
    } catch (e) {
      deps.store.recordFaucet(key, last ?? 0);
      return reply.code(502).send({ error: `faucet transaction failed: ${(e as Error).message}` });
    }
  });

  if (deps.pairs) {
    const { service, curated, gemini } = deps.pairs;
    const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) =>
      e instanceof PairError ? reply.code(e.status).send({ error: e.message }) : reply.code(502).send({ error: `Could not reach Gemini or the chain: ${(e as Error).message}` });

    /** Curated correlated pairs with live leg prices, seed odds and Gemini's combo price. */
    app.get("/pairs/curated", async () => service.curated(curated));

    /** Contracts that can be a leg: every tradable contract of the events behind our binary markets. */
    app.get("/pairs/legs", async () => {
      const events = deps.store.listMarkets().flatMap((m) => (m.source.type === "binary" ? [m.source.eventTicker] : []));
      return legChoices(gemini, events);
    });

    /** What the pool over two legs would be, or is. Creates nothing. */
    app.post<{ Body: { a?: LegRef; b?: LegRef } }>("/pairs/preview", async (req, reply) => {
      try {
        return await service.preview(req.body?.a as LegRef, req.body?.b as LegRef);
      } catch (e) {
        return fail(reply, e);
      }
    });

    /** Step 1 of creating a pair: returns the first-buy transaction for the buyer to sign. */
    app.post<{ Body: { a?: LegRef; b?: LegRef; buyer?: string; outcome?: number; usdcIn?: string } }>("/pairs/prepare", async (req, reply) => {
      try {
        const b = req.body ?? {};
        return await service.prepare(b.a as LegRef, b.b as LegRef, b.buyer ?? "", Number(b.outcome), b.usdcIn ?? "");
      } catch (e) {
        return fail(reply, e);
      }
    });

    /** Step 2: the signed first buy comes back; the pool is created and the buy submitted. */
    app.post<{ Body: { prepareId?: string; tx?: string } }>("/pairs", async (req, reply) => {
      try {
        const out = await service.create(req.body?.prepareId ?? "", req.body?.tx ?? "");
        await deps.relayer.refresh();
        return out;
      } catch (e) {
        return fail(reply, e);
      }
    });
  }

  if (deps.mock) {
    const mock = deps.mock;
    app.post<{ Body: { ticker?: string; instrumentSymbol?: string; side?: string } }>("/mock/settle", async (req, reply) => {
      const { ticker, instrumentSymbol, side } = req.body ?? {};
      if (!ticker || !instrumentSymbol || (side !== "yes" && side !== "no")) {
        return reply.code(400).send({ error: "need ticker, instrumentSymbol and side (yes|no)" });
      }
      try {
        mock.settle(ticker, instrumentSymbol, side);
      } catch (e) {
        return reply.code(404).send({ error: (e as Error).message });
      }
      await deps.relayer.refresh();
      return { ok: true, reports: await deps.relayer.settleOnce() };
    });
  }

  return app;
}
