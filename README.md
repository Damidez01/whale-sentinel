# 🛡 WhaleSentinel v2

Crypto incident detection system. Focuses on confirmed suspicious patterns — not noise.

## Quieter alert updates

Tornado pool activity alerts initially at three deposits in 15 minutes, then at
10, 20, 30, etc. deposits in 60 minutes. The burst and incident windows are
tracked separately. Pool activity does not establish a common source.

General fan-out, rapid accumulation and exchange accumulation now alert at their
initial threshold, then when either the count reaches 10, 20, 30, etc. or the
rolling USD total reaches twice the total at the last alert. Both triggers on
the same event produce one update; every update establishes a new value baseline.
Value updates still require the initial count threshold to be satisfied.
Counts and values still use each rule's rolling
window. Reaching the same milestone again after a count dips does not repeat an
alert. An hour without qualifying activity resets the milestone sequence.
Fan-out groups by sending wallet; accumulation by receiving wallet; exchange
routes retain their original-source/hot-wallet grouping. Primary and additional
accumulation share milestones. These remain separate Telegram updates, not edits
to an earlier message. THORChain and Hyperunit keep their existing doubling rules.
Exchange milestones persist atomically with their scan state. General EVM and
Tornado milestones use the existing KV store, checkpointed every 30 seconds;
an abrupt crash can lose the latest checkpoint interval.

## NEAR Intents WBTC outflows

The user-supplied Ethereum hot wallet
`0x2CfF890f0378a11913B6129B2E97417a2c302680` is watched for outgoing canonical
WBTC (`0x2260fac5e5542a773aa44fbcfedf7c193bc2c599`, 8 decimals) worth at least
$100,000 per transaction and recipient. Transfers to different recipients never combine. Multiple
logs in one transaction to the same recipient combine once. Separate transactions
below $100,000 do not combine to qualify. The first qualifying receipt alerts;
subsequent receipts for that wallet update only when its tracked qualifying USD
total doubles since the last alert, or its 15-minute rolling receipt count reaches
3, 10, 20, 30, etc. Both triggers together send one update. Every update resets
the value baseline. Total value accumulates through the active session; it is not
a 15-minute value window. Reached count milestones do not repeat when counts dip.
One hour without a qualifying receipt resets the session, using blockchain event
times. Sub-threshold transfers do not extend it. Counts, totals, milestones and
baselines persist atomically with the scan cursor and survive restart. Alerts show
the latest transaction, tracked total, session start and update reason.
The alert identifies
the recipient and Ethereum transaction; it does not infer a matched NEAR Intents
operation, original depositor, or theft.

Enabled by default with `ALCHEMY_ETH_WSS`; optional
`NEAR_INTENTS_ENABLED=false` disables it and `NEAR_INTENTS_MIN_USD` changes the
threshold. Uses existing WBTC pricing, Ethereum block feed, 12-confirmation
default, and exchange polling/range settings. Requests outgoing WBTC logs only.
State is `near-intents-state.json` on the existing Telegram data volume.
Fresh installs start at the confirmed head; stale cursors skip backlog. The
existing 30-minute freshness limit, durable Telegram delivery, blocked wallets
and persisted dedup apply. No extra API key is needed.

## Restarts and alert freshness

The bot monitors recent activity rather than replaying days of missed transfers.
`ALERT_MAX_AGE_MIN` defaults to `30` (must be a positive number). Chainflip,
THORChain, Hyperunit and exchange monitors suppress events older than this limit.
Time-based scanners clamp old saved positions to this recent window; an Ethereum
exchange scanner with a stale saved block resumes after the latest confirmed block.
Chainflip resolves a recent block before scanning, including on a fresh deployment.

Telegram drops expired queued messages before delivery, including after a restart
or rate-limit delay. New monitored alerts carry the original event time; legacy
Telegram entries expire using their saved enqueue time. Legacy Chainflip, THORChain,
Hyperunit and exchange alerts without an event timestamp are discarded from both
monitor and Telegram queues because their freshness cannot be verified.
Wallet blocks and deduplication records are preserved. No Railway state-file deletion
is required. Alerts with event timestamps display event time separately from send time.

## Modules

Dormancy alerts verify Ethereum outgoing transaction history through Etherscan V2
using the existing `ETHERSCAN_API_KEY`. A successful transfer above
`DORMANT_MIN_USD` (default $500k) qualifies only when the immediately preceding
sender nonce is at least `DORMANT_MONTHS` (default six 30-day months) older.
Small sends, zero-value contract calls and failed transactions count as outgoing
activity. This works after a restart without waiting six months for local history.
It does not claim absence of incoming transfers or activity on other chains.
First-time senders do not qualify. Missing keys or incomplete history suppress the
alert; indexing/API failures retry twice at 15-second intervals and then log a
warning. Each lookup is bounded to five pages of 100 normal transactions.

Chainflip vault alerts describe ETH inflows/outflows only. They do not infer the
other swap asset or claim a completed BTC conversion from a vault transfer alone.

### 1. Tornado Cash Monitor
Direct Deposit event listener on Ethereum mainnet.

| Alert | Trigger |
|---|---|
| 🟠 HIGH — Burst | 3+ deposits to same pool in 15 min |
| 🚨 CRITICAL — Incident | 10+ deposits to same pool in 60 min |
| 🚨 CRITICAL — Escalation | 20, 30, 40, etc. deposits |
| 🚨 CRITICAL — Coordinated | Volume spike across multiple depositors |

Pools watched:
- `0xA160cdAB225685dA1d56aa342Ad8841c3b53f291` — 100 ETH pool
- `0x910cbd523d972eb0a6f4cae4618ad62622b39dbf` — 10 ETH pool

### 2. THORChain Monitor
Midgard polling every 60 seconds, with persistent progress, pagination and pending-swap retries. Enabled by default; see [THORCHAIN.md](THORCHAIN.md) for settings.

| Alert | Trigger |
|---|---|
| Large Swap | Ethereum ETH/WETH/USDT/USDC/DAI ↔ native BTC, ≥ $500K |
| Burst | 3+ qualifying swaps, same Ethereum wallet and direction, in 30 min |

### 3. EVM Monitor
Pending transaction stream on ETH, Base, Arbitrum.

| Alert | Trigger |
|---|---|
| 🚨 CRITICAL — TC Deposit | Direct ETH send to TC pool |
| 🟠 HIGH — Structuring | 5+ txns just under $1M in 10 min |
| 🟠 HIGH — Dormant Wallet | Wallet silent 6+ months moves >$500K |
| 🚨 CRITICAL — Bridge Exit | Flagged wallet bridges to L2 |

### 4. Flagged Wallet Intelligence
- Any TC deposit → wallet flagged 48hrs
- Hop tracking: recipient of flagged wallet → flagged 24hrs
- Persists across restarts (saved to `data/flagged.json`)

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill in your Alchemy WSS URLs, Telegram token, chat ID

# 3. Run locally
npm run dev

# 4. Deploy to Railway
# Push to GitHub → Railway → New Project → Deploy from GitHub
# Add all .env vars in Railway Variables tab
```

## Project structure

```
src/
  index.js                 # entry point
  monitors/
    tornado.js             # TC pool event listener
    thorchain.js           # Midgard poller
    evm.js                 # EVM pending tx stream
  intelligence/
    flagged.js             # wallet registry (persists to disk)
  alerts/
    telegram.js            # message builder + sender
  utils/
    prices.js              # CoinGecko price cache
    store.js               # in-memory sliding windows
    logger.js              # file + console logging
data/
  flagged.json             # persisted flagged wallets (auto-created)
logs/
  sentinel_YYYY-MM-DD.log  # daily log files
```
# Telegram controls and additional accumulation

The ChangeNOW/FixedFloat wallet watchlist supports USDC/USDT/DAI on Ethereum and USDT/TRX on TRON. One-hop tracing groups fresh deposit-address forwards by their original funding wallet. Native ETH is excluded from this exchange watcher. See [EXCHANGE-WATCH.md](EXCHANGE-WATCH.md) for the >=$50k x 3 / 15-minute rule, evidence requirements, provider costs and TronGrid setup.

The original bot now includes persistent `/block`, `/unblock`, `/mute`, reply-to-alert controls, and Telegram delivery retries. A separate >$50k × 5 / 30-minute accumulation rule runs alongside the existing rule. See [TELEGRAM-CONTROLS.md](TELEGRAM-CONTROLS.md) for deployment variables, volume requirements, and exact behavior.
