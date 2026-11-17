/** Public endpoints. Nothing secret is ever read by the frontend. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const RELAYER_URL = (process.env.NEXT_PUBLIC_RELAYER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
export const RFQ_URL = (process.env.NEXT_PUBLIC_RFQ_URL || "http://127.0.0.1:8788").replace(/\/$/, "");
export const IS_LOCAL_RPC = /127\.0\.0\.1|localhost/.test(RPC_URL);

/** Link to a transaction on Solana Explorer for the configured cluster. */
export function explorerTx(signature: string): string {
  const cluster = IS_LOCAL_RPC ? `custom&customUrl=${encodeURIComponent(RPC_URL)}` : "devnet";
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}
