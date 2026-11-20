#!/bin/sh
# Starts the relayer in a container.
#
# Keys: the host stores them as secrets ORACLE_KEYPAIR_JSON and ADMIN_KEYPAIR_JSON
# (the JSON array from the keypair file). They are written to files readable only
# by this process, because the relayer loads keys from paths and never logs them.
# ADMIN_KEYPAIR_JSON is optional: without it the faucet is off.
#
# Data: RELAYER_DATA_DIR should be a persistent volume. If it has no database yet,
# it starts from the snapshot in relayer/deploy/seed/ when one was built in.
set -eu
umask 077
mkdir -p /run/keys "$RELAYER_DATA_DIR"
[ -n "${ORACLE_KEYPAIR_JSON:-}" ] && printf '%s' "$ORACLE_KEYPAIR_JSON" > "$ORACLE_KEYPAIR"
[ -n "${ADMIN_KEYPAIR_JSON:-}" ] && printf '%s' "$ADMIN_KEYPAIR_JSON" > "$ADMIN_KEYPAIR"
unset ORACLE_KEYPAIR_JSON ADMIN_KEYPAIR_JSON
if [ ! -f "$RELAYER_DATA_DIR/relayer.sqlite" ] && [ -f relayer/deploy/seed/relayer.sqlite ]; then
  cp relayer/deploy/seed/relayer.sqlite "$RELAYER_DATA_DIR/relayer.sqlite"
  echo "started from the seed database"
fi
exec node_modules/.bin/tsx relayer/src/cli.ts serve
