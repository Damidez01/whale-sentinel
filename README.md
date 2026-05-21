# 🛡 WhaleSentinel v2

Crypto incident detection system. Focuses on confirmed suspicious patterns — not noise.

## Modules

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
Midgard polling every 15 seconds.

| Alert | Trigger |
|---|---|
| 🟠 HIGH — Large Swap | ETH/stables → BTC or BTC → ETH/stables > $500K |
| 🚨 CRITICAL — Burst | 3+ swaps same wallet in 30 min |

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
