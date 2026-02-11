import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// HYBRID v4 — CONVICTION + DIPARB FALLBACK
//
// Priority 1: CONVICTION — All 4 indicators agree → directional $5-8
//   Requires: VWAP slope + MACD cross + RSI extreme + Heiken streak
//   Token must be ≤45¢ (good R:R). Bigger bet, no hedge needed.
//
// Priority 2: DIPARB — Mixed signals → hedged pair $2-3 per leg
//   Same as v3: buy both sides cheap, lock profit.
//   Only when conviction criteria NOT met.
//
// Guardrails:
//   - Daily drawdown stop: -$10 → halt trading for the day
//   - No revenge betting: reduce size after 2 consecutive losses
//   - Max 10% capital at risk across all open positions
//   - Circuit breaker at $15 total exposure
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
    
    // ═══ CONVICTION MODE PARAMETERS ══════════════════════
    this.CONVICTION_SIZE = 5;        // $5 per conviction trade (5-7% of ~$80 capital)
    this.CONVICTION_MAX_PRICE = 0.45;// Max token price for conviction (good R:R)
    this.CONVICTION_MIN_SCORE = 4;   // Need 4/4 indicators agreeing
    this.CONVICTION_COOLDOWN = 60000;// 60s between conviction trades
    
    // ═══ DIPARB FALLBACK PARAMETERS ══════════════════════
    this.currentWindow = null;
    this.windowHistory = [];
    this.CHEAP_THRESHOLD = 0.35;     // Base max price (min 2-3)
    this.CHEAP_THRESHOLD_MID = 0.40; // After min 4
    this.CHEAP_THRESHOLD_LATE = 0.45;// After min 6
    this.HEDGE_THRESHOLD = 0.55;     // Late hedge (min 5+)
    this.MAX_OPPOSITE_FOR_ENTRY = 0.55;
    this.MAX_PAIR_ASK = 0.985;
    this.DIPARB_SIZE = 2;            // $2 per DipArb leg (smaller — fallback)
    this.LATE_HEDGE_SIZE = 2;
    this.MAX_WINDOW_SPEND = 6;       // Max $6 per DipArb window
    
    // ═══ SHARED PARAMETERS ══════════════════════════════
    this.MIN_BUY_COOLDOWN = 30000;   // 30s between any buys
    this.MIN_CANDLE_MINUTE = 2;      // Don't trade first 2 min
    this.SKIP_AFTER_MINUTE = 8;      // Extended — conviction can trade later
    this.LATE_HEDGE_MINUTE = 5;
    this.MIN_BTC_MOVE_PCT = 0.15;
    
    // ═══ GUARDRAILS ═════════════════════════════════════
    this.DAILY_DRAWDOWN_LIMIT = -10;  // Stop trading if daily P&L < -$10
    this.MAX_EXPOSURE = 15;           // Circuit breaker
    this.LOSS_STREAK_REDUCE = 2;      // After 2 consecutive losses, reduce size
    
    // ═══ TRACKING ══════════════════════════════════════
    this.lastBuyTime = 0;
    this.consecutiveDownWins = 0;
    this.consecutiveUpWins = 0;
    this.consecutiveLosses = 0;       // For revenge-bet prevention
    this.dailyPnl = 0;               // Reset each day
    this.dailyResetDate = new Date().toDateString();
    this.convictionTrades = 0;        // Today's conviction trade count
    this.diparbTrades = 0;            // Today's diparb trade count
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
      qtyUp: 0, costUp: 0,
      qtyDown: 0, costDown: 0,
      buys: [],
      locked: false,
      startPairCost: null,
      createdAt: Date.now()
    };
    console.log(`[Hybrid] 🆕 New window: ${slug.slice(-20)}`);
    return this.currentWindow;
  }

  _archiveWindow() {
    if (!this.currentWindow) return;
    const w = this.currentWindow;
    const totalSpent = w.costUp + w.costDown;
    const minQty = Math.min(w.qtyUp, w.qtyDown);
    
    if (totalSpent > 0) {
      const pairCost = this._calcPairCost(w);
      const pairValue = minQty * 1.0;
      const estProfit = pairValue - totalSpent;
      const balanceRatio = minQty > 0 ? (Math.min(w.qtyUp, w.qtyDown) / Math.max(w.qtyUp, w.qtyDown) * 100).toFixed(0) : 0;
      console.log(`[Hybrid] 📦 Archived | Spent: $${totalSpent.toFixed(2)} | Pairs: ${minQty} | PairCost: ${pairCost ? '$' + pairCost.toFixed(3) : 'N/A'} | Balance: ${balanceRatio}% | Est P&L: $${estProfit.toFixed(2)} | ${w.locked ? '🔒LOCKED' : '⚠OPEN'}`);
      if (pairCost && pairCost > 1.0) {
        console.log(`[Hybrid] ⚠ WARNING: Final pair cost $${pairCost.toFixed(3)} > $1.00 — hedge failed!`);
      }
      this.windowHistory.push({ ...w, archivedAt: Date.now(), totalSpent, minQty, estProfit, pairCost });
    }
    this.currentWindow = null;
  }

  _calcPairCost(w) {
    if (w.qtyUp === 0 || w.qtyDown === 0) return null;
    return (w.costUp / w.qtyUp) + (w.costDown / w.qtyDown);
  }

  // ─── DAILY RESET ──────────────────────────────────────────────
  _checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      console.log(`[Hybrid] 📅 New day — resetting daily counters (prev P&L: $${this.dailyPnl.toFixed(2)})`);
      this.dailyPnl = 0;
      this.dailyResetDate = today;
      this.convictionTrades = 0;
      this.diparbTrades = 0;
      this.consecutiveLosses = 0;
    }
  }

  // ─── CONVICTION SCORING ───────────────────────────────────────
  // Score 4 indicators: each votes BULL (+1) or BEAR (-1) or NEUTRAL (0)
  // All 4 must agree for conviction trade
  _scoreConviction(indicators) {
    let bullVotes = 0;
    let bearVotes = 0;
    const votes = [];

    // 1. VWAP SLOPE — trend direction
    const vwapSlope = indicators.vwapSlope;
    if (vwapSlope !== null && vwapSlope !== undefined) {
      if (vwapSlope > 0.5) { bullVotes++; votes.push("VWAP:BULL"); }
      else if (vwapSlope < -0.5) { bearVotes++; votes.push("VWAP:BEAR"); }
      else { votes.push("VWAP:NEUTRAL"); }
    }

    // 2. MACD HISTOGRAM — momentum
    const macdHist = indicators.macdHist;
    const macdDelta = indicators.macdHistDelta;
    if (macdHist !== null && macdHist !== undefined) {
      if (macdHist > 0 && (macdDelta === null || macdDelta >= 0)) { bullVotes++; votes.push("MACD:BULL"); }
      else if (macdHist < 0 && (macdDelta === null || macdDelta <= 0)) { bearVotes++; votes.push("MACD:BEAR"); }
      else { votes.push("MACD:NEUTRAL"); }
    }

    // 3. RSI — overbought/oversold with direction
    const rsi = indicators.rsi;
    if (rsi !== null && rsi !== undefined) {
      if (rsi > 55) { bullVotes++; votes.push(`RSI:BULL(${rsi.toFixed(0)})`); }
      else if (rsi < 45) { bearVotes++; votes.push(`RSI:BEAR(${rsi.toFixed(0)})`); }
      else { votes.push(`RSI:NEUTRAL(${rsi.toFixed(0)})`); }
    }

    // 4. HEIKEN ASHI — trend confirmation
    const hColor = indicators.heikenColor;
    const hCount = indicators.heikenCount || 0;
    if (hColor === "green" && hCount >= 2) { bullVotes++; votes.push(`HA:BULL(${hCount})`); }
    else if (hColor === "red" && hCount >= 2) { bearVotes++; votes.push(`HA:BEAR(${hCount})`); }
    else { votes.push(`HA:NEUTRAL`); }

    const direction = bullVotes > bearVotes ? "LONG" : bearVotes > bullVotes ? "SHORT" : "NEUTRAL";
    const score = Math.max(bullVotes, bearVotes);
    const unanimous = (bullVotes >= 4 || bearVotes >= 4);

    return { direction, score, bullVotes, bearVotes, unanimous, votes };
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // HYBRID v4: Conviction first → DipArb fallback
  // ═══════════════════════════════════════════════════════════════
  shouldTrade(prediction, marketData, currentPrice, indicators = {}) {
    if (!this.config.enabled) {
      return { shouldTrade: false, reason: "Trading disabled" };
    }
    if (!prediction || !marketData) {
      return { shouldTrade: false, reason: "Missing prediction or market data" };
    }

    this._checkDailyReset();

    const now = Date.now();
    const upPrice = marketData.upPrice;
    const downPrice = marketData.downPrice;
    const slug = marketData.marketSlug || "";

    if (!upPrice || !downPrice || upPrice <= 0 || downPrice <= 0) {
      return { shouldTrade: false, reason: "Invalid prices" };
    }

    const combinedPrice = upPrice + downPrice;

    // ═══ GUARDRAILS ═══════════════════════════════════════════
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= this.MAX_EXPOSURE) {
      return { shouldTrade: false, reason: `Circuit breaker: exposure $${totalExposure.toFixed(2)} >= $${this.MAX_EXPOSURE}` };
    }

    // Daily drawdown stop
    if (this.dailyPnl <= this.DAILY_DRAWDOWN_LIMIT) {
      return { shouldTrade: false, reason: `Daily drawdown stop: $${this.dailyPnl.toFixed(2)} <= $${this.DAILY_DRAWDOWN_LIMIT}` };
    }

    // ─── TIMING ──────────────────────────────────────────────
    let minLeft = 15;
    let candleMinute = 0;
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      minLeft = msLeft / 60000;
      candleMinute = Math.floor(15 - minLeft);
      
      if (candleMinute < this.MIN_CANDLE_MINUTE) {
        return { shouldTrade: false, reason: `Too early (min ${candleMinute}/15)` };
      }
    }

    // Cooldown check
    if ((now - this.lastBuyTime) < this.MIN_BUY_COOLDOWN) {
      return { shouldTrade: false, reason: "Cooldown" };
    }

    // ─── SCORE CONVICTION ────────────────────────────────────
    const conviction = this._scoreConviction(indicators);
    const btcDelta3m = indicators.delta3m || 0;
    const btcMovePct = Math.abs(btcDelta3m);

    console.log(`[Hybrid] ══════════════════════════════════════`);
    console.log(`[Hybrid] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Min ${candleMinute}/15`);
    console.log(`[Hybrid] Conviction: ${conviction.score}/4 ${conviction.direction} [${conviction.votes.join(", ")}]`);
    console.log(`[Hybrid] Daily P&L: $${this.dailyPnl.toFixed(2)} | Losses: ${this.consecutiveLosses} | Conv: ${this.convictionTrades} | Arb: ${this.diparbTrades}`);

    // ═══════════════════════════════════════════════════════════
    // PRIORITY 1: CONVICTION TRADE — 4/4 indicators agree
    // Directional bet, bigger size, no hedge needed
    // ═══════════════════════════════════════════════════════════
    if (conviction.score >= this.CONVICTION_MIN_SCORE && conviction.direction !== "NEUTRAL") {
      const isLong = conviction.direction === "LONG";
      const targetOutcome = isLong ? "Up" : "Down";
      const targetPrice = isLong ? upPrice : downPrice;

      // Token must be cheap enough for good R:R
      if (targetPrice <= this.CONVICTION_MAX_PRICE && targetPrice > 0.05) {
        // Reduce size after consecutive losses (no revenge betting)
        let dollars = this.CONVICTION_SIZE;
        if (this.consecutiveLosses >= this.LOSS_STREAK_REDUCE) {
          dollars = Math.max(2, Math.floor(dollars * 0.6));
          console.log(`[Hybrid] ⚠ Loss streak ${this.consecutiveLosses} — reduced conviction to $${dollars}`);
        }

        const rr = ((1 - targetPrice) / targetPrice).toFixed(1);
        console.log(`[Hybrid] 🎯 CONVICTION ${conviction.direction} | ${targetOutcome} @ $${targetPrice.toFixed(3)} | R:R ${rr}:1 | $${dollars}`);
        console.log(`[Hybrid] ══════════════════════════════════════`);

        return {
          shouldTrade: true,
          direction: conviction.direction,
          targetOutcome,
          confidence: conviction.score * 25,
          edge: 1.0 - targetPrice,
          marketPrice: targetPrice,
          modelProb: conviction.score / 4,
          strategy: "CONVICTION",
          isConviction: true,
          isLateHedge: false,
          applyLongDiscount: false,
          convictionDollars: dollars,
          bullScore: conviction.bullVotes,
          bearScore: conviction.bearVotes,
          signals: conviction.votes,
          reason: `🎯 CONVICTION ${targetOutcome} @ $${targetPrice.toFixed(3)} | ${conviction.votes.join("+")} | R:R ${rr}:1`
        };
      } else {
        console.log(`[Hybrid] 🎯 Conviction ${conviction.direction} but ${targetOutcome} $${targetPrice.toFixed(3)} > $${this.CONVICTION_MAX_PRICE} — too expensive, fall through to DipArb`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // PRIORITY 2: DIPARB FALLBACK — mixed signals, hedge both sides
    // ═══════════════════════════════════════════════════════════
    const window = this._getOrCreateWindow(slug);
    const totalSpent = window.costUp + window.costDown;

    // Profit lock
    const minQty = Math.min(window.qtyUp, window.qtyDown);
    if (minQty > 0 && (minQty * 1.0) > totalSpent) {
      window.locked = true;
      const pairCost = this._calcPairCost(window);
      const profit = minQty * 1.0 - totalSpent;
      console.log(`[Hybrid] 🔒 PROFIT LOCKED! ${minQty} pairs | +$${profit.toFixed(2)}`);
      return { shouldTrade: false, reason: `Profit locked! ${minQty} pairs +$${profit.toFixed(2)}` };
    }

    if (totalSpent >= this.MAX_WINDOW_SPEND) {
      return { shouldTrade: false, reason: `Window budget exhausted ($${totalSpent.toFixed(2)})` };
    }

    const btcDirection = btcDelta3m > 0 ? "UP" : btcDelta3m < 0 ? "DOWN" : "FLAT";
    const effectiveCheap = candleMinute >= 6 ? this.CHEAP_THRESHOLD_LATE
                         : candleMinute >= 4 ? this.CHEAP_THRESHOLD_MID
                         : this.CHEAP_THRESHOLD;

    let buyOutcome = null;
    let buyPrice = null;
    let buyReason = "";
    let isLateHedge = false;

    const hasUp = window.qtyUp > 0;
    const hasDown = window.qtyDown > 0;
    const upCheap = upPrice <= effectiveCheap && upPrice > 0.05;
    const downCheap = downPrice <= effectiveCheap && downPrice > 0.05;

    // ─── HEDGE existing DipArb positions ──────────────────
    if (hasUp && !hasDown) {
      if (downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "HEDGE (need Down)";
      } else if (candleMinute >= this.LATE_HEDGE_MINUTE && downPrice <= this.HEDGE_THRESHOLD) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = `LATE_HEDGE (min ${candleMinute})`;
        isLateHedge = true;
      } else {
        console.log(`[Hybrid] ⏳ DipArb: waiting for Down hedge (Down $${downPrice.toFixed(3)} > $${effectiveCheap.toFixed(2)})`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for Down hedge` };
      }
    } else if (hasDown && !hasUp) {
      if (upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "HEDGE (need Up)";
      } else if (candleMinute >= this.LATE_HEDGE_MINUTE && upPrice <= this.HEDGE_THRESHOLD) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = `LATE_HEDGE (min ${candleMinute})`;
        isLateHedge = true;
      } else {
        console.log(`[Hybrid] ⏳ DipArb: waiting for Up hedge (Up $${upPrice.toFixed(3)} > $${effectiveCheap.toFixed(2)})`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for Up hedge` };
      }
    } else if (hasUp && hasDown) {
      // Rebalance
      if (window.qtyUp < window.qtyDown && upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "REBALANCE (Up qty low)";
      } else if (window.qtyDown < window.qtyUp && downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "REBALANCE (Down qty low)";
      }
    } else {
      // ─── NEW DIPARB POSITION ────────────────────────────
      if (candleMinute > this.SKIP_AFTER_MINUTE) {
        console.log(`[Hybrid] ⏳ Too late for new DipArb (min ${candleMinute})`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Too late (min ${candleMinute})` };
      }

      // Hedgeability gate: only enter if opposite side is hedgeable
      if (upCheap && downPrice > this.MAX_OPPOSITE_FOR_ENTRY && !downCheap) {
        console.log(`[Hybrid] ⛔ DipArb: Up cheap but Down $${downPrice.toFixed(3)} > $${this.MAX_OPPOSITE_FOR_ENTRY} — can't hedge`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Can't hedge: Down $${downPrice.toFixed(2)} too expensive` };
      }
      if (downCheap && upPrice > this.MAX_OPPOSITE_FOR_ENTRY && !upCheap) {
        console.log(`[Hybrid] ⛔ DipArb: Down cheap but Up $${upPrice.toFixed(3)} > $${this.MAX_OPPOSITE_FOR_ENTRY} — can't hedge`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Can't hedge: Up $${upPrice.toFixed(2)} too expensive` };
      }

      // Require BTC movement
      if (btcMovePct < this.MIN_BTC_MOVE_PCT) {
        console.log(`[Hybrid] ⏳ Low vol for DipArb: ${(btcMovePct * 100).toFixed(2)}% < ${(this.MIN_BTC_MOVE_PCT * 100).toFixed(1)}%`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Low vol (${(btcMovePct * 100).toFixed(2)}%)` };
      }

      // Pick side based on momentum
      if (upCheap && downCheap) {
        if (btcDirection === "UP") { buyOutcome = "Up"; buyPrice = upPrice; }
        else { buyOutcome = "Down"; buyPrice = downPrice; }
        buyReason = "DIPARB_INIT (both cheap)";
      } else if (upCheap && btcDirection === "UP") {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "DIPARB_INIT (Up cheap + rising)";
      } else if (downCheap && btcDirection === "DOWN") {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "DIPARB_INIT (Down cheap + falling)";
      } else {
        console.log(`[Hybrid] ⏳ DipArb: no aligned cheap side`);
        console.log(`[Hybrid] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `No aligned cheap side for DipArb` };
      }
    }

    if (!buyOutcome) {
      console.log(`[Hybrid] ⏳ No trade opportunity`);
      console.log(`[Hybrid] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No trade opportunity` };
    }

    // Simulate pair cost for DipArb
    const tradeDollars = isLateHedge ? this.LATE_HEDGE_SIZE : this.DIPARB_SIZE;
    if (window.buys.length > 0) {
      const simSize = Math.floor(tradeDollars / buyPrice);
      const simCost = buyPrice * simSize;
      const simUp = window.qtyUp + (buyOutcome === "Up" ? simSize : 0);
      const simDown = window.qtyDown + (buyOutcome === "Down" ? simSize : 0);
      const simCostUp = window.costUp + (buyOutcome === "Up" ? simCost : 0);
      const simCostDown = window.costDown + (buyOutcome === "Down" ? simCost : 0);
      
      if (simUp > 0 && simDown > 0) {
        const simPairCost = (simCostUp / simUp) + (simCostDown / simDown);
        if (simPairCost >= 1.0) {
          console.log(`[Hybrid] ⚠ Pair cost $${simPairCost.toFixed(3)} >= $1.00 — SKIP`);
          console.log(`[Hybrid] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Pair cost would be $${simPairCost.toFixed(3)}` };
        }
        const currentPairCost = this._calcPairCost(window);
        if (!isLateHedge && currentPairCost && simPairCost > currentPairCost) {
          console.log(`[Hybrid] ⚠ Would raise pair cost — SKIP`);
          console.log(`[Hybrid] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Would raise pair cost` };
        }
      }
    }

    if (window.buys.length === 0) {
      window.startPairCost = combinedPrice;
    }

    const rr = ((1 - buyPrice) / buyPrice).toFixed(1);
    console.log(`[Hybrid] 🔄 DIPARB ${buyOutcome} @ $${buyPrice.toFixed(3)} | ${buyReason} | R:R ${rr}:1`);
    console.log(`[Hybrid] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction: buyOutcome === "Up" ? "LONG" : "SHORT",
      targetOutcome: buyOutcome,
      confidence: 70,
      edge: 1.0 - combinedPrice,
      marketPrice: buyPrice,
      modelProb: 0.7,
      strategy: `DIPARB_${buyReason.split(' ')[0]}`,
      isConviction: false,
      isLateHedge,
      applyLongDiscount: false,
      convictionDollars: null,
      bullScore: conviction.bullVotes,
      bearScore: conviction.bearVotes,
      signals: [`diparb:${buyOutcome}@$${buyPrice.toFixed(3)}`, buyReason],
      reason: `🔄 DIPARB ${buyOutcome} @ $${buyPrice.toFixed(3)} | ${buyReason} | R:R ${rr}:1`
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
      
      // Sizing: CONVICTION gets bigger bet, DIPARB gets smaller
      let dollars;
      if (signal.isConviction) {
        dollars = signal.convictionDollars || this.CONVICTION_SIZE;
        console.log(`[Hybrid] 🎯 CONVICTION sizing: $${dollars}`);
      } else {
        dollars = signal.isLateHedge ? this.LATE_HEDGE_SIZE : this.DIPARB_SIZE;
      }
      
      let size = Math.floor(dollars / price);
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
        console.log("[Hybrid] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[Hybrid] ✅ Order: ${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

      // Update window state
      const window = this.currentWindow;
      if (window) {
        if (signal.targetOutcome === "Up") {
          window.qtyUp += size;
          window.costUp += maxCost;
        } else {
          window.qtyDown += size;
          window.costDown += maxCost;
        }
        window.buys.push({
          outcome: signal.targetOutcome,
          price, size, cost: maxCost,
          orderId: order.orderID,
          timestamp: Date.now()
        });

        // Log window state after buy
        const pairCost = this._calcPairCost(window);
        const totalSpent = window.costUp + window.costDown;
        const pairs = Math.min(window.qtyUp, window.qtyDown);
        console.log(`[Hybrid] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) | ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) | Pairs: ${pairs} | PairCost: ${pairCost ? '$' + pairCost.toFixed(3) : 'N/A'} | Spent: $${totalSpent.toFixed(2)}`);
        
        // Check if profit is now locked
        if (pairs > 0 && pairs * 1.0 > totalSpent) {
          window.locked = true;
          console.log(`[Hybrid] 🔒 PROFIT LOCKED after this buy! +$${(pairs - totalSpent).toFixed(2)} guaranteed`);
        }
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

      // Track trade type
      if (signal.isConviction) {
        this.convictionTrades++;
      } else {
        this.diparbTrades++;
      }

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
        bullScore: signal.bullScore || 0, bearScore: signal.bearScore || 0,
        signals: signal.signals || [],
        strategy: signal.strategy || "HYBRID"
      });

      return {
        success: true, trade, order,
        reason: `${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(2)} ($${maxCost.toFixed(2)})`
      };

    } catch (error) {
      return { success: false, reason: `Trade failed: ${error.message}`, error };
    }
  }

  // Called when a position resolves — track streaks, daily P&L, loss streaks
  recordResolution(outcome, won, pnl = 0) {
    // Track daily P&L for drawdown stop
    this.dailyPnl += pnl;
    
    // Track consecutive losses for revenge-bet prevention
    if (won) {
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
    }
    
    // Track directional streaks
    if (outcome === "Down" && won) {
      this.consecutiveDownWins++;
      this.consecutiveUpWins = 0;
    } else if (outcome === "Up" && won) {
      this.consecutiveUpWins++;
      this.consecutiveDownWins = 0;
    }
    
    console.log(`[Hybrid] 📊 Resolution: ${outcome} ${won ? 'WIN' : 'LOSS'} $${pnl.toFixed(2)} | Daily: $${this.dailyPnl.toFixed(2)} | Streak: ${this.consecutiveLosses}L`);
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
      pairWindow: w ? {
        slug: w.slug?.slice(-20),
        qtyUp: w.qtyUp,
        costUp: w.costUp,
        qtyDown: w.qtyDown,
        costDown: w.costDown,
        totalSpent: w.costUp + w.costDown,
        pairCost: this._calcPairCost(w),
        pairs: Math.min(w.qtyUp, w.qtyDown),
        locked: w.locked,
        buys: w.buys.length,
        startPairCost: w.startPairCost
      } : null,
      windowsCompleted: this.windowHistory.length,
      consecutiveDownWins: this.consecutiveDownWins,
      convictionTrades: this.convictionTrades,
      diparbTrades: this.diparbTrades,
      dailyPnl: this.dailyPnl,
      consecutiveLosses: this.consecutiveLosses
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
