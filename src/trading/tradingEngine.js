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
    // Buy cheap tokens ONLY when momentum supports the cheap side
    // Problem: tokens are cheap because the market is moving against them
    // Fix: require at least some momentum confirmation before buying
    const cheapThreshold = 0.30; // Lowered from 0.35 — need really cheap
    const hasMomentumData = indicators.delta1m !== undefined || indicators.macdHist !== undefined;
    
    if (hasMomentumData && upPrice && upPrice < cheapThreshold && upPrice > 0.08) {
      // Only buy cheap Up if momentum is NOT strongly bearish
      const bearishMomentum = (indicators.delta1m < 0 && indicators.delta3m < 0) || 
                              (indicators.macdHist !== undefined && indicators.macdHist < -0.5);
      if (!bearishMomentum) {
        console.log(`[Strategy] 🎯 CHEAP UP: $${upPrice.toFixed(3)} < $${cheapThreshold} + momentum OK`);
        return {
          shouldTrade: true,
          direction: "LONG",
          targetOutcome: "Up",
          confidence: 60,
          edge: 0.50 - upPrice,
          marketPrice: upPrice,
          modelProb: 0.50,
          strategy: "CHEAP_TOKEN",
          bullScore: 0, bearScore: 0, signals: [`CHEAP_UP:$${upPrice.toFixed(3)}`, `momentum:OK`],
          reason: `CHEAP Up @ $${upPrice.toFixed(3)} (momentum not against us)`
        };
      } else {
        console.log(`[Strategy] ⚠ CHEAP UP $${upPrice.toFixed(3)} BLOCKED — bearish momentum (falling knife)`);
      }
    }
    if (hasMomentumData && downPrice && downPrice < cheapThreshold && downPrice > 0.08) {
      // Only buy cheap Down if momentum is NOT strongly bullish
      const bullishMomentum = (indicators.delta1m > 0 && indicators.delta3m > 0) || 
                              (indicators.macdHist !== undefined && indicators.macdHist > 0.5);
      if (!bullishMomentum) {
        console.log(`[Strategy] 🎯 CHEAP DOWN: $${downPrice.toFixed(3)} < $${cheapThreshold} + momentum OK`);
        return {
          shouldTrade: true,
          direction: "SHORT",
          targetOutcome: "Down",
          confidence: 60,
          edge: 0.50 - downPrice,
          marketPrice: downPrice,
          modelProb: 0.50,
          strategy: "CHEAP_TOKEN",
          bullScore: 0, bearScore: 0, signals: [`CHEAP_DOWN:$${downPrice.toFixed(3)}`, `momentum:OK`],
          reason: `CHEAP Down @ $${downPrice.toFixed(3)} (momentum not against us)`
        };
      } else {
        console.log(`[Strategy] ⚠ CHEAP DOWN $${downPrice.toFixed(3)} BLOCKED — bullish momentum (falling knife)`);
      }
    }

    // ─── STRATEGY 3: MEAN-REVERSION (overreaction fade) ────────
    // Only fade when the move shows EXHAUSTION signs:
    // 1. Move must be very large (>0.15% — was 0.08% which was too early)
    // 2. RSI must be at extreme (>70 or <30) — confirming overextension
    // 3. MACD histogram must be decelerating — momentum fading
    // Without exhaustion, we're just catching falling knives
    if (ptb && indicators.lastPrice) {
      const currentMove = ((indicators.lastPrice - ptb) / ptb) * 100;
      const sharpMoveThreshold = 0.15; // 0.15% = ~$107 on $71k BTC (was 0.08 — too sensitive)
      
      if (Math.abs(currentMove) > sharpMoveThreshold) {
        // Check for exhaustion signals before fading
        const rsiExtreme = indicators.rsi !== undefined && indicators.rsi !== null &&
          ((currentMove > 0 && indicators.rsi > 70) || (currentMove < 0 && indicators.rsi < 30));
        const macdDecelerating = indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null &&
          ((currentMove > 0 && indicators.macdHistDelta < 0) || (currentMove < 0 && indicators.macdHistDelta > 0));
        
        const exhaustionCount = (rsiExtreme ? 1 : 0) + (macdDecelerating ? 1 : 0);
        
        if (exhaustionCount >= 1) {
          const fadeDirection = currentMove > 0 ? "SHORT" : "LONG";
          const fadeOutcome = fadeDirection === "LONG" ? "Up" : "Down";
          const fadePrice = fadeDirection === "LONG" ? upPrice : downPrice;
          
          if (fadePrice && fadePrice < 0.45) { // Stricter price cap (was 0.52)
            console.log(`[Strategy] 🔄 MEAN-REVERSION: BTC ${currentMove > 0 ? 'UP' : 'DOWN'} ${Math.abs(currentMove).toFixed(3)}% | RSI extreme: ${rsiExtreme} | MACD decel: ${macdDecelerating}`);
            console.log(`[Strategy] Fading with ${fadeOutcome} @ $${fadePrice.toFixed(3)} (exhaustion signals: ${exhaustionCount}/2)`);
            return {
              shouldTrade: true,
              direction: fadeDirection,
              targetOutcome: fadeOutcome,
              confidence: 65,
              edge: 0.50 - fadePrice,
              marketPrice: fadePrice,
              modelProb: 0.55,
              strategy: "MEAN_REVERSION",
              bullScore: 0, bearScore: 0, signals: [`FADE:move=${currentMove.toFixed(3)}%`, `RSI:${indicators.rsi?.toFixed(0)||'?'}`, `exhaustion:${exhaustionCount}/2`],
              reason: `FADE ${currentMove > 0 ? 'UP' : 'DOWN'} (${Math.abs(currentMove).toFixed(3)}%) + exhaustion → ${fadeOutcome} @ $${fadePrice.toFixed(3)}`
            };
          }
        } else {
          console.log(`[Strategy] ⚠ Sharp move ${currentMove.toFixed(3)}% but NO exhaustion (RSI:${indicators.rsi?.toFixed(0)||'?'}, MACD-decel:${macdDecelerating}) — NOT fading`);
        }
      }
    }

    // ─── STRATEGY 4: STRONG MOMENTUM (indicator consensus) ─────
    // Only take momentum trades when indicators OVERWHELMINGLY agree
    let bullScore = 0;
    let bearScore = 0;
    const signals = [];

    // MACD Histogram (weight: 3)
    if (indicators.macdHist !== undefined && indicators.macdHist !== null) {
      if (indicators.macdHist > 0) { bullScore += 3; signals.push(`MACD:BULL(+3)`); }
      else if (indicators.macdHist < 0) { bearScore += 3; signals.push(`MACD:BEAR(+3)`); }
      if (indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null) {
        if (indicators.macdHistDelta > 0 && indicators.macdHist > 0) { bullScore += 1; signals.push(`MACD-exp:BULL(+1)`); }
        else if (indicators.macdHistDelta < 0 && indicators.macdHist < 0) { bearScore += 1; signals.push(`MACD-exp:BEAR(+1)`); }
      }
    }

    // Price vs VWAP (weight: 2)
    if (indicators.priceVsVwap !== undefined) {
      if (indicators.priceVsVwap > 0) { bullScore += 2; signals.push(`VWAP:BULL(+2)`); }
      else if (indicators.priceVsVwap < 0) { bearScore += 2; signals.push(`VWAP:BEAR(+2)`); }
    }

    // VWAP Slope (weight: 2)
    if (indicators.vwapSlope !== undefined && indicators.vwapSlope !== null) {
      if (indicators.vwapSlope > 0) { bullScore += 2; signals.push(`Slope:BULL(+2)`); }
      else if (indicators.vwapSlope < 0) { bearScore += 2; signals.push(`Slope:BEAR(+2)`); }
    }

    // Heiken Ashi (weight: 2, +1 streak bonus)
    if (indicators.heikenColor !== undefined && indicators.heikenColor !== null) {
      if (indicators.heikenColor === "green") {
        bullScore += 2; signals.push(`HA:BULL(+2)`);
        if (indicators.heikenCount >= 3) { bullScore += 1; signals.push(`HA-streak(${indicators.heikenCount}):+1`); }
      } else if (indicators.heikenColor === "red") {
        bearScore += 2; signals.push(`HA:BEAR(+2)`);
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
    console.log(`[Strategy] BULL: ${bullScore} | BEAR: ${bearScore} | Diff: ${scoreDiff}`);
    console.log(`[Strategy] Signals: ${signals.join(', ')}`);

    // STRICT: Need 5+ point advantage for momentum trades (was 3 — too loose)
    const minScoreDiff = 5;
    if (scoreDiff < minScoreDiff) {
      console.log(`[Strategy] ⚠ Momentum too weak (diff ${scoreDiff} < ${minScoreDiff}) — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: false,
        reason: `Weak momentum (BULL:${bullScore} vs BEAR:${bearScore}, need ${minScoreDiff}+ diff)`
      };
    }

    let direction = bullScore > bearScore ? "LONG" : "SHORT";
    let targetOutcome = direction === "LONG" ? "Up" : "Down";
    let marketPrice = direction === "LONG" ? upPrice : downPrice;

    if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
      return { shouldTrade: false, reason: "Invalid market price" };
    }

    // Only buy tokens under 52¢ for momentum trades (stricter than other strategies)
    if (marketPrice > 0.52) {
      console.log(`[Strategy] ⚠ Price too high for momentum ($${marketPrice.toFixed(3)} > $0.52) — SKIP`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Momentum price too high ($${marketPrice.toFixed(2)} > $0.52)` };
    }

    // Spread check
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.05) {
      return { shouldTrade: false, reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 5%)` };
    }

    const indicatorConf = (Math.max(bullScore, bearScore) / (bullScore + bearScore)) * 100;
    console.log(`[Strategy] ✅ MOMENTUM: ${direction} ${targetOutcome} @ $${marketPrice.toFixed(3)} | Conf: ${indicatorConf.toFixed(0)}%`);
    console.log(`[Strategy] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction,
      targetOutcome,
      confidence: indicatorConf,
      edge: Math.max((indicatorConf / 100) - marketPrice, 0.01),
      marketPrice,
      modelProb: indicatorConf / 100,
      strategy: "MOMENTUM",
      bullScore, bearScore, signals,
      reason: `MOMENTUM ${direction} ${bullScore}v${bearScore} @ $${marketPrice.toFixed(2)}`
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
        signals: signal.signals || []
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
