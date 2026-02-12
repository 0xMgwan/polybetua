# Polymarket BTC 15m Auto-Trading Bot — ARB HUNTER v6

A real-time auto-trading bot for Polymarket **"Bitcoin Up or Down" 15-minute** markets using **3 profit strategies**: pure arbitrage (guaranteed), extreme value (high R:R), and confirmed moves (latency edge).

## Features

- **Pure Arbitrage** - Buy both sides when sum < $0.97 → guaranteed profit when one settles at $1.00
- **Extreme Value** - Tokens under 5¢ with massive R:R (20:1+), no BTC confirmation needed
- **Confirmed Moves** - BTC moved >0.08% + cheap token = latency edge with fee awareness
- **Deep Value Guard** - Extreme value only trades if arb is impossible (sum > $0.98) or window closing (min > 10)
- **Simultaneous Execution** - Arb trades buy both sides at once via Promise.allSettled
- **Position Tracking** - Tracks open positions, P&L, win rate, and strategy breakdown
- **Live Dashboard** - Real-time terminal display with strategy stats (Arb/Extreme/Move)
- **Debug Endpoint** - `/debug` shows real-time market data and why trades fire/skip
- **Railway Ready** - Deploy to Railway for 24/7 operation

## How It Works (ARB HUNTER v6)

### Strategy 1: PURE ARB (Guaranteed Profit)
1. Bot scans every market for sum < $0.97 (Up + Down < 97¢)
2. **Gross profit**: $1.00 - sum per share (e.g., sum $0.83 = 17¢/share profit)
3. **Buys both sides simultaneously** at $40/pair ($20 each side)
4. One side always settles at $1.00, other at $0.00 → guaranteed net profit
5. **Example**: Sum $0.83, 47 shares each side = +$7.71 profit (14¢ × 47 shares)

### Strategy 2: EXTREME VALUE (Asymmetric R:R)
1. **Deep Value** (tokens < 5¢): No BTC confirmation needed (20:1+ R:R)
2. **Extreme Value** (tokens < 20¢): Requires BTC move > 0.06% confirmation
3. Risk $0.05, win $0.95 → 19:1 R:R, only need 5% win rate
4. Trades $2 per bet (small, to protect arb capital)
5. Guard: Only fires if sum > $0.98 (arb impossible) OR minute > 10 (arb window closing)

### Strategy 3: CONFIRMED MOVE (Latency Edge)
1. BTC moved > 0.08% from candle open
2. Winning token < 45¢ (cheap enough to profit after fees)
3. Expected value calculation: `EV = (1 - price - fee) × prob - (price + fee) × (1 - prob)`
4. Trades $2 per bet (small, to protect arb capital)
5. Only if edge > 15% and EV > 0

**Sizing & Guardrails:**
- Arb: $40/pair ($20 each side) — profit scales linearly
- Extreme: $2 per trade
- Move: $2 per trade
- Max exposure: $80 (arb is hedged, safe to go higher)
- Daily drawdown limit: -$10 (stops all trading if hit)

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
PROXY_WALLET=your_polymarket_wallet_address

# ARB HUNTER v6 Parameters (hardcoded in tradingEngine.js)
# PURE ARB
ARB_MAX_SUM=0.97              # Buy both sides if sum < $0.97
ARB_SIZE=40                   # $40 per arb pair ($20 each side)
ARB_MIN_PROFIT=0.015          # Min 1.5¢ profit per share after fees

# EXTREME VALUE
EXTREME_MAX_PRICE=0.20        # Token < 20¢ with BTC move
EXTREME_MIN_BTC_MOVE=0.06     # BTC must move > 0.06%
DEEP_VALUE_MAX=0.05           # Tokens < 5¢ don't need BTC confirmation
EXTREME_SIZE=2                # $2 per extreme value bet

# CONFIRMED MOVE
MOVE_MIN_BTC_PCT=0.08         # BTC must move > 0.08%
MOVE_MAX_TOKEN=0.45           # Token < 45¢
MOVE_SIZE=2                   # $2 per confirmed move
MOVE_MIN_EDGE=0.15            # Need 15% edge

# GUARDRAILS
MAX_EXPOSURE=80               # $80 max open exposure
DAILY_DRAWDOWN_LIMIT=-10      # Stop at -$10 daily loss
MIN_BUY_COOLDOWN=15000        # 15s between trades
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

## Monitoring & Debugging

### Live Endpoints

- **`/stats`** - Current trading stats (P&L, win rate, strategy breakdown)
- **`/pnl`** - Open and closed positions with detailed P&L
- **`/history`** - Full trade history from journal.json
- **`/debug`** - Real-time market scan data (prices, sum, BTC move, why trades fire/skip)
- **`/health`** - Health check with links to all endpoints

### Troubleshooting

#### No Trades Firing

1. **Check `/debug`** to see what the bot sees:
   - `sum`: Up + Down prices. Need < $0.97 for arb
   - `arbWouldTrigger`: true/false — is arb threshold met?
   - `btcMovePct`: BTC move %. Need > 0.08% for confirmed move
   - `candleMinute`: Current position in 15-min window (1-15)

2. **Arb not firing?**
   - Sum is too high (> $0.97). Market is pricing efficiently
   - Arb windows are rare — may take hours between opportunities
   - Check `/debug` to confirm sum value

3. **Extreme value not firing?**
   - Token price > $0.05 (deep value) AND sum < $0.98 (arb possible) AND minute < 10 (arb window open)
   - OR token price > $0.20 OR BTC move < 0.06%
   - Deep value guard prevents blocking arb opportunities

4. **Confirmed move not firing?**
   - BTC move < 0.08% (too small)
   - Token price > $0.45 (too expensive)
   - Edge < 15% or EV ≤ 0

#### Trading Issues

- **"Both arb orders failed"?** Network issue or insufficient balance. Check Polymarket wallet balance
- **"ARB PARTIAL: [side] filled, [side] FAILED"?** One leg filled, other didn't. This is a loss. Check logs for why
- **"Circuit breaker: $X exposure"?** Total open positions >= $80. Wait for markets to resolve before new trades
- **"Daily stop: $-X"?** Lost $10+ today. Bot stops trading until next day (UTC)
- **"Too early (min 0)" or "Too late (min 14)"?** Bot only trades minutes 1-13 of the 15-min candle
- **"Cooldown"?** 15 seconds between trades. Bot is rate-limiting to avoid API spam

#### Railway Deployment

- **"Cloudflare 403 Forbidden"?** Railway's datacenter IP is blocked. Add `HTTP_PROXY` and `HTTPS_PROXY` env vars with Bright Data credentials
- **"Maker (Proxy wallet): undefined"?** Add `PROXY_WALLET` env var with your Polymarket wallet address
- **"Size lower than minimum: 5"?** Polymarket enforces 5-share minimum. Arb at $40 with prices > $8 will fail
- **"Order created but no orderID returned"?** Check Railway logs. Common causes: fee rate, minimum size, or proxy timeout
- **Bot keeps restarting?** Check Railway logs for errors. Common issues: missing env vars, proxy auth failure, RPC rate limits
- **Zero trades for 2+ hours?** Check `/debug`. If sum is always > $0.98, arb windows aren't appearing in current market conditions

## Disclaimer

This is not financial advice. Trading on Polymarket involves risk. Use at your own risk. The bot includes capital preservation features but cannot guarantee profits.

---

Created by [@krajekis](https://github.com/krajekis) | Modified by [@0xMgwan](https://github.com/0xMgwan)
