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
    
    // Streak tracking for mean-reversion edge
    this.outcomeHistory = [];  // ["Up","Down","Up",...] actual BTC results
    this.maxOutcomeHistory = 10;
  }

  _tradesInLastHour() {
    const oneHourAgo = Date.now() - 3600000;
    this.hourlyTrades = this.hourlyTrades.filter(t => t > oneHourAgo);
    return this.hourlyTrades.length;
  }

  // Derive actual BTC direction from resolved positions
  _updateOutcomeHistory() {
    const closed = this.positionTracker.closedPositions;
    this.outcomeHistory = [];
    for (const pos of closed.slice(-this.maxOutcomeHistory)) {
      let actualDir;
      if (pos.status === "RESOLVED_WIN") {
        actualDir = pos.outcome; // Won → BTC went the way we bet
      } else {
        actualDir = pos.outcome === "Up" ? "Down" : "Up"; // Lost → opposite
      }
      this.outcomeHistory.push(actualDir);
    }
  }

  // Get the recent streak of same-direction outcomes
  _getRecentStreak() {
    this._updateOutcomeHistory();
    if (this.outcomeHistory.length === 0) return { direction: null, length: 0 };
    const last = this.outcomeHistory[this.outcomeHistory.length - 1];
    let count = 0;
    for (let i = this.outcomeHistory.length - 1; i >= 0; i--) {
      if (this.outcomeHistory[i] === last) count++;
      else break;
    }
    return { direction: last, length: count };
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

    const now = Date.now();

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

    // RULE #4: Enter in first 9 minutes of candle (min 1-9)
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      const minLeft = msLeft / 60000;
      const candleMinute = Math.floor(15 - minLeft);
      
      if (minLeft > 14) {
        return { shouldTrade: false, reason: `Too early (min ${candleMinute}/15) — waiting for candle start` };
      }
      if (minLeft < 6) {
        return { shouldTrade: false, reason: `Too late (min ${candleMinute}/15, ${minLeft.toFixed(1)} min left) — stale signal` };
      }
      
      console.log(`[Timing] Candle minute: ${candleMinute}/15 | ${minLeft.toFixed(1)} min left`);
    }

    // ═══════════════════════════════════════════════════════════════
    // MULTI-STRATEGY ENGINE: Arb → Mean-Reversion → Momentum
    // Pure direction prediction is ~50% on 15m BTC. Instead we find
    // +EV entries through market inefficiencies and selective signals.
    // ═══════════════════════════════════════════════════════════════

    const upPrice = marketData.upPrice;
    const downPrice = marketData.downPrice;
    const combinedPrice = (upPrice && downPrice) ? upPrice + downPrice : null;
    const ptb = marketData.priceToBeat;

    console.log(`[Strategy] ══════════════════════════════════════`);
    console.log(`[Strategy] Up: $${upPrice?.toFixed(3) || 'N/A'} | Down: $${downPrice?.toFixed(3) || 'N/A'} | Combined: $${combinedPrice?.toFixed(3) || 'N/A'}`);

    // ═══════════════════════════════════════════════════════════════
    // R:R FIRST STRATEGY — exploit cheap mispricing, not direction
    //
    // Key insight: predicting BTC direction on 15m is ~50/50.
    // But a 25¢ token pays $1 on win = 3:1 R:R.
    // At 3:1 R:R, we only need >25% accuracy to profit.
    // At 2:1 R:R (33¢), we need >33% accuracy.
    // At 1:1 R:R (50¢), we need >50% accuracy (coin flip = lose to fees).
    //
    // So: ONLY buy cheap tokens where R:R gives us a mathematical edge.
    // Use indicators only to pick which cheap side to buy.
    // ═══════════════════════════════════════════════════════════════

    // ─── INDICATOR SCORING ─────────────────────────────────────
    let bullScore = 0;
    let bearScore = 0;
    const signals = [];

    // Track individual major indicator directions for conflict detection
    let macdDir = 0;   // +1 bull, -1 bear, 0 neutral
    let vwapDir = 0;
    let heikenDir = 0;

    // MACD Histogram (weight: 3)
    if (indicators.macdHist !== undefined && indicators.macdHist !== null) {
      if (indicators.macdHist > 0) { bullScore += 3; macdDir = 1; signals.push(`MACD:BULL(+3)`); }
      else if (indicators.macdHist < 0) { bearScore += 3; macdDir = -1; signals.push(`MACD:BEAR(+3)`); }
      if (indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null) {
        if (indicators.macdHistDelta > 0 && indicators.macdHist > 0) { bullScore += 1; signals.push(`MACD-exp:BULL(+1)`); }
        else if (indicators.macdHistDelta < 0 && indicators.macdHist < 0) { bearScore += 1; signals.push(`MACD-exp:BEAR(+1)`); }
      }
    }

    // Price vs VWAP (weight: 2)
    if (indicators.priceVsVwap !== undefined) {
      if (indicators.priceVsVwap > 0) { bullScore += 2; vwapDir = 1; signals.push(`VWAP:BULL(+2)`); }
      else if (indicators.priceVsVwap < 0) { bearScore += 2; vwapDir = -1; signals.push(`VWAP:BEAR(+2)`); }
    }

    // VWAP Slope (weight: 2)
    if (indicators.vwapSlope !== undefined && indicators.vwapSlope !== null) {
      if (indicators.vwapSlope > 0) { bullScore += 2; signals.push(`Slope:BULL(+2)`); }
      else if (indicators.vwapSlope < 0) { bearScore += 2; signals.push(`Slope:BEAR(+2)`); }
    }

    // Heiken Ashi (weight: 2, +1 streak bonus)
    if (indicators.heikenColor !== undefined && indicators.heikenColor !== null) {
      if (indicators.heikenColor === "green") {
        bullScore += 2; heikenDir = 1; signals.push(`HA:BULL(+2)`);
        if (indicators.heikenCount >= 3) { bullScore += 1; signals.push(`HA-streak(${indicators.heikenCount}):+1`); }
      } else if (indicators.heikenColor === "red") {
        bearScore += 2; heikenDir = -1; signals.push(`HA:BEAR(+2)`);
        if (indicators.heikenCount >= 3) { bearScore += 1; signals.push(`HA-streak(${indicators.heikenCount}):+1`); }
      }
    }

    // RSI (weight: 1, extreme bonus: +2)
    if (indicators.rsi !== undefined && indicators.rsi !== null) {
      if (indicators.rsi > 70) { bearScore += 3; signals.push(`RSI(${indicators.rsi.toFixed(0)}):OVERBOUGHT(+3bear)`); }
      else if (indicators.rsi < 30) { bullScore += 3; signals.push(`RSI(${indicators.rsi.toFixed(0)}):OVERSOLD(+3bull)`); }
      else if (indicators.rsi > 55) { bullScore += 1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):BULL`); }
      else if (indicators.rsi < 45) { bearScore += 1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):BEAR`); }
      else { signals.push(`RSI(${indicators.rsi.toFixed(0)}):NEUT`); }
    }

    // Delta 1m (weight: 1)
    if (indicators.delta1m !== undefined && indicators.delta1m !== null) {
      if (indicators.delta1m > 0) { bullScore += 1; signals.push(`Δ1m:BULL`); }
      else if (indicators.delta1m < 0) { bearScore += 1; signals.push(`Δ1m:BEAR`); }
    }

    // Delta 3m (weight: 1)
    if (indicators.delta3m !== undefined && indicators.delta3m !== null) {
      if (indicators.delta3m > 0) { bullScore += 1; signals.push(`Δ3m:BULL`); }
      else if (indicators.delta3m < 0) { bearScore += 1; signals.push(`Δ3m:BEAR`); }
    }

    const scoreDiff = Math.abs(bullScore - bearScore);
    const winningDir = bullScore > bearScore ? 1 : -1; // +1 = bull, -1 = bear
    console.log(`[Strategy] BULL: ${bullScore} | BEAR: ${bearScore} | Diff: ${scoreDiff}`);
    console.log(`[Strategy] Signals: ${signals.join(', ')}`);

    const majorsAligned = (macdDir === 0 || macdDir === winningDir) &&
                          (vwapDir === 0 || vwapDir === winningDir) &&
                          (heikenDir === 0 || heikenDir === winningDir);

    // ─── DIRECTION & PRICE ─────────────────────────────────────
    let direction = winningDir > 0 ? "LONG" : "SHORT";
    let targetOutcome = direction === "LONG" ? "Up" : "Down";
    let marketPrice = direction === "LONG" ? upPrice : downPrice;

    if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
      return { shouldTrade: false, reason: "Invalid market price" };
    }

    // ─── TIERED R:R GATE ──────────────────────────────────────
    // Cheaper = easier to trade (good R:R covers mistakes)
    // Expensive = much stricter (bad R:R needs high accuracy)
    //
    // TIER 1 (≤33¢): 2:1+ R:R — need diff≥4, at least 2/3 majors agree
    // TIER 2 (≤42¢): 1.4:1+ R:R — need diff≥6, ALL majors agree
    // TIER 3 (≤48¢): 1.1:1+ R:R — need diff≥8, ALL majors agree
    // BLOCKED (>48¢): R:R too low, never trade

    const MAX_PRICE = 0.48;
    if (marketPrice > MAX_PRICE) {
      console.log(`[Strategy] ⚠ ${targetOutcome} @ $${marketPrice.toFixed(3)} > $${MAX_PRICE} — BLOCKED`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Price $${marketPrice.toFixed(2)} > $${MAX_PRICE} — R:R too low` };
    }

    // Count how many majors agree (0-3)
    const majorsAgreeCount = (macdDir === 0 || macdDir === winningDir ? 1 : 0) +
                             (vwapDir === 0 || vwapDir === winningDir ? 1 : 0) +
                             (heikenDir === 0 || heikenDir === winningDir ? 1 : 0);

    let requiredDiff, requiredMajors, tier;
    if (marketPrice <= 0.33) {
      requiredDiff = 4;
      requiredMajors = 2;
      tier = "CHEAP";
    } else if (marketPrice <= 0.42) {
      requiredDiff = 6;
      requiredMajors = 3;
      tier = "MID";
    } else {
      requiredDiff = 8;
      requiredMajors = 3;
      tier = "PREMIUM";
    }

    if (majorsAgreeCount < requiredMajors) {
      const conflicting = [];
      if (macdDir !== 0 && macdDir !== winningDir) conflicting.push("MACD");
      if (vwapDir !== 0 && vwapDir !== winningDir) conflicting.push("VWAP");
      if (heikenDir !== 0 && heikenDir !== winningDir) conflicting.push("Heiken");
      console.log(`[Strategy] ⚠ [${tier}] Majors ${majorsAgreeCount}/3 < ${requiredMajors} needed: ${conflicting.join(', ')} disagree — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `[${tier}] Majors ${majorsAgreeCount}/${requiredMajors} (${conflicting.join(', ')} disagree)`
      };
    }

    if (scoreDiff < requiredDiff) {
      console.log(`[Strategy] ⚠ [${tier}] Score diff ${scoreDiff} < ${requiredDiff} — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `[${tier}] Weak signal (diff ${scoreDiff} < ${requiredDiff})`
      };
    }

    // Spread check
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.08) {
      return { shouldTrade: false, reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 8%)` };
    }

    // ─── TRADE! ────────────────────────────────────────────────
    const rr = ((1 - marketPrice) / marketPrice).toFixed(1);
    const indicatorConf = (Math.max(bullScore, bearScore) / (bullScore + bearScore)) * 100;
    console.log(`[Strategy] ✅ [${tier}] TRADE: ${direction} ${targetOutcome} @ $${marketPrice.toFixed(3)} | R:R ${rr}:1 | Diff: ${scoreDiff}/${requiredDiff} | Majors: ${majorsAgreeCount}/3`);
    console.log(`[Strategy] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction,
      targetOutcome,
      confidence: indicatorConf,
      edge: Math.max((indicatorConf / 100) - marketPrice, 0.01),
      marketPrice,
      modelProb: indicatorConf / 100,
      strategy: `RR_${tier}`,
      bullScore, bearScore, signals,
      reason: `[${tier}] R:R ${rr}:1 | ${direction} ${bullScore}v${bearScore} @ $${marketPrice.toFixed(2)} | Majors ${majorsAgreeCount}/3`
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

      // Track position for P&L (with extra data for enhanced analysis)
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
        priceToBeat,  // Store market opening price for correct win/loss determination
        upPrice: marketData.upPrice,
        downPrice: marketData.downPrice,
        indicators: signal.indicators || {},
        bullScore: signal.bullScore || 0,
        bearScore: signal.bearScore || 0,
        signals: signal.signals || [],
        strategy: signal.strategy || "UNKNOWN"
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
