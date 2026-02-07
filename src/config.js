import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-15m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  trading: {
    enabled: (process.env.TRADING_ENABLED || "false").toLowerCase() === "true",
    privateKey: process.env.PRIVATE_KEY || "",
    minConfidence: Number(process.env.TRADING_MIN_CONFIDENCE) || 65,  // SURVIVAL: 65% minimum (selective but tradeable)
    orderSize: Number(process.env.TRADING_ORDER_SIZE) || 3,  // SURVIVAL: $3 max per trade (6% of $50)
    maxPositionSize: Number(process.env.TRADING_MAX_POSITION_SIZE) || 3,  // SURVIVAL: ONE trade per market
    minEdge: Number(process.env.TRADING_MIN_EDGE) || 0.18,  // SURVIVAL: 18% edge minimum (realistic threshold)
    cooldownMs: Number(process.env.TRADING_COOLDOWN_MS) || 900000,  // SURVIVAL: 15 min cooldown (1 per candle)
    dryRun: (process.env.TRADING_DRY_RUN || "false").toLowerCase() === "true",
    maxCapitalRisk: Number(process.env.TRADING_MAX_CAPITAL_RISK) || 0.06,  // SURVIVAL: Max 6% of capital per trade
    minRemainingBalance: Number(process.env.TRADING_MIN_BALANCE) || 35,  // SURVIVAL: Keep $35 reserve minimum
    maxDailyLoss: Number(process.env.TRADING_MAX_DAILY_LOSS) || 8,  // SURVIVAL: Stop after $8 daily loss
    maxTradesPerHour: Number(process.env.TRADING_MAX_TRADES_PER_HOUR) || 4,  // SURVIVAL: Max 4 trades/hour (one per 15min candle)
    maxTokenPrice: Number(process.env.TRADING_MAX_TOKEN_PRICE) || 0.85  // SURVIVAL: Only buy under $0.85
  }
};
