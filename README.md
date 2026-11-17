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
| `idl/pmec.json` | The program's interface, for the TypeScript services |

## Run the tests

Needs Rust, the Solana CLI 4.1.x and Anchor 1.2.x.

```sh
anchor test          # builds the program, then runs every Rust test
cargo test -p pmec-math   # just the math
```
