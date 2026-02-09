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
    // Early entry = cheapest tokens = biggest potential wins
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
    // Buy cheap tokens ONLY when momentum is ACTIVELY supporting the cheap side
    // Old rule: "not against us" → still lost on flat/choppy markets
    // New rule: momentum must be ACTIVELY FOR us (delta + MACD agree)
    const cheapThreshold = 0.25; // Tighter — need really cheap for good R:R
    const hasMomentumData = indicators.delta1m !== undefined && indicators.delta3m !== undefined;
    
    if (hasMomentumData && upPrice && upPrice < cheapThreshold && upPrice > 0.08) {
      // Buy cheap Up ONLY if momentum is actively bullish
      const bullishMomentum = indicators.delta1m > 0 && indicators.delta3m > 0;
      const macdSupports = indicators.macdHist === undefined || indicators.macdHist > 0;
      if (bullishMomentum && macdSupports) {
        console.log(`[Strategy] 🎯 CHEAP UP: $${upPrice.toFixed(3)} < $${cheapThreshold} + momentum BULLISH + MACD OK`);
        return {
          shouldTrade: true,
          direction: "LONG",
          targetOutcome: "Up",
          confidence: 65,
          edge: 0.50 - upPrice,
          marketPrice: upPrice,
          modelProb: 0.55,
          strategy: "CHEAP_TOKEN",
          bullScore: 0, bearScore: 0, signals: [`CHEAP_UP:$${upPrice.toFixed(3)}`, `Δ1m:+`, `Δ3m:+`, `MACD:OK`],
          reason: `CHEAP Up @ $${upPrice.toFixed(3)} (momentum actively bullish)`
        };
      } else {
        console.log(`[Strategy] ⚠ CHEAP UP $${upPrice.toFixed(3)} BLOCKED — need Δ1m>0(${indicators.delta1m?.toFixed(1)}), Δ3m>0(${indicators.delta3m?.toFixed(1)}), MACD>0(${indicators.macdHist?.toFixed(2)})`);
      }
    }
    if (hasMomentumData && downPrice && downPrice < cheapThreshold && downPrice > 0.08) {
      // Buy cheap Down ONLY if momentum is actively bearish
      const bearishMomentum = indicators.delta1m < 0 && indicators.delta3m < 0;
      const macdSupports = indicators.macdHist === undefined || indicators.macdHist < 0;
      if (bearishMomentum && macdSupports) {
        console.log(`[Strategy] 🎯 CHEAP DOWN: $${downPrice.toFixed(3)} < $${cheapThreshold} + momentum BEARISH + MACD OK`);
        return {
          shouldTrade: true,
          direction: "SHORT",
          targetOutcome: "Down",
          confidence: 65,
          edge: 0.50 - downPrice,
          marketPrice: downPrice,
          modelProb: 0.55,
          strategy: "CHEAP_TOKEN",
          bullScore: 0, bearScore: 0, signals: [`CHEAP_DOWN:$${downPrice.toFixed(3)}`, `Δ1m:-`, `Δ3m:-`, `MACD:OK`],
          reason: `CHEAP Down @ $${downPrice.toFixed(3)} (momentum actively bearish)`
        };
      } else {
        console.log(`[Strategy] ⚠ CHEAP DOWN $${downPrice.toFixed(3)} BLOCKED — need Δ1m<0(${indicators.delta1m?.toFixed(1)}), Δ3m<0(${indicators.delta3m?.toFixed(1)}), MACD<0(${indicators.macdHist?.toFixed(2)})`);
      }
    }

    // ─── STRATEGY 3: MEAN-REVERSION (overreaction fade) ────────
    // STRICT: Only fade when BOTH exhaustion signals confirm:
    // 1. Move must be very large (>0.20% — raised from 0.15%)
    // 2. RSI must be at extreme (>75 or <25) — tighter than before
    // 3. MACD histogram must be decelerating — momentum fading
    // Need BOTH signals — one alone is not enough
    if (ptb && indicators.lastPrice) {
      const currentMove = ((indicators.lastPrice - ptb) / ptb) * 100;
      const sharpMoveThreshold = 0.20; // 0.20% = ~$140 on $70k BTC (raised from 0.15)
      
      if (Math.abs(currentMove) > sharpMoveThreshold) {
        const rsiExtreme = indicators.rsi !== undefined && indicators.rsi !== null &&
          ((currentMove > 0 && indicators.rsi > 75) || (currentMove < 0 && indicators.rsi < 25));
        const macdDecelerating = indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null &&
          ((currentMove > 0 && indicators.macdHistDelta < 0) || (currentMove < 0 && indicators.macdHistDelta > 0));
        
        // STRICT: Need BOTH exhaustion signals
        if (rsiExtreme && macdDecelerating) {
          const fadeDirection = currentMove > 0 ? "SHORT" : "LONG";
          const fadeOutcome = fadeDirection === "LONG" ? "Up" : "Down";
          const fadePrice = fadeDirection === "LONG" ? upPrice : downPrice;
          
          if (fadePrice && fadePrice < 0.35) { // Very strict price cap — only fade into cheap tokens
            console.log(`[Strategy] 🔄 MEAN-REVERSION: BTC ${currentMove > 0 ? 'UP' : 'DOWN'} ${Math.abs(currentMove).toFixed(3)}% | RSI:${indicators.rsi?.toFixed(0)} | MACD decel: YES`);
            console.log(`[Strategy] Fading with ${fadeOutcome} @ $${fadePrice.toFixed(3)} (BOTH exhaustion signals confirmed)`);
            return {
              shouldTrade: true,
              direction: fadeDirection,
              targetOutcome: fadeOutcome,
              confidence: 70,
              edge: 0.50 - fadePrice,
              marketPrice: fadePrice,
              modelProb: 0.60,
              strategy: "MEAN_REVERSION",
              bullScore: 0, bearScore: 0, signals: [`FADE:move=${currentMove.toFixed(3)}%`, `RSI:${indicators.rsi?.toFixed(0)}(extreme)`, `MACD:decelerating`],
              reason: `FADE ${currentMove > 0 ? 'UP' : 'DOWN'} (${Math.abs(currentMove).toFixed(3)}%) + BOTH exhaustion → ${fadeOutcome} @ $${fadePrice.toFixed(3)}`
            };
          }
        } else {
          console.log(`[Strategy] ⚠ Sharp move ${currentMove.toFixed(3)}% but need BOTH exhaustion (RSI extreme:${rsiExtreme}, MACD decel:${macdDecelerating}) — NOT fading`);
        }
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

    // RSI (weight: 1)
    if (indicators.rsi !== undefined && indicators.rsi !== null) {
      if (indicators.rsi > 55) { bullScore += 1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):BULL`); }
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

    // Max price cap — lowered to 45¢
    if (marketPrice > 0.45) {
      console.log(`[Strategy] ⚠ Price too high ($${marketPrice.toFixed(3)} > $0.45) — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Price too high ($${marketPrice.toFixed(2)} > $0.45)` };
    }

    // ─── UNIVERSAL: NO major conflicts allowed at ANY price ──────
    // Key insight: trades with conflicting major indicators lose ~50%
    // To hit 75% WR, we MUST have all majors agreeing
    if (majorConflict) {
      const conflicting = [];
      if (macdDir !== 0 && macdDir !== winningDir) conflicting.push("MACD");
      if (vwapDir !== 0 && vwapDir !== winningDir) conflicting.push("VWAP");
      if (heikenDir !== 0 && heikenDir !== winningDir) conflicting.push("Heiken");
      console.log(`[Strategy] ⚠ BLOCKED: ${conflicting.join(', ')} conflict — ALL majors must agree for 75% WR`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `Major conflict (${conflicting.join(', ')}) — need all majors aligned`
      };
    }

    // Tiered score requirements based on price
    let requiredDiff;
    if (marketPrice < 0.25) {
      // Very cheap: great risk:reward, but still need decent signal
      requiredDiff = 6;
    } else if (marketPrice < 0.35) {
      // Medium: need strong signal
      requiredDiff = 7;
    } else {
      // Expensive (35-45¢): need overwhelming signal
      requiredDiff = 8;
    }

    if (scoreDiff < requiredDiff) {
      console.log(`[Strategy] ⚠ Score diff ${scoreDiff} < ${requiredDiff} (required for $${marketPrice.toFixed(2)} price tier) — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `Weak signal for price tier (diff ${scoreDiff} < ${requiredDiff} @ $${marketPrice.toFixed(2)})`
      };
    }

    // Spread check
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.05) {
      return { shouldTrade: false, reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 5%)` };
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
