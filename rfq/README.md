# RFQ prototype (not used by the live app)

A working prototype of trader-to-trader trading, kept for the roadmap's
midpoint cross. PariLayer's live build exits through selling back to the pool
instead.

- A holder opts in as a quoter for a market by signing a message; the server checks the share balance on-chain.
- A requester asks for a two-sided quote (market, outcome, size) without saying whether they buy or sell.
- Quoters answer privately for 10 seconds; the requester sees only the best bid and ask, then picks a side.
- The server builds one transaction that swaps shares for USDC; both parties check it and sign; it settles atomically or not at all. The server holds no keys.
- Fills go on a public tape. Not signing an accepted quote counts as a failure; three in an hour trigger a cooldown.

```sh
npm run serve -w rfq                          # the RFQ service on :8788
BOT_KEYPAIR=keys/bot.json npm run bot -w rfq  # optional: a bot that quotes every request
npm test -w rfq                               # unit and wire tests
```
