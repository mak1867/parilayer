import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import "./globals.css";

// Big Shoulders: a condensed signage face, used for the board's numbers and headings.
const board = Big_Shoulders({ subsets: ["latin"], variable: "--font-board", display: "swap", adjustFontFallback: false });
const text = Instrument_Sans({ subsets: ["latin"], variable: "--font-text", display: "swap" });

export const metadata: Metadata = {
  title: { default: "PariLayer", template: "%s | PariLayer" },
  description:
    "A Solana devnet prediction market where a share costs at most 1 USDC and a winning share pays at least 1 USDC. Seeded and settled by Gemini Predictions.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0F3D2E" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${board.variable} ${text.variable}`}>
      <body>
        <Providers>
          <a className="skip" href="#main">
            Skip to content
          </a>
          <Header />
          <main id="main">{children}</main>
          <footer className="site-footer">
            <p>
              PariLayer runs on Solana devnet with test USDC. Markets are seeded at Gemini Predictions prices and settled on
              Gemini’s resolutions by a trusted relayer. Built for UBC 2026.
            </p>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
