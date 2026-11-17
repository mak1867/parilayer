import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "./constants";

const find = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const configPda = () => find([SEEDS.config]);
export const treasuryPda = () => find([SEEDS.treasury]);
export const marketPda = (marketId: Uint8Array) => find([SEEDS.market, marketId]);
export const vaultPda = (market: PublicKey) => find([SEEDS.vault, market.toBytes()]);
export const outcomeMintPda = (market: PublicKey, i: number) => find([SEEDS.mint, market.toBytes(), Uint8Array.of(i)]);
export const seedSharesPda = (market: PublicKey, i: number) =>
  find([SEEDS.seedShares, market.toBytes(), Uint8Array.of(i)]);
