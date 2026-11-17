/**
 * RFQ service entry point.
 *
 *   npm run serve -w rfq
 *
 * Environment: SOLANA_RPC_URL (default devnet), RFQ_PORT (default 8788),
 * RFQ_DATA_DIR (default rfq/data). It needs no keys: it only reads the chain
 * and relays transactions the traders signed themselves.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import { SolanaRfqChain } from "./chain";
import { buildRfqServer } from "./server";
import { RfqStore } from "./store";

const ROOT = resolve(import.meta.dirname, "..", "..");
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const port = Number(process.env.RFQ_PORT || 8788);
const dataDir = process.env.RFQ_DATA_DIR || "rfq/data";
const dbPath = join(isAbsolute(dataDir) ? dataDir : join(ROOT, dataDir), "rfq.sqlite");

const server = await buildRfqServer(new SolanaRfqChain(new Connection(rpcUrl, "confirmed")), new RfqStore(dbPath));
await server.app.listen({ port, host: "127.0.0.1" });
console.log(`[${new Date().toISOString().slice(11, 19)}] RFQ service on http://127.0.0.1:${port} (WebSocket /ws, RPC ${rpcUrl})`);

const shutdown = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
