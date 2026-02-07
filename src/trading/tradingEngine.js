import { PositionTracker } from "./positionTracker.js";

export class TradingEngine {
  constructor(tradingService, config = {}) {
    this.tradingService = tradingService;
    this.config = {
      enabled: config.enabled ?? false,
      minConfidence: config.minConfidence ?? 80,
      orderSize: config.orderSize ?? 3,
      maxPositionSize: config.maxPositionSize ?? 3,
      minEdge: config.minEdge ?? 0.20,
      cooldownMs: config.cooldownMs ?? 900000,
      maxTradesPerHour: config.maxTradesPerHour ?? 2,
      maxDailyLoss: config.maxDailyLoss ?? 8,
      ...config
    };
    
    this.lastTradeTime = 0;
    this.currentPosition = null;
    this.tradeHistory = [];
    this.tradedMarkets = new Set();  // SURVIVAL: Track which markets we already traded
    this.hourlyTrades = [];          // SURVIVAL: Track trades per hour
    this.positionTracker = new PositionTracker();
  }

  _tradesInLastHour() {
    const oneHourAgo = Date.now() - 3600000;
    this.hourlyTrades = this.hourlyTrades.filter(t => t > oneHourAgo);
    return this.hourlyTrades.length;
  }

  shouldTrade(prediction, marketData, currentPrice, indicators = {}) {
    if (!this.config.enabled) {
      return { shouldTrade: false, reason: "Trading disabled" };
    }

    // SURVIVAL RULE #1: ONE trade per market - never double down
    const slug = marketData.marketSlug || "";
    if (slug && this.tradedMarkets.has(slug)) {
      return { shouldTrade: false, reason: `Already traded this market (${slug.slice(-10)})` };
    }

    // SURVIVAL RULE #2: Max trades per hour
    if (this._tradesInLastHour() >= this.config.maxTradesPerHour) {
      return { shouldTrade: false, reason: `Hourly limit reached (${this.config.maxTradesPerHour} trades/hr)` };
    }

    // SURVIVAL RULE #3: Cooldown between trades
    const now = Date.now();
    if (now - this.lastTradeTime < this.config.cooldownMs) {
      return { 
        shouldTrade: false, 
        reason: `Cooldown (${Math.floor((this.config.cooldownMs - (now - this.lastTradeTime)) / 1000)}s)` 
      };
    }

    if (!prediction || !marketData) {
      return { shouldTrade: false, reason: "Missing prediction or market data" };
    }

    // SURVIVAL RULE #4: Only trade in the sweet spot (minutes 2-12 of 15min candle)
    // Too early = not enough data, too late = not enough time for edge
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      const minLeft = msLeft / 60000;
      if (minLeft > 14) {
        return { shouldTrade: false, reason: `Too early in candle (${minLeft.toFixed(0)}min left, wait for min 1+)` };
      }
      if (minLeft < 2) {
        return { shouldTrade: false, reason: `Too late in candle (${minLeft.toFixed(0)}min left, need 2+ min)` };
      }
    }

    const longConfidence = prediction.longPct ?? 0;
    const shortConfidence = prediction.shortPct ?? 0;
    const maxConfidence = Math.max(longConfidence, shortConfidence);

    // SURVIVAL RULE #5: 80% minimum confidence
    if (maxConfidence < this.config.minConfidence) {
      return { 
        shouldTrade: false, 
        reason: `Confidence too low (${maxConfidence.toFixed(1)}% < ${this.config.minConfidence}%)` 
      };
    }

    const direction = longConfidence > shortConfidence ? "LONG" : "SHORT";
    const targetOutcome = direction === "LONG" ? "Up" : "Down";
    
    const marketPrice = direction === "LONG" 
      ? marketData.upPrice 
      : marketData.downPrice;

    if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
      return { shouldTrade: false, reason: "Invalid market price" };
    }

    // SURVIVAL RULE #6: Only buy tokens under price cap for better risk/reward
    const maxPrice = this.config.maxTokenPrice || 0.60;
    if (marketPrice > maxPrice) {
      return { shouldTrade: false, reason: `Price too high ($${marketPrice.toFixed(2)} > $${maxPrice.toFixed(2)})` };
    }

    const impliedProb = marketPrice;
    const modelProb = maxConfidence / 100;
    const edge = modelProb - impliedProb;

    // SURVIVAL RULE #7: 20% minimum edge
    if (edge < this.config.minEdge) {
      return { 
        shouldTrade: false, 
        reason: `Edge too small (${(edge * 100).toFixed(1)}% < ${(this.config.minEdge * 100).toFixed(1)}%)` 
      };
    }

    // SURVIVAL RULE #8: STRICT indicator consensus - require 4 out of 5 to agree
    if (indicators && Object.keys(indicators).length > 0) {
      let bullishCount = 0;
      let bearishCount = 0;
      let totalIndicators = 0;

      if (indicators.priceVsVwap !== undefined) {
        totalIndicators++;
        if (indicators.priceVsVwap > 0) bullishCount++;
        else if (indicators.priceVsVwap < 0) bearishCount++;
      }

      if (indicators.vwapSlope !== undefined && indicators.vwapSlope !== null) {
        totalIndicators++;
        if (indicators.vwapSlope > 0) bullishCount++;
        else if (indicators.vwapSlope < 0) bearishCount++;
      }

      if (indicators.rsi !== undefined && indicators.rsi !== null) {
        totalIndicators++;
        if (indicators.rsi > 55) bullishCount++;
        else if (indicators.rsi < 45) bearishCount++;
      }

      if (indicators.macdHist !== undefined && indicators.macdHist !== null) {
        totalIndicators++;
        if (indicators.macdHist > 0) bullishCount++;
        else if (indicators.macdHist < 0) bearishCount++;
      }

      if (indicators.heikenColor !== undefined && indicators.heikenColor !== null) {
        totalIndicators++;
        if (indicators.heikenColor === "green") bullishCount++;
        else if (indicators.heikenColor === "red") bearishCount++;
      }

      const requiredConsensus = 2;  // Need 2/5 indicators agreeing (relaxed for Chainlink fallback)
      const agreeingCount = direction === "LONG" ? bullishCount : bearishCount;
      
      if (totalIndicators >= 4 && agreeingCount < requiredConsensus) {
        return {
          shouldTrade: false,
          reason: `Weak consensus (${agreeingCount}/${totalIndicators} agree on ${direction}, need ${requiredConsensus})`
        };
      }
    }

    // SURVIVAL RULE #9: Don't trade if spread is too wide (>4%)
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.04) {
      return {
        shouldTrade: false,
        reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 4%)`
      };
    }

    return {
      shouldTrade: true,
      direction,
      targetOutcome,
      confidence: maxConfidence,
      edge,
      marketPrice,
      modelProb,
      reason: `${direction} ${maxConfidence.toFixed(0)}% conf, ${(edge * 100).toFixed(0)}% edge @ $${marketPrice.toFixed(2)}`
    };
  }

  async executeTrade(signal, marketData) {
    if (!signal.shouldTrade) {
      return { success: false, reason: signal.reason };
    }

    try {
      const tokenId = signal.targetOutcome === "Up" 
        ? marketData.upTokenId 
        : marketData.downTokenId;

      if (!tokenId) {
        return { success: false, reason: "Missing token ID" };
      }

      const side = "BUY";
      const price = Math.min(0.99, signal.marketPrice + 0.01);
      
      // SURVIVAL: Fixed small size - $3 max per trade
      // orderSize is in dollars, calculate shares based on price
      const maxOrderDollars = this.config.orderSize;  // $3
      const size = Math.floor(maxOrderDollars / price);  // shares = dollars / price
      
      if (size < 1) {
        return { success: false, reason: `Price too high for $${maxOrderDollars} order (need ${(maxOrderDollars / 0.99).toFixed(0)}+ shares)` };
      }
      
      // Verify cost doesn't exceed budget
      const maxCost = price * size;
      if (maxCost > maxOrderDollars * 1.1) {  // Allow 10% buffer for slippage
        return { success: false, reason: `Cost too high ($${maxCost.toFixed(2)} > $${(maxOrderDollars * 1.1).toFixed(2)})` };
      }

      const order = await this.tradingService.placeOrder({
        tokenId,
        side,
        price,
        size,
        orderType: "GTC"
      });

      this.lastTradeTime = Date.now();
      this.hourlyTrades.push(Date.now());
      
      // SURVIVAL: Mark this market as traded - never trade it again
      const slug = marketData.marketSlug || "";
      if (slug) this.tradedMarkets.add(slug);
      
      const trade = {
        timestamp: Date.now(),
        direction: signal.direction,
        outcome: signal.targetOutcome,
        confidence: signal.confidence,
        edge: signal.edge,
        price,
        size,
        cost: maxCost,
        orderId: order?.orderID,
        marketSlug: marketData.marketSlug
      };

      this.tradeHistory.push(trade);
      this.currentPosition = trade;

      // Track position for P&L
      this.positionTracker.addPosition({
        orderId: order?.orderID,
        direction: signal.direction,
        outcome: signal.targetOutcome,
        price,
        size,
        confidence: signal.confidence,
        edge: signal.edge,
        marketSlug: marketData.marketSlug,
        marketEndTime: marketData.marketEndTime || null
      });

      return {
        success: true,
        trade,
        order,
        reason: `${signal.direction} ${size}x @ $${price.toFixed(2)} (cost: $${maxCost.toFixed(2)})`
      };

    } catch (error) {
      return {
        success: false,
        reason: `Trade failed: ${error.message}`,
        error
      };
    }
  }

  // Check and resolve positions when market ends
  checkResolutions(currentPrice, priceToBeat) {
    return this.positionTracker.checkResolutions(currentPrice, priceToBeat);
  }

  // Cleanup stale positions
  cleanupStalePositions() {
    this.positionTracker.cleanupStalePositions();
  }

  getStats() {
    const pnlStats = this.positionTracker.getStats();
    return {
      enabled: this.config.enabled,
      totalTrades: this.tradeHistory.length,
      currentPosition: this.currentPosition,
      lastTradeTime: this.lastTradeTime,
      activeOrders: this.tradingService.getActiveOrdersCount(),
      pnl: pnlStats,
      tradedMarkets: this.tradedMarkets.size,
      tradesThisHour: this._tradesInLastHour()
    };
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  enableTrading() {
    this.config.enabled = true;
  }

  disableTrading() {
    this.config.enabled = false;
  }
}
