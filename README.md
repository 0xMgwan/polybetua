# Polymarket BTC 15m Auto-Trading Bot — DipArb v2

A real-time auto-trading bot for Polymarket **"Bitcoin Up or Down" 15-minute** markets using **hedged pair trading (DipArb)** to lock in guaranteed profits.

## Features

- **Hedged Pair Trading** - Buys both sides cheap to lock in guaranteed profit when pair cost < $1.00
- **Strict Hedging** - Both sides must be ≤35¢ to enter; simulates pair cost before every buy
- **Quantity Balancing** - Forces balanced positions (equal qty on both sides) for guaranteed payoff
- **Profit Locking** - Stops buying once profit is mathematically guaranteed
- **LONG Bias Reduction** - Blocks LONG buys after consecutive Down wins (unless super cheap ≤28¢)
- **Momentum Filter** - Requires ≥0.15% BTC move to filter flat/low-vol windows
- **Position Tracking** - Tracks open positions, P&L, win rate, and streaks
- **Live Dashboard** - Real-time terminal display with window state, pair cost, and guaranteed profit
- **Railway Ready** - Deploy to Railway for 24/7 operation

## How It Works (DipArb v2)

1. Bot monitors Polymarket BTC 15-minute Up/Down markets
2. Waits for one side to become cheap (≤35¢) with BTC momentum (≥0.15% move)
3. **Leg 1**: Buys the cheap side ($3)
4. **Leg 2**: Waits for the other side to become cheap (≤35¢), then buys it ($3)
5. **Profit Lock**: Once min(qtyUp, qtyDown) × $1.00 > totalSpent, stops buying
6. **Resolution**: Market resolves, bot collects guaranteed profit
7. If Leg 2 never fills: unhedged bet (max $3 loss, capped by FIX 7)

## DipArb v2 Rules (7 Fixes)

| Fix | Rule | Value |
|-----|------|-------|
| **1** | Strict Hedging | Both sides ≤$0.35 to buy; simulate pair cost before each buy |
| **2** | Qty Balance | Always buy the side with LOWER qty first |
| **3** | Profit Lock | Stop buying once min(qty) × $1.00 > totalSpent |
| **4** | LONG Bias | Block LONG after 2+ Down wins (unless ≤$0.28) |
| **5** | Wick Filter | Require ≥0.15% BTC move for initial entry |
| **6** | Reduced Frequency | Don't start new positions after minute 7; 45s cooldown |
| **7** | No Piling | Max 1 unhedged buy ($3 risk); then WAIT for hedge or skip |

**Sizing:**
- Per buy: $3
- Per window: $8 max
- Circuit breaker: $15 total open exposure

---

## Quick Start

### Prerequisites

- **Node.js 18+** (https://nodejs.org)
- **Polymarket account** with USDC deposited
- **Wallet private key** (the one connected to your Polymarket account)

### 1. Clone the repository

```bash
git clone https://github.com/0xMgwan/polybetua.git
cd polybetua
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp env.example .env
```

Edit `.env` and set your configuration:

```env
# Required for trading
TRADING_ENABLED=true
TRADING_DRY_RUN=false
PRIVATE_KEY=your_wallet_private_key_here

# DipArb v2 Parameters (defaults shown)
# These are now hardcoded in tradingEngine.js but shown here for reference:
# CHEAP_THRESHOLD=0.35          # Max price to buy any side
# BUY_SIZE_DOLLARS=3            # $3 per buy
# MAX_WINDOW_SPEND=8            # $8 max per window
# MIN_BTC_MOVE_PCT=0.15         # Require 0.15% BTC move for entry
# SKIP_AFTER_MINUTE=7           # Don't start new positions after min 7
# MIN_BUY_COOLDOWN=45000        # 45s between buys
```

> **IMPORTANT:** Never commit your `.env` file. It is already in `.gitignore`.

### 4. Run the bot

```bash
npm start
```

### 5. Stop the bot

Press `Ctrl + C` in the terminal.

---

## Deploy to Railway (24/7)

### 1. Push to GitHub

```bash
git add .
git commit -m "Deploy to Railway"
git push origin main
```

### 2. Create Railway project

1. Go to [railway.app/dashboard](https://railway.app/dashboard)
2. Click **New Project** > **Deploy from GitHub**
3. Select this repository

### 3. Add environment variables

In Railway dashboard > **Variables**, add:

**Required for Trading:**

| Variable | Value | Notes |
|----------|-------|-------|
| `PRIVATE_KEY` | Your wallet private key | Without `0x` prefix |
| `PROXY_WALLET` | Your Polymarket wallet address | Same as your MetaMask wallet |
| `TRADING_ENABLED` | `true` | Enable auto-trading |
| `TRADING_DRY_RUN` | `false` | Actually place orders |

**DipArb v2 Parameters:**

DipArb v2 parameters are hardcoded in `src/trading/tradingEngine.js`. Key values:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `CHEAP_THRESHOLD` | `0.35` | Max price to buy any side |
| `BUY_SIZE_DOLLARS` | `3` | $3 per buy |
| `MAX_WINDOW_SPEND` | `8` | $8 max per window |
| `MIN_BTC_MOVE_PCT` | `0.15` | Require 0.15% BTC move for entry |
| `SKIP_AFTER_MINUTE` | `7` | Don't start new positions after min 7 |
| `MIN_BUY_COOLDOWN` | `45000` | 45 seconds between buys |
| `LONG_DISCOUNT` | `0.7` | Reduce LONG size to 70% after 1+ Down win |

**Polymarket & Polygon:**

| Variable | Value |
|----------|-------|
| `POLYMARKET_AUTO_SELECT_LATEST` | `true` |
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` |
| `POLYGON_RPC_URLS` | `https://polygon-rpc.com,https://rpc.ankr.com/polygon` |

**Bright Data Proxy (Required for Railway):**

Polymarket blocks datacenter IPs. Use Bright Data residential proxy:

| Variable | Value | Notes |
|----------|-------|-------|
| `HTTP_PROXY` | `http://brd-customer-hl_06c8577c-zone-isp_proxy1-ip-31.204.51.105:pk6x1bjxnpuq@brd.superproxy.io:33335` | ISP proxy for Polymarket |
| `HTTPS_PROXY` | `http://brd-customer-hl_06c8577c-zone-isp_proxy1-ip-31.204.51.105:pk6x1bjxnpuq@brd.superproxy.io:33335` | Same as HTTP_PROXY |

> **Note:** Replace the Bright Data credentials with your own from your Bright Data dashboard.

### 4. Deploy

Railway will automatically build and start the bot. It will:
- Auto-restart on crashes
- Run 24/7 (paid plan ~$5/month)
- Show real-time logs in the dashboard

---

## Configuration Reference

### Polymarket

| Variable | Default | Description |
|----------|---------|-------------|
| `POLYMARKET_AUTO_SELECT_LATEST` | `true` | Auto-pick latest 15m market |
| `POLYMARKET_SERIES_ID` | `10192` | Series ID for BTC Up/Down |
| `POLYMARKET_SERIES_SLUG` | `btc-up-or-down-15m` | Series slug |
| `POLYMARKET_SLUG` | _(optional)_ | Pin a specific market |

### Chainlink / Polygon

| Variable | Default | Description |
|----------|---------|-------------|
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` | Primary RPC |
| `POLYGON_RPC_URLS` | _(optional)_ | Comma-separated fallback RPCs |
| `POLYGON_WSS_URLS` | _(optional)_ | WebSocket RPCs for real-time data |

### DipArb v2 Trading (Hardcoded in tradingEngine.js)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHEAP_THRESHOLD` | `0.35` | Max price to buy any side |
| `IDEAL_THRESHOLD` | `0.25` | Ideal entry (3:1+ R:R) |
| `MAX_PAIR_ASK` | `0.985` | Only enter if Up+Down ≤ 98.5¢ |
| `BUY_SIZE_DOLLARS` | `3` | $3 per buy |
| `MAX_WINDOW_SPEND` | `8` | $8 max per window |
| `MIN_BTC_MOVE_PCT` | `0.15` | Require ≥0.15% BTC move for entry |
| `SKIP_AFTER_MINUTE` | `7` | Don't start new positions after min 7 |
| `MIN_BUY_COOLDOWN` | `45000` | 45 seconds between buys |
| `LONG_DISCOUNT` | `0.7` | Reduce LONG size to 70% after 1+ Down win |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_ENABLED` | `false` | Enable auto-trading |
| `TRADING_DRY_RUN` | `false` | Simulate trades without placing orders |
| `PRIVATE_KEY` | _(required)_ | Wallet private key |

### Proxy Support

| Variable | Description |
|----------|-------------|
| `HTTPS_PROXY` | HTTP/HTTPS proxy URL |
| `ALL_PROXY` | SOCKS5 proxy URL |

Example: `http://user:pass@host:port` or `socks5://user:pass@host:port`

---

## Project Structure

```
src/
  index.js              # Main entry point, dashboard display
  config.js             # Configuration management
  engines/
    probability.js      # TA scoring (VWAP, RSI, MACD, Heiken Ashi)
    edge.js             # Edge calculation and trade decision
  trading/
    index.js            # Trading orchestration
    tradingEngine.js    # Survival mode rules and trade execution
    tradingService.js   # Polymarket CLOB API integration
    positionTracker.js  # P&L tracking and circuit breaker
```

## Troubleshooting

### Local Development

- **Bot not trading?** Check that `TRADING_ENABLED=true` and `TRADING_DRY_RUN=false` in your `.env`
- **"No cheap side"?** Normal - waiting for one side to drop ≤$0.35. Check market prices in the logs
- **"Only [Up/Down] cheap, waiting for [other side]"?** FIX 7 - bot won't pile into one side. Waiting for the other side to become cheap (≤$0.35) to hedge
- **"Low volatility"?** BTC hasn't moved ≥0.15% in the last 3 minutes. Bot skips flat windows to avoid weak entries
- **"Too late for new position"?** Normal - bot doesn't start new positions after minute 7 of the candle (FIX 6)
- **"Profit locked"?** Good! The bot has locked in guaranteed profit and stopped buying in this window
- **No Chainlink updates?** Ensure Polygon RPC URLs are configured correctly

### Railway Deployment

- **"Cloudflare 403 Forbidden"?** Railway's datacenter IP is blocked. Add `HTTP_PROXY` and `HTTPS_PROXY` env vars with Bright Data credentials
- **"Maker (Proxy wallet): undefined"?** Add `PROXY_WALLET` env var with your Polymarket wallet address
- **"Invalid fee rate (0)"?** The bot now fetches fee rates dynamically. If it still fails, ensure `@polymarket/clob-client@^4.14.0` is installed
- **"Size lower than minimum: 5"?** The bot enforces Polymarket's 5-share minimum. Order size is calculated as `$3 / price` with a floor of 5 shares
- **"Order created but no orderID returned"?** Check Railway logs for the actual error. Common causes: fee rate, minimum size, or proxy issues
- **Bot keeps restarting?** Check Railway logs for errors. Common issues: missing env vars, proxy auth failure, or RPC rate limits
- **Zero trades for 1+ hour?** Check if both sides are cheap (≤$0.35) and BTC is moving. DipArb requires both conditions

## Disclaimer

This is not financial advice. Trading on Polymarket involves risk. Use at your own risk. The bot includes capital preservation features but cannot guarantee profits.

---

Created by [@krajekis](https://github.com/krajekis) | Modified by [@0xMgwan](https://github.com/0xMgwan)
