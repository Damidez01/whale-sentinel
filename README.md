# 🛡 WhaleSentinel v2

Crypto incident detection system. Focuses on confirmed suspicious patterns — not noise.

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
| 🚨 CRITICAL — Escalation | Every 5 deposits after the 10th |
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

The supplied ChangeNOW/FixedFloat wallet watchlist now supports ETH/USDC/USDT/DAI on Ethereum and USDT/TRX on TRON. See [EXCHANGE-WATCH.md](EXCHANGE-WATCH.md) for its separate >=$50k x 3 / 15-minute rule, filtered feeds, provider costs and TronGrid setup.

The original bot now includes persistent `/block`, `/unblock`, `/mute`, reply-to-alert controls, and Telegram delivery retries. A separate >$50k × 5 / 30-minute accumulation rule runs alongside the existing rule. See [TELEGRAM-CONTROLS.md](TELEGRAM-CONTROLS.md) for deployment variables, volume requirements, and exact behavior.
