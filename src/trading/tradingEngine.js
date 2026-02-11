import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// ARB HUNTER v6 — Exploit the math, not prediction
//
// 3 strategies checked every second, in priority order:
//
// ① PURE ARB (guaranteed profit):
//    Up + Down < $0.975 → buy BOTH sides → one settles at $1
//    Profit = $1.00 - (Up + Down) per share, minus fees
//    Fee at 35¢ ≈ 0.91%, at 50¢ ≈ 1.56% → need sum < ~$0.97
//    This is what the $558K bot does. 380 trades/day.
//
// ② EXTREME VALUE (asymmetric R:R):
//    Token < 10¢ + BTC confirmed move in that direction
//    Risk $0.10, win $0.90 → 9:1 R:R. Only need 15% win rate.
//    Fee at 10¢ ≈ 0.56% → negligible.
//    These are rare but massively +EV when they hit.
//
// ③ CONFIRMED MOVE (latency edge):
//    BTC moved >0.25% from candle open + winning token < 35¢
//    Fee at 35¢ ≈ 0.91% → small vs 65¢ upside
//    Tighter criteria than v5 to account for fees.
//
// Key improvements over v5:
//   - Accounts for Polymarket taker fees in all calculations
//   - Pure arb = guaranteed profit (no prediction needed)
//   - Extreme value = massive R:R even with low win rate
//   - Tighter confirmed move criteria (0.25% not 0.20%)
//   - Max 2 trades per market (arb + directional)
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
    
    // ═══ STRATEGY 1: PURE ARB ══════════════════════════
    this.ARB_MAX_SUM = 0.975;        // Up+Down must be < 97.5¢ (2.5¢ gross profit/share)
    this.ARB_SIZE = 5;               // $5 per arb (split across both sides)
    this.ARB_MIN_PROFIT = 0.005;     // Min $0.005 profit per share after fees
    
    // ═══ STRATEGY 2: EXTREME VALUE ═════════════════════
    this.EXTREME_MAX_PRICE = 0.10;   // Token must be < 10¢
    this.EXTREME_MIN_BTC_MOVE = 0.15;// BTC must confirm direction (>0.15%)
    this.EXTREME_SIZE = 3;           // $3 per extreme value bet
    
    // ═══ STRATEGY 3: CONFIRMED MOVE ════════════════════
    this.MOVE_MIN_BTC_PCT = 0.25;    // BTC must move >0.25% (tighter than v5)
    this.MOVE_STRONG_PCT = 0.40;     // Strong move threshold
    this.MOVE_MAX_TOKEN = 0.35;      // Token must be < 35¢ (tighter — more lag required)
    this.MOVE_MIN_TOKEN = 0.05;      // Ignore dust
    this.MOVE_SIZE = 4;              // $4 per confirmed move
    this.MOVE_SIZE_STRONG = 6;       // $6 on strong moves
    this.MOVE_MIN_EDGE = 0.20;       // Need 20% edge (higher than v5's 15% to cover fees)
    
    // ═══ TIMING ════════════════════════════════════════
    this.MIN_BUY_COOLDOWN = 15000;   // 15s cooldown (faster for arb)
    this.MIN_CANDLE_MINUTE = 1;      // Arb can trade from minute 1
    this.MAX_CANDLE_MINUTE = 13;     // Can trade until minute 13
    
    // ═══ GUARDRAILS ═════════════════════════════════════
    this.DAILY_DRAWDOWN_LIMIT = -10; // Stop at -$10 daily
    this.MAX_EXPOSURE = 20;          // $20 max (higher — arb is hedged)
    this.LOSS_STREAK_REDUCE = 4;     // After 4 consecutive losses, reduce size
    
    // ═══ FEE CALCULATION ═══════════════════════════════
    this.FEE_RATE = 0.0625;          // Polymarket fee multiplier for 15-min markets
    
    // ═══ TRACKING ══════════════════════════════════════
    this.lastBuyTime = 0;
    this.tradedSlugs = new Map();    // slug → { arb: bool, directional: bool }
    this.consecutiveLosses = 0;
    this.dailyPnl = 0;
    this.dailyResetDate = new Date().toDateString();
    this.todayTrades = 0;
    this.todayWins = 0;
    this.todayArbs = 0;
    this.todayExtremes = 0;
    this.todayMoves = 0;
    
    // ═══ LOGGING & ANALYTICS ═══════════════════════════
    this.opportunitiesSeen = 0;      // Total opportunities scanned
    this.arbSkipped = 0;             // Arb found but fees ate profit
    this.extremeSkipped = 0;         // Extreme value but move too small
    this.moveSkipped = 0;            // Move found but edge/EV too low
    this.lastLogTime = Date.now();
  }

  _tradesInLastHour() {
    const oneHourAgo = Date.now() - 3600000;
    this.hourlyTrades = this.hourlyTrades.filter(t => t > oneHourAgo);
    return this.hourlyTrades.length;
  }

  // Calculate taker fee per share at a given price
  _takerFee(price) {
    return price * (1 - price) * this.FEE_RATE;
  }

  // ─── DAILY RESET ──────────────────────────────────────────────
  _checkDailyReset() {
    const today = new Date().toDateString();
    if (today !== this.dailyResetDate) {
      console.log(`[ArbHunter] 📅 New day — prev: $${this.dailyPnl.toFixed(2)} | ${this.todayTrades}T ${this.todayWins}W | Arb:${this.todayArbs} Ext:${this.todayExtremes} Mov:${this.todayMoves}`);
      this.dailyPnl = 0;
      this.dailyResetDate = today;
      this.todayTrades = 0;
      this.todayWins = 0;
      this.todayArbs = 0;
      this.todayExtremes = 0;
      this.todayMoves = 0;
      this.consecutiveLosses = 0;
      this.tradedSlugs.clear();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // Checks 3 strategies in priority order
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
    const spotPrice = marketData.spotPrice;
    const priceToBeat = marketData.priceToBeat;

    if (!upPrice || !downPrice || upPrice <= 0 || downPrice <= 0) {
      return { shouldTrade: false, reason: "Invalid prices" };
    }

    const sum = upPrice + downPrice;

    // ═══ GUARDRAILS ═══════════════════════════════════════════
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= this.MAX_EXPOSURE) {
      return { shouldTrade: false, reason: `Circuit breaker: $${totalExposure.toFixed(2)}` };
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

    // Track what we've already done on this market
    const slugState = this.tradedSlugs.get(slug) || { arb: false, directional: false };

    // BTC move calculation (for strategies 2 & 3)
    let btcMovePct = 0;
    let btcMoveAbs = 0;
    if (spotPrice && priceToBeat) {
      btcMovePct = ((spotPrice - priceToBeat) / priceToBeat) * 100;
      btcMoveAbs = Math.abs(btcMovePct);
    }

    const feeUp = this._takerFee(upPrice);
    const feeDown = this._takerFee(downPrice);

    this.opportunitiesSeen++;

    // ═══════════════════════════════════════════════════════════
    // STRATEGY 1: PURE ARB — Up + Down < threshold
    // Buy BOTH sides. One always settles at $1. Guaranteed profit.
    // ═══════════════════════════════════════════════════════════
    if (!slugState.arb && sum < this.ARB_MAX_SUM) {
      const grossProfit = 1.0 - sum;  // per share pair
      const totalFee = feeUp + feeDown;
      const netProfit = grossProfit - totalFee;

      if (netProfit >= this.ARB_MIN_PROFIT) {
        console.log(`[ArbHunter] ══════════════════════════════════════`);
        console.log(`[ArbHunter] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Sum: $${sum.toFixed(3)} | Min ${candleMinute}/15`);
        // Buy the cheaper side (more shares per dollar = more profit)
        const cheaperSide = upPrice <= downPrice ? "Up" : "Down";
        const cheaperPrice = Math.min(upPrice, downPrice);
        const dollars = this.ARB_SIZE;

        console.log(`[ArbHunter] 💰 PURE ARB! Sum $${sum.toFixed(3)} | Gross: ${(grossProfit*100).toFixed(1)}¢ | Fee: ${(totalFee*100).toFixed(1)}¢ | Net: ${(netProfit*100).toFixed(1)}¢/share`);
        console.log(`[ArbHunter] 💰 Buy ${cheaperSide} @ $${cheaperPrice.toFixed(3)} (cheaper side first) | $${dollars}`);
        console.log(`[ArbHunter] ══════════════════════════════════════`);

        return {
          shouldTrade: true,
          direction: cheaperSide === "Up" ? "LONG" : "SHORT",
          targetOutcome: cheaperSide,
          confidence: 95,
          edge: netProfit,
          marketPrice: cheaperPrice,
          modelProb: 0.95,
          strategy: "PURE_ARB",
          arbDollars: dollars,
          arbNetProfit: netProfit,
          arbSum: sum,
          bullScore: 0, bearScore: 0,
          signals: [`sum:$${sum.toFixed(3)}`, `net:${(netProfit*100).toFixed(1)}¢`, `fee:${(totalFee*100).toFixed(1)}¢`],
          reason: `💰 ARB: Sum $${sum.toFixed(3)} | Net +${(netProfit*100).toFixed(1)}¢/share | ${cheaperSide} @ $${cheaperPrice.toFixed(3)}`
        };
      } else {
        this.arbSkipped++;
        // Only log arb skips occasionally to avoid spam
        if (this.arbSkipped % 50 === 0) {
          console.log(`[ArbHunter] ⏳ Arb skip #${this.arbSkipped}: Sum $${sum.toFixed(3)} | Net ${(netProfit*100).toFixed(1)}¢ (fees ate ${(totalFee*100).toFixed(1)}¢)`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY 2: EXTREME VALUE — Token < 10¢ + confirmed direction
    // Risk 10¢, win 90¢. 9:1 R:R. Only need 15% win rate to profit.
    // ═══════════════════════════════════════════════════════════
    if (!slugState.directional && spotPrice && priceToBeat) {
      const btcUp = btcMovePct > 0;
      const extremeToken = btcUp ? "Up" : "Down";
      const extremePrice = btcUp ? upPrice : downPrice;

      if (extremePrice <= this.EXTREME_MAX_PRICE && extremePrice > 0.01 && btcMoveAbs >= this.EXTREME_MIN_BTC_MOVE) {
        const fee = this._takerFee(extremePrice);
        const netWin = 1.0 - extremePrice - fee;
        const netLoss = extremePrice + fee;
        const rr = (netWin / netLoss).toFixed(1);
        const breakeven = (netLoss / (netWin + netLoss) * 100).toFixed(0);
        const dollars = this.EXTREME_SIZE;

        console.log(`[ArbHunter] ══════════════════════════════════════`);
        console.log(`[ArbHunter] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Sum: $${sum.toFixed(3)} | Min ${candleMinute}/15`);
        console.log(`[ArbHunter] 🎰 EXTREME VALUE! ${extremeToken} @ $${extremePrice.toFixed(3)} | BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}%`);
        console.log(`[ArbHunter] 🎰 R:R ${rr}:1 | Win: +${(netWin*100).toFixed(0)}¢ | Lose: -${(netLoss*100).toFixed(0)}¢ | Breakeven: ${breakeven}% WR | $${dollars}`);
        console.log(`[ArbHunter] ══════════════════════════════════════`);

        return {
          shouldTrade: true,
          direction: btcUp ? "LONG" : "SHORT",
          targetOutcome: extremeToken,
          confidence: 60,
          edge: netWin - netLoss,
          marketPrice: extremePrice,
          modelProb: 0.60,
          strategy: "EXTREME_VALUE",
          extremeDollars: dollars,
          bullScore: 0, bearScore: 0,
          signals: [`${extremeToken}:$${extremePrice.toFixed(3)}`, `RR:${rr}:1`, `BTC:${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(2)}%`],
          reason: `🎰 EXTREME ${extremeToken} @ $${extremePrice.toFixed(3)} | R:R ${rr}:1 | BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(2)}%`
        };
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STRATEGY 3: CONFIRMED MOVE — BTC moved >0.25% + cheap token
    // Same as sniper but tighter criteria to account for fees
    // ═══════════════════════════════════════════════════════════
    if (!slugState.directional && spotPrice && priceToBeat && candleMinute >= 2) {
      const btcUp = btcMovePct > 0;
      const targetOutcome = btcUp ? "Up" : "Down";
      const targetPrice = btcUp ? upPrice : downPrice;

      if (btcMoveAbs >= this.MOVE_MIN_BTC_PCT && targetPrice <= this.MOVE_MAX_TOKEN && targetPrice >= this.MOVE_MIN_TOKEN) {
        const fee = this._takerFee(targetPrice);
        const estimatedProb = btcMoveAbs >= this.MOVE_STRONG_PCT ? 0.85 : 0.72;
        const impliedProb = targetPrice;
        const probEdge = estimatedProb - impliedProb;

        // Expected value accounting for fees
        const evWin = (1.0 - targetPrice - fee) * estimatedProb;
        const evLoss = (targetPrice + fee) * (1 - estimatedProb);
        const netEV = evWin - evLoss;

        if (probEdge >= this.MOVE_MIN_EDGE && netEV > 0) {
          const isStrong = btcMoveAbs >= this.MOVE_STRONG_PCT;
          let dollars = isStrong ? this.MOVE_SIZE_STRONG : this.MOVE_SIZE;

          if (this.consecutiveLosses >= this.LOSS_STREAK_REDUCE) {
            dollars = Math.max(2, Math.floor(dollars * 0.5));
          }

          const rr = ((1 - targetPrice - fee) / (targetPrice + fee)).toFixed(1);

          console.log(`[ArbHunter] ══════════════════════════════════════`);
          console.log(`[ArbHunter] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Sum: $${sum.toFixed(3)} | Min ${candleMinute}/15`);
          console.log(`[ArbHunter] 🎯 CONFIRMED MOVE! ${targetOutcome} @ $${targetPrice.toFixed(3)} | BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}%`);
          console.log(`[ArbHunter] 🎯 Edge: ${(probEdge*100).toFixed(0)}% | EV: +${(netEV*100).toFixed(1)}¢/share | R:R ${rr}:1 | Fee: ${(fee*100).toFixed(1)}¢ | $${dollars}${isStrong ? ' STRONG' : ''}`);
          console.log(`[ArbHunter] ══════════════════════════════════════`);

          return {
            shouldTrade: true,
            direction: btcUp ? "LONG" : "SHORT",
            targetOutcome,
            confidence: Math.round(estimatedProb * 100),
            edge: probEdge,
            marketPrice: targetPrice,
            modelProb: estimatedProb,
            strategy: isStrong ? "MOVE_STRONG" : "MOVE",
            moveDollars: dollars,
            bullScore: 0, bearScore: 0,
            signals: [`BTC:${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}%`, `${targetOutcome}:$${targetPrice.toFixed(3)}`, `EV:+${(netEV*100).toFixed(1)}¢`],
            reason: `🎯 MOVE ${targetOutcome} @ $${targetPrice.toFixed(3)} | BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(2)}% | EV +${(netEV*100).toFixed(1)}¢ | $${dollars}`
          };
        } else if (btcMoveAbs >= this.MOVE_MIN_BTC_PCT) {
          this.moveSkipped++;
          // Only log move skips occasionally to avoid spam
          if (this.moveSkipped % 30 === 0) {
            console.log(`[ArbHunter] ⏳ Move skip #${this.moveSkipped}: BTC ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}% | Edge ${(probEdge*100).toFixed(0)}% | EV ${(netEV*100).toFixed(1)}¢`);
          }
        }
      }
    }

    // Periodic summary every 10 trades
    if (this.todayTrades > 0 && this.todayTrades % 10 === 0 && (Date.now() - this.lastLogTime) > 5000) {
      const wr = this.todayTrades > 0 ? ((this.todayWins / this.todayTrades) * 100).toFixed(0) : "N/A";
      const avgPerTrade = this.todayTrades > 0 ? (this.dailyPnl / this.todayTrades).toFixed(2) : "0.00";
      console.log(`\n[ArbHunter] ════════════════════════════════════════════════════════`);
      console.log(`[ArbHunter] 📊 SUMMARY after ${this.todayTrades} trades | Daily P&L: $${this.dailyPnl.toFixed(2)} | Avg: $${avgPerTrade}/trade | WR: ${wr}%`);
      console.log(`[ArbHunter] 💰 Arb: ${this.todayArbs} trades | 🎰 Extreme: ${this.todayExtremes} trades | 🎯 Move: ${this.todayMoves} trades`);
      console.log(`[ArbHunter] ⏳ Skipped: Arb ${this.arbSkipped} | Extreme ${this.extremeSkipped} | Move ${this.moveSkipped} | Scanned: ${this.opportunitiesSeen}`);
      console.log(`[ArbHunter] 📈 Opportunities/trade: ${(this.opportunitiesSeen / Math.max(1, this.todayTrades)).toFixed(1)} | Loss streak: ${this.consecutiveLosses}`);
      console.log(`[ArbHunter] ════════════════════════════════════════════════════════\n`);
      this.lastLogTime = Date.now();
    }

    return { shouldTrade: false, reason: `No opportunity (sum $${sum.toFixed(3)}, BTC ${btcMoveAbs.toFixed(2)}%)` };
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
      
      // Sizing based on strategy
      let dollars;
      if (signal.strategy === "PURE_ARB") {
        dollars = signal.arbDollars || this.ARB_SIZE;
      } else if (signal.strategy === "EXTREME_VALUE") {
        dollars = signal.extremeDollars || this.EXTREME_SIZE;
      } else {
        dollars = signal.moveDollars || this.MOVE_SIZE;
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
        console.log("[ArbHunter] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[ArbHunter] ✅ ${signal.strategy}: ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

      // Mark this market as traded
      const slug = marketData.marketSlug || "";
      if (slug) {
        const state = this.tradedSlugs.get(slug) || { arb: false, directional: false };
        if (signal.strategy === "PURE_ARB") {
          state.arb = true;
        } else {
          state.directional = true;
        }
        this.tradedSlugs.set(slug, state);
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

      // Track by strategy type
      this.todayTrades++;
      if (signal.strategy === "PURE_ARB") this.todayArbs++;
      else if (signal.strategy === "EXTREME_VALUE") this.todayExtremes++;
      else this.todayMoves++;

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
        strategy: signal.strategy || "ARB_HUNTER"
      });

      return {
        success: true, trade, order,
        reason: `${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} ($${maxCost.toFixed(2)})`
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
    
    const wr = this.todayTrades > 0 ? ((this.todayWins / this.todayTrades) * 100).toFixed(0) : "N/A";
    console.log(`[ArbHunter] 📊 ${won ? '✅ WIN' : '❌ LOSS'} ${outcome} $${pnl.toFixed(2)} | Daily: $${this.dailyPnl.toFixed(2)} | ${this.todayWins}/${this.todayTrades} (${wr}%) | ${this.consecutiveLosses}L streak`);
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
      todayTrades: this.todayTrades,
      todayWins: this.todayWins,
      todayArbs: this.todayArbs,
      todayExtremes: this.todayExtremes,
      todayMoves: this.todayMoves,
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
