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

    // RULE #4: Enter early for best prices — minute 1 is fine
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      const minLeft = msLeft / 60000;
      const candleMinute = Math.floor(15 - minLeft);
      
      if (minLeft > 14) {
        return { shouldTrade: false, reason: `Too early (min ${candleMinute}/15) — waiting for candle start` };
      }
      if (minLeft < 1) {
        return { shouldTrade: false, reason: `Too late (min ${candleMinute}/15)` };
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

    // ─── STRATEGY 1: ARB / HEDGE ───────────────────────────────
    // If Up + Down < 97¢, buy the cheaper side for guaranteed +EV
    if (combinedPrice !== null && combinedPrice < 0.97) {
      const cheaperSide = upPrice <= downPrice ? "Up" : "Down";
      const cheaperPrice = Math.min(upPrice, downPrice);
      console.log(`[Strategy] ⚡ ARB DETECTED: Combined $${combinedPrice.toFixed(3)} < $0.97 — buying ${cheaperSide} @ $${cheaperPrice.toFixed(3)}`);
      
      return {
        shouldTrade: true,
        direction: cheaperSide === "Up" ? "LONG" : "SHORT",
        targetOutcome: cheaperSide,
        confidence: 95,
        edge: (1 - combinedPrice),
        marketPrice: cheaperPrice,
        modelProb: 0.95,
        strategy: "ARB",
        bullScore: 0, bearScore: 0, signals: [`ARB:combined=$${combinedPrice.toFixed(3)}`],
        reason: `ARB: ${cheaperSide} @ $${cheaperPrice.toFixed(3)} (combined $${combinedPrice.toFixed(3)})`
      };
    }

    // ─── STRATEGY 2: CHEAP TOKEN HARVESTING ────────────────────
    // Buy cheap tokens when momentum supports the direction
    // Need: delta1m + delta3m agree AND MACD supports
    const cheapThreshold = 0.30;
    const hasMomentumData = indicators.delta1m !== undefined && indicators.delta3m !== undefined && indicators.macdHist !== undefined;
    
    if (hasMomentumData && upPrice && upPrice < cheapThreshold && upPrice > 0.08) {
      const deltasAgree = indicators.delta1m > 0 && indicators.delta3m > 0;
      const macdSupports = indicators.macdHist > 0;
      const momentumOK = deltasAgree && macdSupports;
      
      if (momentumOK) {
        console.log(`[Strategy] 🎯 CHEAP UP: $${upPrice.toFixed(3)} < $${cheapThreshold} + momentum OK (deltas:${deltasAgree}, MACD:${macdSupports})`);
        return {
          shouldTrade: true,
          direction: "LONG",
          targetOutcome: "Up",
          confidence: 65,
          edge: 0.50 - upPrice,
          marketPrice: upPrice,
          modelProb: 0.55,
          strategy: "CHEAP_TOKEN",
          bullScore: 0, bearScore: 0, signals: [`CHEAP_UP:$${upPrice.toFixed(3)}`, `deltas:${deltasAgree}`, `MACD:${macdSupports}`],
          reason: `CHEAP Up @ $${upPrice.toFixed(3)} (momentum supports)`
        };
      } else {
        console.log(`[Strategy] ⚠ CHEAP UP $${upPrice.toFixed(3)} BLOCKED — momentum against (Δ1m:${indicators.delta1m?.toFixed(2)}, Δ3m:${indicators.delta3m?.toFixed(2)}, MACD:${indicators.macdHist?.toFixed(2)})`);
      }
    }
    if (hasMomentumData && downPrice && downPrice < cheapThreshold && downPrice > 0.08) {
      const deltasAgree = indicators.delta1m < 0 && indicators.delta3m < 0;
      const macdSupports = indicators.macdHist < 0;
      const momentumOK = deltasAgree && macdSupports;
      
      if (momentumOK) {
        console.log(`[Strategy] 🎯 CHEAP DOWN: $${downPrice.toFixed(3)} < $${cheapThreshold} + momentum OK (deltas:${deltasAgree}, MACD:${macdSupports})`);
        return {
          shouldTrade: true,
          direction: "SHORT",
          targetOutcome: "Down",
          confidence: 65,
          edge: 0.50 - downPrice,
          marketPrice: downPrice,
          modelProb: 0.55,
          strategy: "CHEAP_TOKEN",
          bullScore: 0, bearScore: 0, signals: [`CHEAP_DOWN:$${downPrice.toFixed(3)}`, `deltas:${deltasAgree}`, `MACD:${macdSupports}`],
          reason: `CHEAP Down @ $${downPrice.toFixed(3)} (momentum supports)`
        };
      } else {
        console.log(`[Strategy] ⚠ CHEAP DOWN $${downPrice.toFixed(3)} BLOCKED — momentum against (Δ1m:${indicators.delta1m?.toFixed(2)}, Δ3m:${indicators.delta3m?.toFixed(2)}, MACD:${indicators.macdHist?.toFixed(2)})`);
      }
    }

    // ─── STRATEGY 3: MEAN-REVERSION (DISABLED) ─────────────────
    // Disabled: too risky on 15m BTC, trends continue
    if (ptb && indicators.lastPrice) {
      const currentMove = ((indicators.lastPrice - ptb) / ptb) * 100;
      if (Math.abs(currentMove) > 0.25) {
        console.log(`[Strategy] ⚠ Sharp move ${currentMove.toFixed(3)}% — NOT fading (disabled)`);
      }
    }

    // ─── STRATEGY 4: STRONG MOMENTUM (indicator consensus) ─────
    // Only take momentum trades when indicators OVERWHELMINGLY agree
    // Key learning: losses come from expensive tokens with conflicting signals
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

    // ─── CONFLICT DETECTION ──────────────────────────────────────
    // Check if any major indicator (MACD, VWAP, Heiken) disagrees with direction
    const majorConflict = (macdDir !== 0 && macdDir !== winningDir) ||
                          (vwapDir !== 0 && vwapDir !== winningDir) ||
                          (heikenDir !== 0 && heikenDir !== winningDir);
    const majorsAligned = (macdDir === 0 || macdDir === winningDir) &&
                          (vwapDir === 0 || vwapDir === winningDir) &&
                          (heikenDir === 0 || heikenDir === winningDir);

    if (majorConflict) {
      const conflicting = [];
      if (macdDir !== 0 && macdDir !== winningDir) conflicting.push("MACD");
      if (vwapDir !== 0 && vwapDir !== winningDir) conflicting.push("VWAP");
      if (heikenDir !== 0 && heikenDir !== winningDir) conflicting.push("Heiken");
      console.log(`[Strategy] ⚠ CONFLICT: ${conflicting.join(', ')} disagree with ${winningDir > 0 ? 'BULL' : 'BEAR'} direction`);
    }

    // ─── PRICE-TIERED THRESHOLDS ─────────────────────────────────
    // Cheaper tokens = more forgiving (good risk:reward even on coin-flip)
    // Expensive tokens = need much stronger signal
    let direction = winningDir > 0 ? "LONG" : "SHORT";
    let targetOutcome = direction === "LONG" ? "Up" : "Down";
    let marketPrice = direction === "LONG" ? upPrice : downPrice;

    if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
      return { shouldTrade: false, reason: "Invalid market price" };
    }

    // Max price cap — 47¢ (above this, risk:reward is bad)
    if (marketPrice > 0.47) {
      // If price is too high on winning side, try the OTHER side (which is cheap)
      const otherDirection = direction === "LONG" ? "SHORT" : "LONG";
      const otherOutcome = otherDirection === "LONG" ? "Up" : "Down";
      const otherPrice = otherDirection === "LONG" ? upPrice : downPrice;
      
      if (otherPrice && otherPrice < 0.47 && otherPrice > 0.08) {
        // Switch to the cheaper side — better risk:reward
        direction = otherDirection;
        targetOutcome = otherOutcome;
        marketPrice = otherPrice;
        console.log(`[Strategy] 🔄 Winning side too expensive, switching to ${targetOutcome} @ $${marketPrice.toFixed(3)} (better R:R)`);
      } else {
        console.log(`[Strategy] ⚠ Both sides too expensive — SKIP`);
        console.log(`[Strategy] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Both sides too expensive` };
      }
    }

    // ─── CONFLICT FILTER: Only block for expensive tokens ──────
    // Very cheap tokens (<25¢) have good R:R even with some conflict
    // Everything else needs majors aligned
    if (majorConflict && marketPrice > 0.25) {
      const conflicting = [];
      if (macdDir !== 0 && macdDir !== winningDir) conflicting.push("MACD");
      if (vwapDir !== 0 && vwapDir !== winningDir) conflicting.push("VWAP");
      if (heikenDir !== 0 && heikenDir !== winningDir) conflicting.push("Heiken");
      console.log(`[Strategy] ⚠ CONFLICT at expensive price $${marketPrice.toFixed(3)}: ${conflicting.join(', ')} — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `Major conflict (${conflicting.join(', ')}) at expensive price $${marketPrice.toFixed(2)}`
      };
    }

    // Tiered score requirements — achievable but still selective
    let requiredDiff;
    if (marketPrice < 0.30) {
      requiredDiff = 3; // Cheap: good R:R, moderate signal OK
    } else if (marketPrice < 0.40) {
      requiredDiff = 4; // Medium: need decent signal
    } else {
      requiredDiff = 5; // Expensive: need strong signal
    }

    if (scoreDiff < requiredDiff) {
      // ─── FALLBACK: Always trade once per window ──────────────────
      // If score diff is too low, pick the cheapest side with a lower confidence
      // This ensures we trade every 15 minutes — small size on weak signals
      const cheaperSide = (upPrice && downPrice) ? (upPrice <= downPrice ? "Up" : "Down") : (upPrice ? "Up" : "Down");
      const cheaperPrice = cheaperSide === "Up" ? upPrice : downPrice;
      const fallbackDir = cheaperSide === "Up" ? "LONG" : "SHORT";
      
      if (cheaperPrice && cheaperPrice <= 0.45 && cheaperPrice > 0.08) {
        console.log(`[Strategy] 🔸 FALLBACK: Weak signal (diff ${scoreDiff} < ${requiredDiff}) → ${fallbackDir} ${cheaperSide} @ $${cheaperPrice.toFixed(3)} (cheapest side, small conviction)`);
        console.log(`[Strategy] ══════════════════════════════════════`);
        return {
          shouldTrade: true,
          direction: fallbackDir,
          targetOutcome: cheaperSide,
          confidence: 55,
          edge: Math.max(0.50 - cheaperPrice, 0.02),
          marketPrice: cheaperPrice,
          modelProb: 0.52,
          strategy: "FALLBACK",
          bullScore, bearScore, signals: [...signals, `FALLBACK:cheapest_side`],
          reason: `FALLBACK ${fallbackDir} @ $${cheaperPrice.toFixed(2)} (weak signal, mandatory trade)`
        };
      }
      
      console.log(`[Strategy] ⚠ Score diff ${scoreDiff} < ${requiredDiff} for $${marketPrice.toFixed(2)} tier — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `Weak signal (diff ${scoreDiff} < ${requiredDiff} @ $${marketPrice.toFixed(2)})`
      };
    }

    // Spread check
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.08) {
      return { shouldTrade: false, reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 8%)` };
    }

    const indicatorConf = (Math.max(bullScore, bearScore) / (bullScore + bearScore)) * 100;
    const priceTier = marketPrice < 0.30 ? "CHEAP" : marketPrice < 0.40 ? "MID" : "PREMIUM";
    console.log(`[Strategy] ✅ MOMENTUM [${priceTier}]: ${direction} ${targetOutcome} @ $${marketPrice.toFixed(3)} | Diff: ${scoreDiff}/${requiredDiff} | Conflicts: ${majorConflict ? 'YES' : 'NONE'}`);
    console.log(`[Strategy] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction,
      targetOutcome,
      confidence: indicatorConf,
      edge: Math.max((indicatorConf / 100) - marketPrice, 0.01),
      marketPrice,
      modelProb: indicatorConf / 100,
      strategy: `MOMENTUM_${priceTier}`,
      bullScore, bearScore, signals,
      reason: `MOMENTUM[${priceTier}] ${direction} ${bullScore}v${bearScore} @ $${marketPrice.toFixed(2)}`
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
