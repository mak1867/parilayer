/**
 * Shared pieces of the secondary market (RFQ): the messages wallets sign, the
 * swap terms, and the one function that builds the settlement transaction.
 *
 * Both the RFQ server and the browser build the transaction from the same
 * terms with `buildSwapTx`, so a trader can check that what they are asked to
 * sign is exactly the agreed swap before signing. The server never holds keys
 * and cannot move funds on its own.
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BPS, DECIMALS, UNIT } from "./constants";

/** Smallest RFQ, in share base units: 50 shares. */
export const RFQ_MIN_SIZE = 50n * UNIT;
export const RFQ_QUOTE_WINDOW_MS = 10_000;
export const RFQ_DECIDE_WINDOW_MS = 20_000;
export const RFQ_SIGN_WINDOW_MS = 30_000;

const enc = (s: string) => new TextEncoder().encode(s);

/** Signed once per connection to prove the socket belongs to the wallet. */
export const rfqHelloMessage = (wallet: string, ts: number) => enc(`parilayer-rfq:hello:${wallet}:${ts}`);

/** Signed by a holder to opt in as a quoter for one market. */
export const rfqQuoterMessage = (marketIdHex: string, wallet: string, ts: number) =>
  enc(`parilayer-rfq:quoter:${marketIdHex}:${wallet}:${ts}`);

/** Everything that defines one settlement. All amounts are base-unit strings; keys are base58. */
export interface SwapTerms {
  marketId: string;
  outcome: number;
  shareMint: string;
  usdcMint: string;
  treasuryVault: string;
  seller: string;
  buyer: string;
  /** The wallet that sent the RFQ: pays the network fee and the secondary fee. */
  requester: string;
  /** Wallet that receives the shares: the buyer, or a fresh address the buyer named. */
  receiver: string;
  /** Shares changing hands. */
  size: string;
  /** USDC base units per share. */
  priceE6: string;
  /** USDC the buyer pays the seller. */
  value: string;
  /** Secondary fee the requester pays to the treasury. */
  fee: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** USDC paid for `size` shares at `priceE6`, rounded down. */
export const swapValue = (size: bigint, priceE6: bigint) => (size * priceE6) / UNIT;

/** Secondary fee on a trade value, rounded up. */
export const secondaryFee = (value: bigint, feeBps: number) => (value * BigInt(feeBps) + BPS - 1n) / BPS;

const ataOf = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

/**
 * The settlement transaction: shares from seller to buyer, USDC from buyer to
 * seller, and the secondary fee from the requester to the treasury. One
 * transaction, so either all of it lands or none of it does. Deterministic:
 * the same terms always give the same bytes.
 */
export function buildSwapTx(t: SwapTerms): Transaction {
  const shareMint = new PublicKey(t.shareMint);
  const usdcMint = new PublicKey(t.usdcMint);
  const seller = new PublicKey(t.seller);
  const buyer = new PublicKey(t.buyer);
  const requester = new PublicKey(t.requester);
  const receiver = new PublicKey(t.receiver);
  if (!requester.equals(buyer) && !requester.equals(seller)) throw new Error("requester must be the buyer or the seller");
  if (buyer.equals(seller)) throw new Error("buyer and seller must differ");

  const receiverShares = ataOf(shareMint, receiver);
  const sellerUsdc = ataOf(usdcMint, seller);
  const tx = new Transaction({ feePayer: requester, blockhash: t.blockhash, lastValidBlockHeight: t.lastValidBlockHeight });
  tx.add(
    // The buyer pays to open the receiving share account, the seller their own USDC account, if missing.
    createAssociatedTokenAccountIdempotentInstruction(buyer, receiverShares, receiver, shareMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(seller, sellerUsdc, seller, usdcMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(ataOf(shareMint, seller), shareMint, receiverShares, seller, BigInt(t.size), DECIMALS),
    createTransferCheckedInstruction(ataOf(usdcMint, buyer), usdcMint, sellerUsdc, buyer, BigInt(t.value), DECIMALS),
  );
  if (BigInt(t.fee) > 0n) {
    tx.add(
      createTransferCheckedInstruction(ataOf(usdcMint, requester), usdcMint, new PublicKey(t.treasuryVault), requester, BigInt(t.fee), DECIMALS),
    );
  }
  return tx;
}

/** True when `tx` is byte-for-byte the swap described by `terms`. Check this before signing. */
export function swapTxMatches(tx: Transaction, terms: SwapTerms): boolean {
  try {
    const want = buildSwapTx(terms).serializeMessage();
    const got = tx.serializeMessage();
    return want.length === got.length && want.every((b, i) => b === got[i]);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ wire protocol (JSON over WebSocket)

export type RfqClientMsg =
  | { t: "hello"; wallet: string; ts: number; sig: string }
  | { t: "quoter_on"; marketId: string; ts: number; sig: string; minFillRate?: number }
  | { t: "quoter_off"; marketId: string }
  | { t: "rfq"; marketId: string; outcome: number; size: string }
  | { t: "quote"; rfqId: string; bid?: string; ask?: string; receiver?: string }
  | { t: "accept"; rfqId: string; side: "buy" | "sell"; receiver?: string }
  | { t: "walk"; rfqId: string }
  | { t: "signed"; rfqId: string; tx: string };

export type RfqDoneStatus = "filled" | "expired" | "walked" | "failed" | "no_quoters";

export type RfqServerMsg =
  | { t: "ready"; wallet: string; fillRate: number; cooldownUntil: number | null; minSize: string }
  | { t: "error"; code: string; message: string; rfqId?: string }
  | { t: "quoter_status"; marketId: string; on: boolean; reason?: string }
  /** To a quoter: someone wants a two-sided quote. The direction and the requester are not revealed. */
  | { t: "rfq_request"; rfqId: string; marketId: string; outcome: number; size: string; expiresAt: number }
  /** To a quoter: the RFQ is over for them (their quote was not taken, or it closed). */
  | { t: "rfq_closed"; rfqId: string }
  | { t: "rfq_open"; rfqId: string; marketId: string; outcome: number; size: string; expiresAt: number; quoters: number }
  /** To the requester only, once the quote window closes: the best bid and the best ask. Never who quoted, never the other quotes. */
  | { t: "rfq_quotes"; rfqId: string; bestBid: string | null; bestAsk: string | null; decideBy: number }
  | { t: "sign_request"; rfqId: string; role: "buyer" | "seller"; terms: SwapTerms; tx: string; signBy: number }
  | { t: "rfq_done"; rfqId: string; status: RfqDoneStatus; signature?: string; reason?: string }
  /** Public tape: broadcast to everyone after a fill. */
  | { t: "fill"; fill: RfqFill };

/** One settled secondary trade, as published on the tape. */
export interface RfqFill {
  marketId: string;
  outcome: number;
  priceE6: string;
  size: string;
  ts: number;
  signature: string;
}
