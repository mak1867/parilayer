"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { useMemo, type ReactNode } from "react";
import { BurnerWalletAdapter } from "@/lib/burner";
import { DataProvider } from "@/lib/data";
import { RPC_URL } from "@/lib/env";

export function Providers({ children }: { children: ReactNode }) {
  // Browser wallets that support the Wallet Standard (Phantom, Solflare, Backpack...)
  // are detected automatically; the burner wallet is added for people without one.
  const wallets = useMemo(() => [new BurnerWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <DataProvider>{children}</DataProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
