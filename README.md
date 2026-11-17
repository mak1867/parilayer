# PMEC Exchange

A Solana devnet prediction market built for UBC 2026 (Track 02, DeFi & Onchain Apps).

It prices outcomes with Pennock's dynamic parimutuel market maker using the cost
function `C(q) = ||q||_2`, seeds every market at Gemini Predictions prices, settles
on Gemini's resolutions, and adds a discreet trader-to-trader secondary market.

**The property:** the pool price of a share is at most 1 USDC (before the 1% pool
fee), and a winning share pays at least 1 USDC, whatever happens after you buy.

Status: under construction. See [PROGRESS.md](PROGRESS.md) for what works today
and [the build spec](PMEC%20Exchange%20%E2%80%94%20Build%20Spec.md) for the plan.
A full README (architecture, trust assumptions, prior art) lands with milestone M7.

## Layout

| Path | What |
| --- | --- |
| `crates/pmec-math` | Pure integer pool math and its property tests |
| `programs/pmec` | The Anchor program (Solana devnet) and its integration tests |
| `packages/sdk` | Shared TypeScript: program interface (IDL), addresses, instruction builders, the pool math in BigInt |
| `relayer` | Gemini relayer: mirrors events as markets, posts resolutions, serves reference prices, indexes trades, mock-USDC faucet |
| `rfq` | Secondary market: private request-for-quote over WebSocket, atomic settlement, public trade tape, quoter bot |
| `web` | Next.js frontend: markets, market page with pool / Gemini / secondary prices, buy slip, portfolio |
| `scripts` | Local validator and setup scripts |

## Run the tests

Needs Rust, the Solana CLI 4.1.x, Anchor 1.2.x and Node 22.

```sh
anchor test               # builds the program, then runs every Rust test
cargo test -p pmec-math   # just the math
npm install
npm test                  # SDK, relayer and RFQ tests
E2E_RPC_URL=http://127.0.0.1:8899 npm test -w rfq   # also runs the RFQ end-to-end tests on a local validator
```

## Run the relayer

Keys live in `keys/` (git-ignored) and are loaded by path from `.env`; see `.env.example`.

```sh
npm run cli -w relayer -- setup      # mock USDC mint, program config, fund the treasury
npm run cli -w relayer -- discover --category Politics
npm run cli -w relayer -- mirror     # create the markets in relayer/config/mirror.json at Gemini's prices
npm run cli -w relayer -- status     # pool odds next to Gemini's
npm run serve -w relayer             # HTTP API on :8787 + reference and settlement polling
```

Set `GEMINI_MOCK=1` to serve Gemini data from the recorded fixtures instead of the network.

## Run the secondary market

```sh
npm run serve -w rfq                          # RFQ service on :8788 (needs no keys)
BOT_KEYPAIR=keys/bot.json npm run bot -w rfq  # optional: a bot that quotes every request
```

## Run the frontend

```sh
cp web/.env.example web/.env.local   # RPC and relayer URLs (public values only)
npm run dev -w web                   # http://localhost:3000
```

Connect any Solana wallet set to devnet, or pick "Burner wallet" (a throwaway devnet
wallet made in your browser), then use "Get test USDC" in the wallet menu.

## Run everything on a local validator

```sh
anchor build
./scripts/local-validator.sh                      # terminal 1
./scripts/local-setup.sh                          # terminal 2 (GEMINI_MOCK=1 for offline)
SOLANA_RPC_URL=http://127.0.0.1:8899 RELAYER_DATA_DIR=relayer/data-local npm run serve -w relayer
SOLANA_RPC_URL=http://127.0.0.1:8899 RFQ_DATA_DIR=rfq/data-local npm run serve -w rfq
NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899 npm run dev -w web
```
