/**
 * Relayer command line.
 *
 *   npm run cli -w relayer -- setup [--treasury 100000]   create mock USDC, initialize the program, fund the treasury
 *   npm run cli -w relayer -- discover [--category Politics] [--search text] [--limit 30]
 *   npm run cli -w relayer -- mirror [--config path]      create the markets listed in the mirror config
 *   npm run cli -w relayer -- status                      on-chain markets next to Gemini's prices
 *   npm run cli -w relayer -- serve                       HTTP API + polling loops
 */
import { join } from "node:path";
import { PPM, UNIT, probPpm } from "@parilayer/sdk";
import { Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { SolanaChain } from "./chain";
import { type Config, loadConfig, loadKeypair, loadMirrorConfig, loadPairsConfig } from "./config";
import { CachedGemini } from "./gemini/cached";
import { GeminiHttp, GeminiMock, type GeminiSource } from "./gemini/client";
import { Indexer } from "./indexer";
import { midPrice } from "./mapping";
import { PairService } from "./pairs";
import { Relayer } from "./relayer";
import { buildServer } from "./server";
import { AuditLog, Store } from "./store";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);

function geminiSource(cfg: Config): { source: GeminiSource; mock: GeminiMock | undefined } {
  if (cfg.mock) {
    const mock = new GeminiMock(cfg.fixturesDir);
    return { source: mock, mock };
  }
  return { source: new GeminiHttp(), mock: undefined };
}

function chainFor(cfg: Config, withAdmin: boolean): SolanaChain {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  let admin = null;
  if (withAdmin) {
    try {
      admin = loadKeypair(cfg.adminKeypairPath);
    } catch {
      admin = null;
    }
  }
  return new SolanaChain(connection, loadKeypair(cfg.oracleKeypairPath), admin);
}

function relayerFor(cfg: Config, chain: SolanaChain, source: GeminiSource) {
  const store = new Store(join(cfg.dataDir, "relayer.sqlite"));
  const audit = new AuditLog(join(cfg.dataDir, "audit.jsonl"));
  const relayer = new Relayer({ gemini: source, chain, store, audit, seedUsdc: cfg.seedUsdc, log });
  return { relayer, store, audit };
}

async function setup(cfg: Config) {
  const chain = chainFor(cfg, true);
  if (!chain.admin) throw new Error(`setup needs the admin keypair at ${cfg.adminKeypairPath}`);
  const conn = chain.connection;
  const adminSol = (await conn.getBalance(chain.admin.publicKey)) / LAMPORTS_PER_SOL;
  log(`admin  ${chain.admin.publicKey.toBase58()}  ${adminSol.toFixed(3)} SOL`);

  // The oracle pays rent for every market it creates; keep it funded from the admin.
  const oracleSol = (await conn.getBalance(chain.oracle.publicKey)) / LAMPORTS_PER_SOL;
  if (oracleSol < 0.5 && adminSol > 1.5) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: chain.admin.publicKey, toPubkey: chain.oracle.publicKey, lamports: 1 * LAMPORTS_PER_SOL }),
    );
    await sendAndConfirmTransaction(conn, tx, [chain.admin], { commitment: "confirmed" });
    log("sent 1 SOL from admin to oracle");
  }
  log(`oracle ${chain.oracle.publicKey.toBase58()}  ${((await conn.getBalance(chain.oracle.publicKey)) / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

  const existing = await chain.getConfig();
  let usdcMint = existing?.usdcMint;
  if (!usdcMint) {
    const { mint, created } = await chain.ensureMockUsdc(loadKeypair(cfg.usdcMintKeypairPath));
    usdcMint = mint;
    log(`${created ? "created" : "found"} mock USDC mint ${mint.toBase58()}`);
  }
  // Fees: buy 1% to the treasury, sell 2% kept in the pot.
  const initialized = await chain.ensureInitialized(usdcMint, 100, 200);
  log(initialized ? "initialized program config (buy fee 1%, sell fee 2%)" : "program config already initialized");
  if (!initialized && (await chain.ensureFees(100, 200))) log("updated fees to buy 1%, sell 2%");

  const target = Number(flag("treasury") ?? 100_000);
  const added = await chain.topUpTreasury(target);
  log(`treasury vault holds ${(await chain.treasuryBalance()) / UNIT} USDC${added > 0n ? ` (minted ${added / UNIT})` : ""}`);
}

async function discover(cfg: Config) {
  const { source } = geminiSource(cfg);
  const limit = Number(flag("limit") ?? 30);
  const page = await source.listEvents({
    status: "active",
    ...(flag("category") ? { category: flag("category")! } : {}),
    ...(flag("search") ? { search: flag("search")! } : {}),
    limit,
  });
  console.log(`${page.data.length} of ${page.pagination.total} active events\n`);
  for (const e of page.data) {
    const mids = e.contracts.map((c) => midPrice(c.prices));
    const sum = mids.reduce<number>((a, m) => a + (m ?? 0), 0);
    const n = e.contracts.length;
    let hint: string;
    if (n === 1) hint = `{"kind":"binary","event":"${e.ticker}","contract":"${e.contracts[0]!.instrumentSymbol}"}`;
    else if (e.type === "categorical" && n >= 3 && n <= 32 && sum >= 0.85 && sum <= 1.15) hint = `{"kind":"multi","event":"${e.ticker}"}  (check the contracts really are mutually exclusive)`;
    else if (e.type === "categorical" && n >= 2 && n <= 31 && sum < 0.85) hint = `{"kind":"multi","event":"${e.ticker}","addOther":true}  (only if mutually exclusive) or binary-all`;
    else hint = `{"kind":"binary-all","event":"${e.ticker}"}  or one contract as binary`;
    console.log(`${e.ticker}  [${e.type}, ${e.category}]  ${e.title}`);
    console.log(`  ${n} contract(s), YES prices sum to ${sum.toFixed(2)}, expires ${e.expiryDate ?? "n/a"}, volume ${e.volume ?? "n/a"}`);
    console.log(`  suggest: ${hint}\n`);
  }
}

async function mirror(cfg: Config) {
  const { source } = geminiSource(cfg);
  const chain = chainFor(cfg, false);
  const { relayer } = relayerFor(cfg, chain, source);
  const mirrorCfg = loadMirrorConfig(flag("config") ?? cfg.mirrorConfigPath);
  const { results, errors } = await relayer.mirror(mirrorCfg.markets, mirrorCfg.seedUsdc ?? cfg.seedUsdc);
  for (const r of results) {
    console.log(`\n${r.status.toUpperCase()}  ${r.plan.title}  (${r.plan.kind})\n  market ${r.address}\n  id ${r.idHex}`);
    r.plan.outcomes.forEach((label, i) =>
      console.log(`    ${label.padEnd(28)} Gemini ${pct(r.plan.geminiProbs[i])}   seeded ${pct(r.plan.probsPpm[i]! / PPM)}`),
    );
  }
  for (const e of errors) console.error(`\nFAILED  ${e}`);
  if (errors.length) process.exitCode = 1;
}

async function status(cfg: Config) {
  const { source } = geminiSource(cfg);
  const chain = chainFor(cfg, false);
  const { relayer, store } = relayerFor(cfg, chain, source);
  await relayer.refresh();
  const onChain = new Map((await chain.listMarkets()).map((m) => [m.idHex, m]));
  console.log(`treasury: ${(await chain.treasuryBalance()) / UNIT} USDC, ${onChain.size} market(s) on-chain\n`);
  for (const meta of store.listMarkets()) {
    const m = onChain.get(meta.idHex);
    const ref = relayer.reference(meta.idHex);
    console.log(`${meta.title}  [${meta.kind}] ${m ? `${m.status}, pot ${m.pot / UNIT} USDC` : "NOT ON CHAIN"}`);
    meta.outcomes.forEach((label, i) => {
      const pool = m ? probPpm(m.q, i) / PPM : null;
      console.log(`    ${label.padEnd(28)} pool ${pct(pool)}   Gemini ${pct(ref?.normalized[i])}`);
    });
    console.log();
  }
}

async function serve(cfg: Config) {
  const { source, mock } = geminiSource(cfg);
  const chain = chainFor(cfg, true);
  const { relayer, store } = relayerFor(cfg, chain, source);
  // The pair builder reads many events per page; cache them for a minute and
  // keep the cache warm so pages load in well under a second.
  const pairGemini = new CachedGemini(source);
  const pairEvents = () => [
    ...new Set([
      ...store.listMarkets().flatMap((m) => (m.source.type === "binary" ? [m.source.eventTicker] : [])),
      ...loadPairsConfig(cfg.pairsConfigPath).flatMap((p) => [p.a.event, p.b.event]),
    ]),
  ];
  const warm = () => void pairGemini.warm(pairEvents()).catch(() => undefined);
  warm();
  setInterval(warm, 50_000).unref();
  const app = await buildServer({
    relayer,
    store,
    chain,
    rpcUrl: cfg.rpcUrl,
    seedUsdc: cfg.seedUsdc,
    ...(chain.admin ? { faucet: { usdc: cfg.faucetUsdc, cooldownMs: 60 * 60 * 1000, drip: (w, usdc) => chain.faucet(w, usdc) } } : {}),
    ...(mock ? { mock } : {}),
    pairs: {
      service: new PairService({ relayer, gemini: pairGemini, chain, store, seedUsdc: cfg.seedUsdc }),
      curated: loadPairsConfig(cfg.pairsConfigPath),
      gemini: pairGemini,
    },
  });
  await app.listen({ port: cfg.port, host: cfg.host });
  log(`relayer listening on http://${cfg.host}:${cfg.port}  (Gemini: ${cfg.mock ? "MOCK fixtures" : "live"}, RPC: ${cfg.rpcUrl})`);
  relayer.start(cfg.referencePollMs, cfg.settlementPollMs);
  const indexer = new Indexer(chain.connection, store, log);
  indexer.start(cfg.indexerPollMs);
  const shutdown = () => {
    relayer.stop();
    indexer.stop();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const commands: Record<string, (cfg: Config) => Promise<void>> = { setup, discover, mirror, status, serve };

const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`usage: cli <${Object.keys(commands).join("|")}> [options]`);
  process.exit(2);
}
run(loadConfig()).catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
