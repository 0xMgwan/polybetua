import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// SMART CHEAP TOKEN ENGINE v3
// 
// Strategy: Buy cheap tokens (≤35¢) WITH indicator confirmation.
// Cheap tokens have 3:1+ risk/reward. When indicators agree on
// direction, buy the cheap side that matches momentum.
// 
// Key insight from data: Expensive hedges (69¢) burn money.
// A $4.85 hedge to protect $1.77 only profits $0.38.
// Instead: pick the RIGHT side with indicators, bet bigger ($3),
// and let the 3:1 R:R do the work.
//
// One trade per candle. No overtrading. Let winners run.
// ═══════════════════════════════════════════════════════════════

export class TradingEngine {
  constructor(tradingService, config = {}) {
    this.tradingService = tradingService;
    this.config = {
      enabled: config.enabled ?? false,
      ...config
    };
    
    this.lastTradeTime = 0;
    this.tradeHistory = [];
    this.hourlyTrades = [];
    this.positionTracker = new PositionTracker();
    
    // ─── SMART CHEAP TOKEN STRATEGY ─────────────────────────
    this.currentWindow = null;
    this.windowHistory = [];
    this.tradedSlugs = new Set();  // One trade per candle
    
    // Strategy parameters
    this.CHEAP_THRESHOLD = 0.35;     // Buy tokens ≤ 35¢ (2.8:1+ R:R)
    this.IDEAL_THRESHOLD = 0.25;     // Ideal entry ≤ 25¢ (3:1+ R:R)
    this.BET_SIZE_DOLLARS = 3;       // $3 per trade (bigger bets, fewer trades)
    this.MIN_SCORE_DIFF = 3;         // Indicators must agree by 3+ points
    this.MIN_CANDLE_MINUTE = 2;      // Don't trade first 2 min (let price settle)
    this.MAX_CANDLE_MINUTE = 12;     // Don't trade last 3 min (too late)
    this.MAX_TRADES_PER_HOUR = 4;    // Max 4 trades per hour
    
    this.lastBuyTime = 0;
  }

  _tradesInLastHour() {
    const oneHourAgo = Date.now() - 3600000;
    this.hourlyTrades = this.hourlyTrades.filter(t => t > oneHourAgo);
    return this.hourlyTrades.length;
  }

  // ─── WINDOW MANAGEMENT ──────────────────────────────────────
  _getOrCreateWindow(slug) {
    if (this.currentWindow && this.currentWindow.slug === slug) {
      return this.currentWindow;
    }
    if (this.currentWindow) {
      this._archiveWindow();
    }
    this.currentWindow = {
      slug,
      traded: false,
      trade: null,
      createdAt: Date.now()
    };
    return this.currentWindow;
  }

  _archiveWindow() {
    if (!this.currentWindow) return;
    const w = this.currentWindow;
    if (w.trade) {
      this.windowHistory.push({ ...w, archivedAt: Date.now() });
    }
    this.currentWindow = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SCORE INDICATORS — determine bull vs bear strength
  // ═══════════════════════════════════════════════════════════════
  _scoreIndicators(indicators) {
    let bullScore = 0;
    let bearScore = 0;
    const details = [];
    
    // Price vs VWAP (weight 3 — most reliable for 15m)
    if (indicators.priceVsVwap !== undefined) {
      if (indicators.priceVsVwap > 0) { bullScore += 3; details.push("VWAP↑"); }
      if (indicators.priceVsVwap < 0) { bearScore += 3; details.push("VWAP↓"); }
    }
    
    // VWAP slope (weight 3 — strong momentum)
    if (indicators.vwapSlope !== undefined && indicators.vwapSlope !== null) {
      if (indicators.vwapSlope > 0) { bullScore += 3; details.push("VSlope↑"); }
      if (indicators.vwapSlope < 0) { bearScore += 3; details.push("VSlope↓"); }
    }
    
    // MACD histogram + expanding (weight 2)
    if (indicators.macdHist !== null && indicators.macdHist !== undefined) {
      if (indicators.macdHist > 0) { bullScore += 1; details.push("MACD+"); }
      if (indicators.macdHist < 0) { bearScore += 1; details.push("MACD-"); }
      // Bonus for expanding histogram (momentum accelerating)
      if (indicators.macdHistDelta !== null && indicators.macdHistDelta !== undefined) {
        if (indicators.macdHist > 0 && indicators.macdHistDelta > 0) { bullScore += 1; details.push("MACDx↑"); }
        if (indicators.macdHist < 0 && indicators.macdHistDelta < 0) { bearScore += 1; details.push("MACDx↓"); }
      }
    }
    
    // Heiken Ashi (weight 2 — good for trend)
    if (indicators.heikenColor) {
      const minCount = indicators.heikenCount >= 2 ? 2 : 1;
      if (indicators.heikenColor === "green" && indicators.heikenCount >= minCount) { bullScore += 2; details.push(`HA🟢×${indicators.heikenCount}`); }
      if (indicators.heikenColor === "red" && indicators.heikenCount >= minCount) { bearScore += 2; details.push(`HA🔴×${indicators.heikenCount}`); }
    }
    
    // Delta momentum (weight 1 each — short-term confirmation)
    if (indicators.delta1m > 0) { bullScore += 1; details.push("Δ1m↑"); }
    if (indicators.delta1m < 0) { bearScore += 1; details.push("Δ1m↓"); }
    if (indicators.delta3m > 0) { bullScore += 1; details.push("Δ3m↑"); }
    if (indicators.delta3m < 0) { bearScore += 1; details.push("Δ3m↓"); }
    
    return { bullScore, bearScore, scoreDiff: Math.abs(bullScore - bearScore), details };
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // Smart Cheap Token — buy cheap side WITH indicator confirmation
  // ═══════════════════════════════════════════════════════════════
  shouldTrade(prediction, marketData, currentPrice, indicators = {}) {
    if (!this.config.enabled) {
      return { shouldTrade: false, reason: "Trading disabled" };
    }
    if (!prediction || !marketData) {
      return { shouldTrade: false, reason: "Missing prediction or market data" };
    }

    const now = Date.now();
    const upPrice = marketData.upPrice;
    const downPrice = marketData.downPrice;
    const slug = marketData.marketSlug || "";

    if (!upPrice || !downPrice || upPrice <= 0 || downPrice <= 0) {
      return { shouldTrade: false, reason: "Invalid prices" };
    }

    // CIRCUIT BREAKER: Max $15 total open exposure
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= 15) {
      return { shouldTrade: false, reason: `Circuit breaker: exposure $${totalExposure.toFixed(2)} >= $15` };
    }

    // Max trades per hour
    if (this._tradesInLastHour() >= this.MAX_TRADES_PER_HOUR) {
      return { shouldTrade: false, reason: `Max ${this.MAX_TRADES_PER_HOUR} trades/hr reached` };
    }

    // ─── TIMING ──────────────────────────────────────────────
    let minLeft = 15;
    let candleMinute = 0;
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      minLeft = msLeft / 60000;
      candleMinute = Math.floor(15 - minLeft);
      
      if (candleMinute < this.MIN_CANDLE_MINUTE) {
        return { shouldTrade: false, reason: `Too early (min ${candleMinute}/${this.MIN_CANDLE_MINUTE})` };
      }
      if (candleMinute > this.MAX_CANDLE_MINUTE) {
        return { shouldTrade: false, reason: `Too late (min ${candleMinute}/${this.MAX_CANDLE_MINUTE})` };
      }
    }

    // ─── ONE TRADE PER CANDLE ────────────────────────────────
    if (this.tradedSlugs.has(slug)) {
      return { shouldTrade: false, reason: "Already traded this candle" };
    }

    // ─── GET/CREATE WINDOW ────────────────────────────────────
    const window = this._getOrCreateWindow(slug);
    if (window.traded) {
      return { shouldTrade: false, reason: "Window already traded" };
    }

    // ─── SCORE INDICATORS ────────────────────────────────────
    const { bullScore, bearScore, scoreDiff, details } = this._scoreIndicators(indicators);
    const isBull = bullScore > bearScore;
    
    console.log(`[Smart] ══════════════════════════════════════`);
    console.log(`[Smart] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Min ${candleMinute}/15`);
    console.log(`[Smart] Bull ${bullScore} vs Bear ${bearScore} (diff ${scoreDiff}) | ${details.join(', ')}`);

    // ─── FIND CHEAP SIDE MATCHING INDICATORS ─────────────────
    // Priority 1: Cheap token (≤35¢) that matches indicator direction
    // Priority 2: Ideal token (≤25¢) even with weaker indicators (great R:R)
    
    let buyOutcome = null;
    let buyPrice = null;
    let strategy = null;
    
    if (isBull && upPrice <= this.CHEAP_THRESHOLD && upPrice > 0.05) {
      // Indicators say UP and Up token is cheap — great trade
      buyOutcome = "Up";
      buyPrice = upPrice;
      strategy = upPrice <= this.IDEAL_THRESHOLD ? "SMART_IDEAL" : "SMART_CHEAP";
    } else if (!isBull && downPrice <= this.CHEAP_THRESHOLD && downPrice > 0.05) {
      // Indicators say DOWN and Down token is cheap — great trade
      buyOutcome = "Down";
      buyPrice = downPrice;
      strategy = downPrice <= this.IDEAL_THRESHOLD ? "SMART_IDEAL" : "SMART_CHEAP";
    } else if (upPrice <= this.IDEAL_THRESHOLD && upPrice > 0.05 && scoreDiff <= 2) {
      // Up is super cheap and indicators are mixed — R:R is great enough
      buyOutcome = "Up";
      buyPrice = upPrice;
      strategy = "CHEAP_RR";
    } else if (downPrice <= this.IDEAL_THRESHOLD && downPrice > 0.05 && scoreDiff <= 2) {
      // Down is super cheap and indicators are mixed — R:R is great enough
      buyOutcome = "Down";
      buyPrice = downPrice;
      strategy = "CHEAP_RR";
    }
    
    // ─── VALIDATION ──────────────────────────────────────────
    if (!buyOutcome) {
      // Check if there's a cheap side but indicators disagree
      const cheapSide = upPrice <= this.CHEAP_THRESHOLD ? "Up" : (downPrice <= this.CHEAP_THRESHOLD ? "Down" : null);
      if (cheapSide) {
        const cheapPrice = cheapSide === "Up" ? upPrice : downPrice;
        const indicatorDir = isBull ? "UP" : "DOWN";
        console.log(`[Smart] ⚠ ${cheapSide} is cheap ($${cheapPrice.toFixed(3)}) but indicators say ${indicatorDir} — SKIP (fighting momentum)`);
      } else {
        console.log(`[Smart] ⏳ No cheap tokens: Up $${upPrice.toFixed(3)} / Down $${downPrice.toFixed(3)} > $${this.CHEAP_THRESHOLD}`);
      }
      console.log(`[Smart] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No opportunity (Up $${upPrice.toFixed(2)}, Down $${downPrice.toFixed(2)})` };
    }
    
    // For SMART_CHEAP (not ideal), require minimum indicator agreement
    if (strategy === "SMART_CHEAP" && scoreDiff < this.MIN_SCORE_DIFF) {
      console.log(`[Smart] ⚠ ${buyOutcome} @ $${buyPrice.toFixed(3)} but score diff ${scoreDiff} < ${this.MIN_SCORE_DIFF} — not enough conviction`);
      console.log(`[Smart] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Weak signal (diff ${scoreDiff} < ${this.MIN_SCORE_DIFF})` };
    }
    
    const rr = ((1 - buyPrice) / buyPrice).toFixed(1);
    console.log(`[Smart] ✅ ${strategy}: BUY ${buyOutcome} @ $${buyPrice.toFixed(3)} | R:R ${rr}:1 | Score ${bullScore}v${bearScore}`);
    console.log(`[Smart] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction: buyOutcome === "Up" ? "LONG" : "SHORT",
      targetOutcome: buyOutcome,
      confidence: Math.min(95, 70 + scoreDiff * 5),
      edge: (1.0 - buyPrice) * (scoreDiff / 12),
      marketPrice: buyPrice,
      modelProb: 0.85,
      strategy,
      bullScore, bearScore,
      signals: [`${strategy.toLowerCase()}:${buyOutcome}@$${buyPrice.toFixed(3)}`, `score:${bullScore}v${bearScore}`, ...details],
      reason: `${strategy}: ${buyOutcome} @ $${buyPrice.toFixed(3)} | R:R ${rr}:1 | Score ${bullScore}v${bearScore}`
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EXECUTE TRADE
  // ═══════════════════════════════════════════════════════════════
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

      const price = Math.min(0.95, signal.marketPrice + 0.003);
      const MIN_SHARES = 5;
      let size = Math.floor(this.BET_SIZE_DOLLARS / price);
      if (size < MIN_SHARES) size = MIN_SHARES;
      
      const maxCost = price * size;

      const order = await this.tradingService.placeOrder({
        tokenId,
        side: "BUY",
        price,
        size,
        orderType: "GTC"
      });

      if (!order || !order.orderID) {
        console.log("[Smart] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      const rr = ((1 - price) / price).toFixed(1);
      console.log(`[Smart] ✅ ORDER FILLED: ${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)} | R:R ${rr}:1`);

      // Mark this candle as traded
      const slug = marketData.marketSlug || "";
      this.tradedSlugs.add(slug);
      
      // Update window
      if (this.currentWindow) {
        this.currentWindow.traded = true;
        this.currentWindow.trade = {
          outcome: signal.targetOutcome,
          price, size, cost: maxCost,
          orderId: order.orderID,
          strategy: signal.strategy,
          bullScore: signal.bullScore,
          bearScore: signal.bearScore
        };
      }

      this.lastTradeTime = Date.now();
      this.lastBuyTime = Date.now();
      this.hourlyTrades.push(Date.now());
      
      const trade = {
        timestamp: Date.now(),
        direction: signal.direction,
        outcome: signal.targetOutcome,
        confidence: signal.confidence,
        edge: signal.edge,
        price, size, cost: maxCost,
        orderId: order.orderID,
        marketSlug: marketData.marketSlug
      };

      this.tradeHistory.push(trade);

      // Track position for P&L
      this.positionTracker.addPosition({
        orderId: order.orderID,
        direction: signal.direction,
        outcome: signal.targetOutcome,
        price, size,
        confidence: signal.confidence,
        edge: signal.edge,
        marketSlug: marketData.marketSlug,
        marketEndTime: marketData.marketEndTime || null,
        priceToBeat,
        upPrice: marketData.upPrice,
        downPrice: marketData.downPrice,
        indicators: {},
        bullScore: signal.bullScore || 0,
        bearScore: signal.bearScore || 0,
        signals: signal.signals || [],
        strategy: signal.strategy || "SMART"
      });

      return {
        success: true, trade, order,
        reason: `${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(2)} ($${maxCost.toFixed(2)}) R:R ${rr}:1`
      };

    } catch (error) {
      return { success: false, reason: `Trade failed: ${error.message}`, error };
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
    const w = this.currentWindow;
    return {
      enabled: this.config.enabled,
      totalTrades: this.tradeHistory.length,
      lastTradeTime: this.lastTradeTime,
      activeOrders: this.tradingService.getActiveOrdersCount(),
      pnl: pnlStats,
      tradesThisHour: this._tradesInLastHour(),
      currentWindow: w ? {
        slug: w.slug?.slice(-20),
        traded: w.traded,
        trade: w.trade ? {
          outcome: w.trade.outcome,
          price: w.trade.price,
          size: w.trade.size,
          cost: w.trade.cost,
          strategy: w.trade.strategy,
          bullScore: w.trade.bullScore,
          bearScore: w.trade.bearScore
        } : null
      } : null,
      windowsCompleted: this.windowHistory.length
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
