#!/usr/bin/env bash
# Prepares a running local validator (see local-validator.sh): funds the admin
# and oracle wallets, creates mock USDC, initializes the program, funds the
# treasury and mirrors the markets in the mirror config.
#
#   ./scripts/local-setup.sh                 # live Gemini prices
#   GEMINI_MOCK=1 ./scripts/local-setup.sh   # recorded fixtures, no network
set -euo pipefail
cd "$(dirname "$0")/.."

export SOLANA_RPC_URL=http://127.0.0.1:8899
export RELAYER_DATA_DIR="${RELAYER_DATA_DIR:-relayer/data-local}"
export NODE_NO_WARNINGS=1

for i in $(seq 1 60); do
  solana cluster-version -u "$SOLANA_RPC_URL" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "No validator at $SOLANA_RPC_URL. Start ./scripts/local-validator.sh first." >&2; exit 1; }
  sleep 1
done

for key in keys/admin.json keys/oracle.json; do
  [ -f "$key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$key" >/dev/null
  solana airdrop 100 "$(solana-keygen pubkey "$key")" -u "$SOLANA_RPC_URL" >/dev/null
done
[ -f keys/usdc-mint.json ] || solana-keygen new --no-bip39-passphrase --silent -o keys/usdc-mint.json >/dev/null

rm -rf "$RELAYER_DATA_DIR"
npm run -s cli -w relayer -- setup
npm run -s cli -w relayer -- mirror "$@"
echo
echo "Local chain is ready. Start the services with the same settings:"
echo "  SOLANA_RPC_URL=$SOLANA_RPC_URL RELAYER_DATA_DIR=$RELAYER_DATA_DIR npm run serve -w relayer"
echo "  NEXT_PUBLIC_RPC_URL=$SOLANA_RPC_URL npm run dev -w web"
