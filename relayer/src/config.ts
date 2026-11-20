import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { MirrorEntry } from "./mapping";

/** Repo root (the relayer lives one level below it). */
export const ROOT = resolve(import.meta.dirname, "..", "..");

const fromRoot = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));

export interface Config {
  rpcUrl: string;
  /** Interface to listen on: 127.0.0.1 locally, 0.0.0.0 in a container. */
  host: string;
  port: number;
  /** Serve Gemini data from recorded fixtures instead of the network. */
  mock: boolean;
  fixturesDir: string;
  dataDir: string;
  mirrorConfigPath: string;
  pairsConfigPath: string;
  /** Seed per market in whole USDC. */
  seedUsdc: number;
  oracleKeypairPath: string;
  adminKeypairPath: string;
  usdcMintKeypairPath: string;
  /** Mock USDC handed out per faucet request, in whole USDC. */
  faucetUsdc: number;
  referencePollMs: number;
  settlementPollMs: number;
  indexerPollMs: number;
}

/** Reads settings from the environment (and the repo's .env, if present). Secrets are file paths, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dotenv = join(ROOT, ".env");
  if (env === process.env && existsSync(dotenv)) process.loadEnvFile(dotenv);
  const num = (name: string, fallback: number) => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return n;
  };
  return {
    rpcUrl: env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    host: env.RELAYER_HOST || "127.0.0.1",
    // Hosts such as Render and Fly pass the port in PORT.
    port: num("RELAYER_PORT", num("PORT", 8787)),
    mock: env.GEMINI_MOCK === "1" || env.GEMINI_MOCK === "true",
    fixturesDir: fromRoot(env.GEMINI_FIXTURES_DIR || "relayer/fixtures"),
    dataDir: fromRoot(env.RELAYER_DATA_DIR || "relayer/data"),
    mirrorConfigPath: fromRoot(env.MIRROR_CONFIG || "relayer/config/mirror.json"),
    pairsConfigPath: fromRoot(env.PAIRS_CONFIG || "relayer/config/pairs.json"),
    seedUsdc: num("SEED_USDC", 500),
    oracleKeypairPath: fromRoot(env.ORACLE_KEYPAIR || "keys/oracle.json"),
    adminKeypairPath: fromRoot(env.ADMIN_KEYPAIR || "keys/admin.json"),
    usdcMintKeypairPath: fromRoot(env.USDC_MINT_KEYPAIR || "keys/usdc-mint.json"),
    faucetUsdc: num("FAUCET_USDC", 1000),
    referencePollMs: num("REFERENCE_POLL_MS", 30_000),
    settlementPollMs: num("SETTLEMENT_POLL_MS", 60_000),
    indexerPollMs: num("INDEXER_POLL_MS", 10_000),
  };
}

/** Loads a Solana keypair file. The key never leaves this process and is never logged. */
export function loadKeypair(path: string): Keypair {
  if (!existsSync(path)) throw new Error(`keypair file not found: ${path}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export interface MirrorConfig {
  /** Overrides SEED_USDC for these markets. */
  seedUsdc?: number;
  markets: MirrorEntry[];
}

export function loadMirrorConfig(path: string): MirrorConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as MirrorConfig;
  if (!Array.isArray(cfg.markets)) throw new Error(`${path}: "markets" must be a list`);
  for (const m of cfg.markets) {
    if (!["binary", "binary-all", "multi"].includes(m.kind) || typeof m.event !== "string") {
      throw new Error(`${path}: bad entry ${JSON.stringify(m)}`);
    }
    if (m.kind === "binary" && typeof m.contract !== "string") throw new Error(`${path}: binary entry needs "contract"`);
  }
  return cfg;
}

/** Curated correlated pairs for the pair builder. A missing file means none. */
export function loadPairsConfig(path: string): { a: { event: string; contract: string }; b: { event: string; contract: string }; note?: string }[] {
  if (!existsSync(path)) return [];
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { pairs?: unknown };
  if (!Array.isArray(cfg.pairs)) throw new Error(`${path}: "pairs" must be a list`);
  return cfg.pairs as { a: { event: string; contract: string }; b: { event: string; contract: string }; note?: string }[];
}
