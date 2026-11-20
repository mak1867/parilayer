import type { NextConfig } from "next";

const config: NextConfig = {
  // The SDK is a TypeScript workspace package consumed from source.
  transpilePackages: ["@parilayer/sdk"],
  // Do not write a generated AGENTS.md into the project.
  agentRules: false,
  turbopack: {
    resolveAlias: {
      // The Anchor client's browser build still mentions Node's fs (for loading
      // a wallet file); give the browser an empty module instead.
      fs: { browser: "./src/lib/empty.ts" },
    },
  },
};

export default config;
