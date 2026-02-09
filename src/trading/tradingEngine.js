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

    // ═══════════════════════════════════════════════════════════════
    // INDICATOR-FIRST STRATEGY: Indicators decide direction, not model
    // The model confidence has proven unreliable (86% conf but wrong)
    // Instead, we use a weighted scoring of real-time technical indicators
    // ═══════════════════════════════════════════════════════════════

    // Step 1: Score each indicator with weights
    let bullScore = 0;
    let bearScore = 0;
    const signals = [];

    // MACD Histogram (weight: 3) — strongest trend indicator
    if (indicators.macdHist !== undefined && indicators.macdHist !== null) {
      if (indicators.macdHist > 0) {
        bullScore += 3;
        signals.push(`MACD:BULL(+3)`);
      } else if (indicators.macdHist < 0) {
        bearScore += 3;
        signals.push(`MACD:BEAR(+3)`);
      }
      // Bonus for expanding MACD (momentum accelerating)
      if (indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null) {
        if (indicators.macdHistDelta > 0 && indicators.macdHist > 0) {
          bullScore += 1;
          signals.push(`MACD-expand:BULL(+1)`);
        } else if (indicators.macdHistDelta < 0 && indicators.macdHist < 0) {
          bearScore += 1;
          signals.push(`MACD-expand:BEAR(+1)`);
        }
      }
    }

    // Price vs VWAP (weight: 2) — price position relative to fair value
    if (indicators.priceVsVwap !== undefined) {
      if (indicators.priceVsVwap > 0) {
        bullScore += 2;
        signals.push(`PriceVsVWAP:BULL(+2)`);
      } else if (indicators.priceVsVwap < 0) {
        bearScore += 2;
        signals.push(`PriceVsVWAP:BEAR(+2)`);
      }
    }

    // VWAP Slope (weight: 2) — trend direction
    if (indicators.vwapSlope !== undefined && indicators.vwapSlope !== null) {
      if (indicators.vwapSlope > 0) {
        bullScore += 2;
        signals.push(`VWAPslope:BULL(+2)`);
      } else if (indicators.vwapSlope < 0) {
        bearScore += 2;
        signals.push(`VWAPslope:BEAR(+2)`);
      }
    }

    // Heiken Ashi (weight: 2, +1 bonus for consecutive candles)
    if (indicators.heikenColor !== undefined && indicators.heikenColor !== null) {
      if (indicators.heikenColor === "green") {
        bullScore += 2;
        signals.push(`Heiken:BULL(+2)`);
        if (indicators.heikenCount >= 3) {
          bullScore += 1;
          signals.push(`Heiken-streak(${indicators.heikenCount}):BULL(+1)`);
        }
      } else if (indicators.heikenColor === "red") {
        bearScore += 2;
        signals.push(`Heiken:BEAR(+2)`);
        if (indicators.heikenCount >= 3) {
          bearScore += 1;
          signals.push(`Heiken-streak(${indicators.heikenCount}):BEAR(+1)`);
        }
      }
    }

    // RSI (weight: 1) — momentum confirmation
    if (indicators.rsi !== undefined && indicators.rsi !== null) {
      if (indicators.rsi > 55) {
        bullScore += 1;
        signals.push(`RSI(${indicators.rsi.toFixed(0)}):BULL(+1)`);
      } else if (indicators.rsi < 45) {
        bearScore += 1;
        signals.push(`RSI(${indicators.rsi.toFixed(0)}):BEAR(+1)`);
      } else {
        signals.push(`RSI(${indicators.rsi.toFixed(0)}):NEUTRAL`);
      }
    }

    // BTC Price Delta 1m (weight: 1) — immediate momentum
    if (indicators.delta1m !== undefined && indicators.delta1m !== null) {
      if (indicators.delta1m > 0) {
        bullScore += 1;
        signals.push(`Δ1m(+$${indicators.delta1m.toFixed(0)}):BULL(+1)`);
      } else if (indicators.delta1m < 0) {
        bearScore += 1;
        signals.push(`Δ1m(-$${Math.abs(indicators.delta1m).toFixed(0)}):BEAR(+1)`);
      }
    }

    // BTC Price Delta 3m (weight: 1) — short-term trend
    if (indicators.delta3m !== undefined && indicators.delta3m !== null) {
      if (indicators.delta3m > 0) {
        bullScore += 1;
        signals.push(`Δ3m(+$${indicators.delta3m.toFixed(0)}):BULL(+1)`);
      } else if (indicators.delta3m < 0) {
        bearScore += 1;
        signals.push(`Δ3m(-$${Math.abs(indicators.delta3m).toFixed(0)}):BEAR(+1)`);
      }
    }

    const totalScore = bullScore + bearScore;
    const scoreDiff = Math.abs(bullScore - bearScore);

    // Step 2: Log comprehensive indicator analysis
    console.log(`[Strategy] ══════════════════════════════════════`);
    console.log(`[Strategy] BULL score: ${bullScore} | BEAR score: ${bearScore} | Diff: ${scoreDiff}`);
    console.log(`[Strategy] Signals: ${signals.join(', ')}`);

    // Step 3: Require minimum score difference for clear signal
    const minScoreDiff = 3; // Need at least 3-point advantage
    if (scoreDiff < minScoreDiff) {
      console.log(`[Strategy] ⚠ Signal too weak (diff ${scoreDiff} < ${minScoreDiff}) — SKIP`);
      return {
        shouldTrade: false,
        reason: `Mixed signals (BULL:${bullScore} vs BEAR:${bearScore}, need ${minScoreDiff}+ diff)`
      };
    }

    // Step 4: Direction decided by indicators, NOT model
    let direction = bullScore > bearScore ? "LONG" : "SHORT";
    let targetOutcome = direction === "LONG" ? "Up" : "Down";
    let marketPrice = direction === "LONG" ? marketData.upPrice : marketData.downPrice;

    console.log(`[Strategy] ✅ Direction: ${direction} (score: ${direction === "LONG" ? bullScore : bearScore})`);

    if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
      return { shouldTrade: false, reason: "Invalid market price" };
    }

    // Step 5: Price cap for risk/reward
    const maxPrice = this.config.maxTokenPrice || 0.55;
    if (marketPrice > maxPrice) {
      return { shouldTrade: false, reason: `Price too high ($${marketPrice.toFixed(2)} > $${maxPrice.toFixed(2)})` };
    }

    // Step 6: Calculate edge based on indicator strength (not model)
    const indicatorConfidence = (Math.max(bullScore, bearScore) / totalScore) * 100;
    const edge = (indicatorConfidence / 100) - marketPrice;

    // Step 7: Don't trade if spread is too wide (>5%)
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.05) {
      return {
        shouldTrade: false,
        reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 5%)`
      };
    }

    console.log(`[Strategy] Entry: ${direction} ${targetOutcome} @ $${marketPrice.toFixed(3)} | Indicator conf: ${indicatorConfidence.toFixed(0)}%`);
    console.log(`[Strategy] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction,
      targetOutcome,
      confidence: indicatorConfidence,
      edge: Math.max(edge, 0.01),
      marketPrice,
      modelProb: indicatorConfidence / 100,
      reason: `${direction} indicators ${bullScore}v${bearScore} @ $${marketPrice.toFixed(2)}`
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
