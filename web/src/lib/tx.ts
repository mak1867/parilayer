import type { WalletContextState } from "@solana/wallet-adapter-react";
import { type Connection, Transaction, type TransactionInstruction } from "@solana/web3.js";

/** Program error names mapped to what a person should read. */
const FRIENDLY: Record<string, string> = {
  SlippageExceeded: "The price moved past your slippage limit before the buy landed. Nothing was spent; try again.",
  MarketNotOpen: "This market is not open for buying right now.",
  MintsNotReady: "This market is still being set up. Try again in a moment.",
  ZeroAmount: "That amount is too small to buy a share.",
  PotCapExceeded: "That buy would push the pot over its cap.",
  NotWinningOutcome: "Only the winning outcome's shares can be redeemed.",
  MarketNotSettled: "This market has not been resolved yet.",
};

/** Turns a wallet/RPC error into one plain sentence. */
export function explainError(e: unknown): string {
  const err = e as { message?: string; logs?: string[]; transactionLogs?: string[] };
  const logs = (err.logs ?? err.transactionLogs ?? []).join("\n");
  const text = `${err.message ?? ""}\n${logs}`;
  const code = /Error Code: (\w+)/.exec(text)?.[1];
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  const anchorMsg = /Error Message: ([^\n]+?)\.?(\n|$)/.exec(text)?.[1];
  if (anchorMsg) return anchorMsg;
  if (/insufficient funds/i.test(text)) return "Not enough USDC in this wallet for that.";
  if (/insufficient lamports|Attempt to debit an account but found no record/i.test(text)) {
    return "This wallet has no SOL to pay the network fee. Use “Get test USDC” to receive some.";
  }
  if (/User rejected|rejected the request/i.test(text)) return "You declined the request in your wallet.";
  if (/block height exceeded|expired/i.test(text)) return "The network was too slow and the transaction expired. Nothing was spent; try again.";
  return err.message?.split("\n")[0] ?? "Something went wrong sending the transaction.";
}

/** Builds, signs, sends and confirms one transaction from the connected wallet. */
export async function sendIxs(connection: Connection, wallet: WalletContextState, ixs: TransactionInstruction[]): Promise<string> {
  if (!wallet.publicKey) throw new Error("Connect a wallet first.");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  const signature = await wallet.sendTransaction(tx, connection);
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  return signature;
}
