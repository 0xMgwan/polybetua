# Polymarket BTC 15m Auto-Trading Bot

A real-time auto-trading bot for Polymarket **"Bitcoin Up or Down" 15-minute** markets with built-in survival mode capital preservation.

## Features

- **Auto-Trading** - Automatically places trades on Polymarket BTC 15m markets
- **Survival Mode** - Strict capital preservation with $3 max per trade, circuit breakers, and loss limits
- **Technical Analysis** - VWAP, RSI, MACD, Heiken Ashi indicators with consensus-based signals
- **Position Tracking** - Tracks open positions, P&L, win rate, and streaks
- **Live Dashboard** - Real-time terminal display with market data, indicators, and trading status
- **Railway Ready** - Deploy to Railway for 24/7 operation

## How It Works

1. Bot monitors Polymarket BTC 15-minute Up/Down markets
2. Analyzes price action using 5 technical indicators (VWAP, VWAP slope, RSI, MACD, Heiken Ashi)
3. When 3/5 indicators agree and confidence/edge thresholds are met, places a BUY order
4. Waits for market resolution (15 min) - if BTC goes Up/Down as predicted, you win
5. Tracks all trades and P&L, with circuit breakers to stop trading on losses

## Survival Mode Rules

| Rule | Value |
|------|-------|
| Max per trade | $3 (6% of capital) |
| Min confidence | 65% |
| Min edge | 18% over market price |
| Indicator consensus | 3/5 must agree |
| Trades per market | 1 (no doubling down) |
| Trades per hour | 2 max |
| Cooldown | 15 minutes |
| Time window | Minutes 2-12 of candle |
| Token price cap | Under $0.85 |
| Circuit breaker | 3 consecutive losses, -$8 drawdown, or <30% win rate |

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

# Survival Mode Parameters (defaults shown)
TRADING_MIN_CONFIDENCE=65
TRADING_ORDER_SIZE=3
TRADING_MIN_EDGE=0.18
TRADING_MAX_TRADES_PER_HOUR=2
TRADING_MAX_DAILY_LOSS=8
TRADING_MAX_TOKEN_PRICE=0.85
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

| Variable | Value |
|----------|-------|
| `PRIVATE_KEY` | Your wallet private key |
| `TRADING_ENABLED` | `true` |
| `TRADING_DRY_RUN` | `false` |
| `TRADING_MIN_CONFIDENCE` | `65` |
| `TRADING_ORDER_SIZE` | `3` |
| `TRADING_MIN_EDGE` | `0.18` |
| `TRADING_MAX_TRADES_PER_HOUR` | `2` |
| `TRADING_MAX_DAILY_LOSS` | `8` |
| `TRADING_MAX_TOKEN_PRICE` | `0.85` |
| `POLYMARKET_AUTO_SELECT_LATEST` | `true` |
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` |
| `POLYGON_RPC_URLS` | `https://polygon-rpc.com,https://rpc.ankr.com/polygon` |
| `POLYGON_WSS_URLS` | `wss://polygon-bor-rpc.publicnode.com` |

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

### Trading

| Variable | Default | Description |
|----------|---------|-------------|
| `TRADING_ENABLED` | `false` | Enable auto-trading |
| `TRADING_DRY_RUN` | `false` | Simulate trades without placing orders |
| `PRIVATE_KEY` | _(required)_ | Wallet private key |
| `TRADING_MIN_CONFIDENCE` | `65` | Min prediction confidence (%) |
| `TRADING_ORDER_SIZE` | `3` | Max dollars per trade |
| `TRADING_MIN_EDGE` | `0.18` | Min edge over market price |
| `TRADING_COOLDOWN_MS` | `900000` | Cooldown between trades (ms) |
| `TRADING_MAX_CAPITAL_RISK` | `0.06` | Max % of capital per trade |
| `TRADING_MIN_BALANCE` | `35` | Reserve balance (don't trade below) |
| `TRADING_MAX_DAILY_LOSS` | `8` | Stop after this daily loss ($) |
| `TRADING_MAX_TRADES_PER_HOUR` | `2` | Max trades per hour |
| `TRADING_MAX_TOKEN_PRICE` | `0.85` | Only buy tokens under this price |

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

- **Bot not trading?** Check that `TRADING_ENABLED=true` and `TRADING_DRY_RUN=false` in your `.env`
- **"Circuit breaker" message?** The bot stopped trading after losses. Delete `logs/pnl.json` and restart
- **"Too early/late in candle"?** Normal - bot only trades during minutes 2-12 of each 15-min candle
- **"Price too high"?** The token price exceeds `TRADING_MAX_TOKEN_PRICE` - wait for a better entry
- **No Chainlink updates?** Ensure Polygon RPC URLs are configured correctly

## Disclaimer

This is not financial advice. Trading on Polymarket involves risk. Use at your own risk. The bot includes capital preservation features but cannot guarantee profits.

---

Created by [@krajekis](https://github.com/krajekis) | Modified by [@0xMgwan](https://github.com/0xMgwan)
