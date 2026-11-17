import { ed25519 } from "@noble/curves/ed25519";
import {
  BaseMessageSignerWalletAdapter,
  WalletNotConnectedError,
  WalletReadyState,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { Keypair, type PublicKey, type Transaction, type TransactionVersion, type VersionedTransaction } from "@solana/web3.js";

export const BURNER_NAME = "Burner wallet" as WalletName<"Burner wallet">;
const STORAGE_KEY = "pmec:burner-wallet";

const ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0F3D2E"/><path d="M9 21V11h9a5 5 0 0 1 0 10z" fill="none" stroke="#F0B429" stroke-width="2.5"/></svg>',
  );

/**
 * A throwaway devnet wallet kept in this browser's localStorage, so anyone can
 * try the app without installing a wallet extension. Devnet only: it holds
 * nothing of value and must never be used with real funds.
 */
export class BurnerWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = BURNER_NAME;
  url = "https://github.com/mak1867/pmec-exchange";
  icon = ICON;
  supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set<TransactionVersion>(["legacy", 0]);

  private keypair: Keypair | null = null;
  private _connecting = false;

  get publicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get readyState(): WalletReadyState {
    return typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Installed;
  }

  async connect(): Promise<void> {
    if (this.keypair || this._connecting) return;
    this._connecting = true;
    try {
      // Yield once so listeners attached in the same tick still hear "connect".
      await Promise.resolve();
      let keypair: Keypair | null = null;
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved) as number[]));
      } catch {
        keypair = null;
      }
      if (!keypair) {
        keypair = Keypair.generate();
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keypair.secretKey)));
        } catch {
          // Private mode: the wallet lives for this tab only.
        }
      }
      this.keypair = keypair;
      this.emit("connect", keypair.publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    if (!this.keypair) throw new WalletNotConnectedError();
    if ("version" in transaction) transaction.sign([this.keypair]);
    else transaction.partialSign(this.keypair);
    return transaction;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.keypair) throw new WalletNotConnectedError();
    return ed25519.sign(message, this.keypair.secretKey.slice(0, 32));
  }
}
