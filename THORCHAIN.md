# THORChain monitoring

Enabled by default. Monitors completed native BTC ↔ Ethereum ETH, WETH, USDT, USDC and DAI swaps. Matches full chain/contract identifiers, excluding synthetic/trade assets and lookalike tokens. Ordinary swaps can qualify; the rule does not prove theft.

Defaults (existing threshold overrides remain supported):

```text
THORCHAIN_ENABLED=true
THORCHAIN_MIN_SWAP_USD=500000
THORCHAIN_BURST_COUNT=3
THORCHAIN_BURST_WINDOW_MIN=30
THORCHAIN_POLL_MS=60000
THORCHAIN_MAX_PAGES=20
THORCHAIN_PENDING_PER_POLL=20
THORCHAIN_FRESH_ONLY=true
THORCHAIN_MAX_PRIOR_SWAPS=2
THORCHAIN_MAX_PRIOR_ETH_TXS=10
THORCHAIN_HISTORY_MAX_PAGES=5
THORCHAIN_ALERT_COOLDOWN_MIN=60
```

No new secret is needed. Uses the public Midgard endpoint in [THORChain's official examples](https://dev.thorchain.org/examples/tutorials.html): `https://gateway.liquify.com/chain/thorchain_midgard/v2`. Optional `THORCHAIN_MIDGARD` and `THORCHAIN_MIDGARD_FALLBACK` override provider order; the working public endpoint is retained as a fallback. URLs should end with `/v2`. Failures back off and log sanitized status, not credentials. Set `THORCHAIN_ENABLED=false` to turn it off.

Large swaps must pass the prior-activity filters below. The first alert per Ethereum wallet starts a one-hour notification period; another alert during that period requires tracked qualifying swap volume to double since the last alert. Volume includes both directions and is gross swap volume, not a net balance. A qualifying update at three or more swaps in the same direction within 30 minutes carries a burst summary. Uses Midgard action timestamps, not polling time. Completed streaming swaps count once by input transaction, not once per outbound fragment. Affiliate outputs are excluded. Ethereum-side wallet links and block controls target the sender for ETH→BTC and receiver for BTC→ETH; transaction links use THORChain's explorer.

## Prior-activity filters

Both checks must pass by default: at most two prior completed THORChain swaps involving the Ethereum-side wallet, and at most ten distinct prior Ethereum transaction hashes across normal, internal, ERC20, ERC721 and ERC1155 history. This includes incoming and outgoing activity. Midgard history counts all swap assets and amounts, not just the monitored BTC pairs or large swaps. It identifies prior involvement of the Ethereum address, not the identity or complete history of a BTC sender.

Checks use the start of the first observed qualifying swap in a burst. Results remain fixed for the configured burst window (30 minutes by default) and persist across restarts, so current swaps do not disqualify that same burst. Later episodes are checked again. Alerts include the observed counts. These checks do not prove wallet age, common ownership, theft, or an absence of activity on other chains.

The filter uses address-scoped Midgard pagination and the existing `ETHERSCAN_API_KEY` for Etherscan V2. No new secret is needed if that key is already configured. Each new assessment uses at most five Midgard history pages and up to five Ethereum history requests. Known excessive counts reject early; capped, invalid or unavailable history never implies zero activity. A full 100-row Ethereum category is deferred unless the returned records already prove excessive activity. Provider/indexer coverage limits still apply.

Unknown assessments persist in `thorHistoryPending` for retry while other wallets continue. At most `THORCHAIN_PENDING_PER_POLL` new assessments run per poll; cached burst assessments avoid extra history queries. The existing `ALERT_MAX_AGE_MIN` freshness limit (30 minutes) bounds scan recovery and pending/history retries. Old unverified THOR alerts are removed from monitor and Telegram queues on upgrade. Missing Etherscan credentials defer alerts under the default filter. Set `THORCHAIN_FRESH_ONLY=false` to disable history filtering; the notification cooldown remains active. Prior-count limits accept zero for first-use-only rules.

Midgard coin amounts use 1e8 precision. Use metadata `inPriceUSD` when valid; otherwise use the existing price service with a 15-minute maximum cached quote. There is no $1 fallback. Missing prices, ambiguous multi-recipient swaps and invalid data retain scan progress and log the reason.

The `/data` volume (or `TELEGRAM_DATA_DIR`) stores `thorchain-state.json`: scan cursor, pending swaps, burst windows, dedup and undelivered alerts. Keep one replica. First start examines roughly the last seven minutes; existing old `store.json` THOR cursors are not migrated. Later polls overlap two minutes and catch up in bounded ten-minute slices with token pagination. Up to 20 pages are read per slice; a page-cap failure preserves progress rather than skipping history. Pending swaps are rechecked by input transaction, at most 20 per poll in rotation, even after the scan cursor passes them. Provider indexing delayed beyond the overlap can still be missed if the pending action was never observed. Completed swap dedup is retained for 30 days; burst history is kept for two days. A delivery interruption across two durable writes can still duplicate an alert.

No Alchemy CU is used for THORChain scans. Midgard and Etherscan have their own availability/rate limits. One scan runs per minute; pages, pending lookups and wallet history checks add HTTP requests. Settlement/indexing time can delay alerts beyond the polling interval. Look for `[THOR] Scan succeeded`; the startup module list alone does not confirm coverage. `filtered` counts newly rejected swaps, `historyErrors` reports deferred checks, and `historyPending` reports swaps still awaiting history verification.

Pagination correction: requests filter `asset=BTC.BTC`, start at the upper timestamp bound and walk backwards using `nextPageToken` until the lower bound. Do not combine this with `fromTimestamp`: that switches Midgard into reverse lookup and can skip the intervening actions. On upgrade, the saved cursor is rewound once by one hour, keeping dedup records intact. Scan logs include `minSwapUsd`, `scanned`, `completed`, `qualifying`, `blocked`, `queued`, and `pendingRetried`. `queued` means handed to the durable Telegram pipeline, not proof Telegram delivery succeeded. Counts describe newly evaluated actions except `scanned`, which includes overlap/dedup candidates.
