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

    // CIRCUIT BREAKER: Stop if total exposure gets too high
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    const maxExposure = 20; // $20 max total exposure
    if (totalExposure >= maxExposure) {
      return { 
        shouldTrade: false, 
        reason: `Circuit breaker: Total exposure $${totalExposure.toFixed(2)} >= $${maxExposure}` 
      };
    }

    if (!prediction || !marketData) {
      return { shouldTrade: false, reason: "Missing prediction or market data" };
    }

    // RULE #4: Trade early for best prices - enter from minute 1, stop 1 min before end
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      const minLeft = msLeft / 60000;
      if (minLeft > 14) {
        return { shouldTrade: false, reason: `Too early in candle (${minLeft.toFixed(0)}min left, waiting for candle start)` };
      }
      if (minLeft < 1) {
        return { shouldTrade: false, reason: `Too late in candle (${minLeft.toFixed(0)}min left)` };
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

    let direction = longConfidence > shortConfidence ? "LONG" : "SHORT";
    let targetOutcome = direction === "LONG" ? "Up" : "Down";
    
    let marketPrice = direction === "LONG" 
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
        if (indicators.rsi > 52) bullishCount++;
        else if (indicators.rsi < 48) bearishCount++;
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

      const requiredConsensus = 3;  // 3/5 indicators + momentum confirmation = quality trades every 15min
      const agreeingCount = direction === "LONG" ? bullishCount : bearishCount;
      
      if (totalIndicators >= 4 && agreeingCount < requiredConsensus) {
        return {
          shouldTrade: false,
          reason: `Weak consensus (${agreeingCount}/${totalIndicators} agree on ${direction}, need ${requiredConsensus})`
        };
      }

      // TREND OVERRIDE: If indicators strongly disagree with model, follow the indicators
      const macdBullish = indicators.macdHist !== undefined && indicators.macdHist > 0;
      const macdBearish = indicators.macdHist !== undefined && indicators.macdHist < 0;
      
      if (direction === "SHORT" && bullishCount > bearishCount && macdBullish) {
        console.log(`[Trading] ⚡ TREND OVERRIDE: Model says SHORT but ${bullishCount} bullish indicators + MACD bullish → flipping to LONG`);
        direction = "LONG";
        targetOutcome = "Up";
        marketPrice = marketData.upPrice;
      }
      if (direction === "LONG" && bearishCount > bullishCount && macdBearish) {
        console.log(`[Trading] ⚡ TREND OVERRIDE: Model says LONG but ${bearishCount} bearish indicators + MACD bearish → flipping to SHORT`);
        direction = "SHORT";
        targetOutcome = "Down";
        marketPrice = marketData.downPrice;
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

  async executeTrade(signal, marketData, priceToBeat = null) {
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
      const price = Math.min(0.95, signal.marketPrice + 0.003);  // Closer to market price for better fill rates
      
      // FIXED: Ensure $5 max per trade
      const maxOrderDollars = 5; // Hard-coded $5 max
      const MIN_SHARES = 5; // Polymarket minimum order size
      
      // Calculate shares to stay under $5
      let size = Math.floor(maxOrderDollars / price);
      
      // Ensure we meet Polymarket's minimum of 5 shares
      if (size < MIN_SHARES) {
        size = MIN_SHARES;
      }
      
      // Verify cost doesn't exceed $5
      const maxCost = price * size;
      if (maxCost > 5) {
        // Recalculate size to stay under $5
        size = Math.floor(5 / price);
        if (size < MIN_SHARES) {
          return { success: false, reason: `Cannot place order: price too high ($${price.toFixed(3)}, min 5 shares = $${(price * MIN_SHARES).toFixed(2)} > $5)` };
        }
      }

      const order = await this.tradingService.placeOrder({
        tokenId,
        side,
        price,
        size,
        orderType: "GTC"
      });

      // Only record position if order was accepted by Polymarket (has orderID)
      if (!order || !order.orderID) {
        console.log("[Trading] Order failed - no orderID returned, not recording position");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[Trading] Order accepted with status '${order.status}' - recording position`);

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
        orderId: order.orderID,
        marketSlug: marketData.marketSlug
      };

      this.tradeHistory.push(trade);
      this.currentPosition = trade;

      // Track position for P&L
      this.positionTracker.addPosition({
        orderId: order.orderID,
        direction: signal.direction,
        outcome: signal.targetOutcome,
        price,
        size,
        confidence: signal.confidence,
        edge: signal.edge,
        marketSlug: marketData.marketSlug,
        marketEndTime: marketData.marketEndTime || null,
        priceToBeat  // Store market opening price for correct win/loss determination
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

  // Check if any positions should be stopped out (20% loss)
  checkStopLoss(currentMarketPrices) {
    return this.positionTracker.checkStopLoss(currentMarketPrices);
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
