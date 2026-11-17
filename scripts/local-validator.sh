#!/usr/bin/env bash
# Runs a local Solana validator with the PMEC program loaded, for development
# and offline demos. Leave it running; stop it with Ctrl-C.
#
#   ./scripts/local-validator.sh            # ledger in .local-ledger (reset every start)
#
# Ports are moved off the defaults that often clash with other software:
# RPC 8899, gossip 18000, faucet 19900.
set -euo pipefail
cd "$(dirname "$0")/.."

SO=target/deploy/pmec.so
[ -f "$SO" ] || { echo "Build the program first: anchor build" >&2; exit 1; }
PROGRAM_ID=$(python3 -c "import json;print(json.load(open('packages/sdk/src/idl/pmec.json'))['address'])")

# --limit-ledger-size keeps transaction history around; the default prunes it
# within minutes, which empties the trade tape.
exec solana-test-validator --reset --quiet --limit-ledger-size 50000000 \
  --ledger "${LOCAL_LEDGER:-.local-ledger}" \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --rpc-port 8899 --gossip-port 18000 --dynamic-port-range 18001-18040 --faucet-port 19900
