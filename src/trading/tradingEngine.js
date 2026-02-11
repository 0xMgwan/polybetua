import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// LATENCY SNIPER v5 — React to confirmed BTC moves
//
// Core insight: Don't PREDICT direction. REACT to confirmed moves.
// Binance spot updates instantly. Polymarket odds lag by seconds.
// When BTC moves >0.2%, buy the winning side while it's still cheap.
//
// How the $313→$414K bot works (98% win rate):
//   1. Watch Binance real-time price vs candle open (priceToBeat)
//   2. When BTC confirms a move (>0.2% from open), the outcome is ~85% certain
//   3. But Polymarket odds still show ~50/50 (lagging)
//   4. Buy the winning side at cheap price → collect $1 at settlement
//
// Our edge: SPEED, not prediction.
//   - Binance WS gives us tick-by-tick BTC price
//   - We compare to priceToBeat (candle open price)
//   - If BTC is UP 0.2%+ and Up token is still < 45¢ → BUY UP
//   - If BTC is DOWN 0.2%+ and Down token is still < 45¢ → BUY DOWN
//
// Guardrails:
//   - Only 1 trade per market (no double-dipping)
//   - Daily drawdown stop: -$10
//   - Max $15 total exposure
//   - 30s cooldown between trades
//   - Token must be < 45¢ (confirms market hasn't caught up yet)
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
    
    // ═══ SNIPER PARAMETERS ═════════════════════════════
    this.MIN_BTC_MOVE_PCT = 0.20;    // BTC must move >0.2% from candle open
    this.STRONG_MOVE_PCT = 0.35;     // Strong move: >0.35% → bigger bet
    this.MAX_TOKEN_PRICE = 0.45;     // Token must be < 45¢ (market hasn't caught up)
    this.MIN_TOKEN_PRICE = 0.03;     // Ignore dust prices
    this.BET_SIZE = 4;               // $4 per snipe (5% of ~$80)
    this.BET_SIZE_STRONG = 6;        // $6 on strong moves (>0.35%)
    this.ONE_TRADE_PER_MARKET = true;// Only 1 snipe per 15-min market
    
    // ═══ TIMING ════════════════════════════════════════
    this.MIN_BUY_COOLDOWN = 30000;   // 30s between any buys
    this.MIN_CANDLE_MINUTE = 2;      // Don't trade first 2 min (let move develop)
    this.MAX_CANDLE_MINUTE = 12;     // Don't trade last 3 min (too late)
    
    // ═══ GUARDRAILS ═════════════════════════════════════
    this.DAILY_DRAWDOWN_LIMIT = -10; // Stop trading if daily P&L < -$10
    this.MAX_EXPOSURE = 15;          // Circuit breaker
    this.LOSS_STREAK_REDUCE = 3;     // After 3 consecutive losses, reduce size
    
    // ═══ TRACKING ══════════════════════════════════════
    this.lastBuyTime = 0;
    this.tradedSlugs = new Set();    // Track which markets we've already sniped
    this.consecutiveLosses = 0;
    this.dailyPnl = 0;
    this.dailyResetDate = new Date().toDateString();
    this.todaySnipes = 0;
    this.todayWins = 0;
  }

  _tradesInLastHour() {
    const oneHourAgo = Date.now() - 3600000;
    this.hourlyTrades = this.hourlyTrades.filter(t => t > oneHourAgo);
    return this.hourlyTrades.length;
  }

  // ─── DAILY RESET ──────────────────────────────────────────────
  _checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      console.log(`[Sniper] 📅 New day — resetting (prev P&L: $${this.dailyPnl.toFixed(2)} | ${this.todaySnipes} snipes, ${this.todayWins} wins)`);
      this.dailyPnl = 0;
      this.dailyResetDate = today;
      this.todaySnipes = 0;
      this.todayWins = 0;
      this.consecutiveLosses = 0;
      this.tradedSlugs.clear();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // LATENCY SNIPER v5: React to confirmed BTC moves
  // ═══════════════════════════════════════════════════════════════
  shouldTrade(prediction, marketData, currentPrice, indicators = {}) {
    if (!this.config.enabled) {
      return { shouldTrade: false, reason: "Trading disabled" };
    }
    if (!prediction || !marketData) {
      return { shouldTrade: false, reason: "Missing data" };
    }

    this._checkDailyReset();

    const now = Date.now();
    const upPrice = marketData.upPrice;
    const downPrice = marketData.downPrice;
    const slug = marketData.marketSlug || "";
    const spotPrice = marketData.spotPrice;  // Binance real-time BTC
    const priceToBeat = marketData.priceToBeat; // BTC at candle open

    if (!upPrice || !downPrice || upPrice <= 0 || downPrice <= 0) {
      return { shouldTrade: false, reason: "Invalid prices" };
    }

    // ═══ GUARDRAILS ═══════════════════════════════════════════
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= this.MAX_EXPOSURE) {
      return { shouldTrade: false, reason: `Circuit breaker: $${totalExposure.toFixed(2)} >= $${this.MAX_EXPOSURE}` };
    }

    if (this.dailyPnl <= this.DAILY_DRAWDOWN_LIMIT) {
      return { shouldTrade: false, reason: `Daily stop: $${this.dailyPnl.toFixed(2)}` };
    }

    // ─── TIMING ──────────────────────────────────────────────
    let candleMinute = 0;
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      const minLeft = msLeft / 60000;
      candleMinute = Math.floor(15 - minLeft);
      
      if (candleMinute < this.MIN_CANDLE_MINUTE) {
        return { shouldTrade: false, reason: `Too early (min ${candleMinute})` };
      }
      if (candleMinute > this.MAX_CANDLE_MINUTE) {
        return { shouldTrade: false, reason: `Too late (min ${candleMinute})` };
      }
    }

    // Cooldown
    if ((now - this.lastBuyTime) < this.MIN_BUY_COOLDOWN) {
      return { shouldTrade: false, reason: "Cooldown" };
    }

    // One trade per market
    if (this.ONE_TRADE_PER_MARKET && this.tradedSlugs.has(slug)) {
      return { shouldTrade: false, reason: "Already sniped this market" };
    }

    // ═══ CORE SNIPER LOGIC ═══════════════════════════════════
    // Need both Binance spot price AND candle open price
    if (!spotPrice || !priceToBeat) {
      return { shouldTrade: false, reason: "No spot/priceToBeat data" };
    }

    // Calculate how much BTC has moved since candle opened
    const btcMovePct = ((spotPrice - priceToBeat) / priceToBeat) * 100;
    const btcMoveAbs = Math.abs(btcMovePct);
    const btcUp = btcMovePct > 0;
    const btcDown = btcMovePct < 0;

    // Which token should we buy?
    const targetOutcome = btcUp ? "Up" : "Down";
    const targetPrice = btcUp ? upPrice : downPrice;
    const oppositePrice = btcUp ? downPrice : upPrice;

    console.log(`[Sniper] ══════════════════════════════════════`);
    console.log(`[Sniper] BTC: $${spotPrice.toFixed(2)} | Open: $${priceToBeat.toFixed(2)} | Move: ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}%`);
    console.log(`[Sniper] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Min ${candleMinute}/15`);
    console.log(`[Sniper] Target: ${targetOutcome} @ $${targetPrice.toFixed(3)} | Daily: $${this.dailyPnl.toFixed(2)} | Snipes: ${this.todaySnipes}`);

    // ─── CHECK 1: BTC move big enough? ──────────────────────
    if (btcMoveAbs < this.MIN_BTC_MOVE_PCT) {
      console.log(`[Sniper] ⏳ Move too small: ${btcMoveAbs.toFixed(3)}% < ${this.MIN_BTC_MOVE_PCT}%`);
      console.log(`[Sniper] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Move too small (${btcMoveAbs.toFixed(3)}% < ${this.MIN_BTC_MOVE_PCT}%)` };
    }

    // ─── CHECK 2: Token still cheap? (market hasn't caught up) ─
    if (targetPrice > this.MAX_TOKEN_PRICE) {
      console.log(`[Sniper] ⏳ Market already caught up: ${targetOutcome} $${targetPrice.toFixed(3)} > $${this.MAX_TOKEN_PRICE}`);
      console.log(`[Sniper] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Market caught up (${targetOutcome} $${targetPrice.toFixed(3)})` };
    }

    if (targetPrice < this.MIN_TOKEN_PRICE) {
      console.log(`[Sniper] ⏳ Token too cheap (dust): $${targetPrice.toFixed(3)}`);
      console.log(`[Sniper] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Dust price $${targetPrice.toFixed(3)}` };
    }

    // ─── CHECK 3: Confirm the lag exists ────────────────────
    // If BTC is up 0.3% but Up token is 60¢, the market already priced it in.
    // We want: BTC moved significantly BUT token is still cheap.
    // "Implied probability" from token price vs actual probability from BTC move
    const impliedProb = targetPrice; // token price ≈ market's implied probability
    // A 0.2% BTC move in 15min historically resolves in that direction ~70-80% of time
    // A 0.35%+ move resolves ~85%+ of the time
    const estimatedProb = btcMoveAbs >= this.STRONG_MOVE_PCT ? 0.85 : 0.70;
    const probEdge = estimatedProb - impliedProb;

    if (probEdge < 0.15) {
      console.log(`[Sniper] ⏳ Edge too thin: est ${(estimatedProb*100).toFixed(0)}% vs market ${(impliedProb*100).toFixed(0)}% = ${(probEdge*100).toFixed(0)}% edge`);
      console.log(`[Sniper] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Edge too thin (${(probEdge*100).toFixed(0)}%)` };
    }

    // ─── ALL CHECKS PASSED — SNIPE! ─────────────────────────
    const isStrong = btcMoveAbs >= this.STRONG_MOVE_PCT;
    let dollars = isStrong ? this.BET_SIZE_STRONG : this.BET_SIZE;

    // Reduce after loss streak
    if (this.consecutiveLosses >= this.LOSS_STREAK_REDUCE) {
      dollars = Math.max(2, Math.floor(dollars * 0.5));
      console.log(`[Sniper] ⚠ Loss streak ${this.consecutiveLosses} — reduced to $${dollars}`);
    }

    const rr = ((1 - targetPrice) / targetPrice).toFixed(1);
    const direction = btcUp ? "LONG" : "SHORT";

    console.log(`[Sniper] 🎯 SNIPE! ${targetOutcome} @ $${targetPrice.toFixed(3)} | BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}% | Edge: ${(probEdge*100).toFixed(0)}% | R:R ${rr}:1 | $${dollars}${isStrong ? ' (STRONG)' : ''}`);
    console.log(`[Sniper] ══════════════════════════════════════`);

    return {
      shouldTrade: true,
      direction,
      targetOutcome,
      confidence: Math.round(estimatedProb * 100),
      edge: probEdge,
      marketPrice: targetPrice,
      modelProb: estimatedProb,
      strategy: isStrong ? "SNIPER_STRONG" : "SNIPER",
      isConviction: false,
      isLateHedge: false,
      applyLongDiscount: false,
      sniperDollars: dollars,
      bullScore: 0,
      bearScore: 0,
      signals: [`BTC:${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}%`, `${targetOutcome}:$${targetPrice.toFixed(3)}`, `edge:${(probEdge*100).toFixed(0)}%`],
      reason: `🎯 SNIPE ${targetOutcome} @ $${targetPrice.toFixed(3)} | BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}% | Edge ${(probEdge*100).toFixed(0)}% | $${dollars}`
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
      
      // Sniper sizing
      let dollars = signal.sniperDollars || this.BET_SIZE;
      
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
        console.log("[Sniper] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[Sniper] ✅ SNIPED: ${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

      // Mark this market as traded
      const slug = marketData.marketSlug || "";
      if (slug) this.tradedSlugs.add(slug);

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

      // Track snipe count
      this.todaySnipes++;

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
        strategy: signal.strategy || "SNIPER"
      });

      return {
        success: true, trade, order,
        reason: `${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(2)} ($${maxCost.toFixed(2)})`
      };

    } catch (error) {
      return { success: false, reason: `Trade failed: ${error.message}`, error };
    }
  }

  // Called when a position resolves
  recordResolution(outcome, won, pnl = 0) {
    this.dailyPnl += pnl;
    
    if (won) {
      this.consecutiveLosses = 0;
      this.todayWins++;
    } else {
      this.consecutiveLosses++;
    }
    
    const wr = this.todaySnipes > 0 ? ((this.todayWins / this.todaySnipes) * 100).toFixed(0) : "N/A";
    console.log(`[Sniper] 📊 ${won ? '✅ WIN' : '❌ LOSS'} ${outcome} $${pnl.toFixed(2)} | Daily: $${this.dailyPnl.toFixed(2)} | ${this.todayWins}/${this.todaySnipes} (${wr}%) | Streak: ${this.consecutiveLosses}L`);
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
      lastTradeTime: this.lastTradeTime,
      activeOrders: this.tradingService.getActiveOrdersCount(),
      pnl: pnlStats,
      tradesThisHour: this._tradesInLastHour(),
      todaySnipes: this.todaySnipes,
      todayWins: this.todayWins,
      dailyPnl: this.dailyPnl,
      consecutiveLosses: this.consecutiveLosses,
      tradedSlugs: this.tradedSlugs.size
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
