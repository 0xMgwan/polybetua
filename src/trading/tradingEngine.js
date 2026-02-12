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
    this.ARB_MAX_SUM = 0.97;         // Up+Down must be < 97¢ (3¢ gross profit/share — more opportunities)
    this.ARB_SIZE = 40;              // $40 per arb pair ($20 each side) — profit scales with size
    this.ARB_MIN_PROFIT = 0.015;     // Min 1.5¢ profit per share AFTER fees (was 0.5¢ — too thin)
    
    // ═══ STRATEGY 2: EXTREME VALUE ═════════════════════
    this.EXTREME_MAX_PRICE = 0.20;   // Token must be < 20¢ (was 10¢ — too strict, never fires)
    this.EXTREME_MIN_BTC_MOVE = 0.06;// BTC must confirm direction (>0.06% — was 0.12%, too strict)
    this.DEEP_VALUE_MAX = 0.05;      // Tokens under 5¢ don't need BTC confirmation (20:1+ R:R)
    this.EXTREME_SIZE = 2;           // $2 per extreme value bet (small — focus is arb)
    
    // ═══ STRATEGY 3: CONFIRMED MOVE ════════════════════
    this.MOVE_MIN_BTC_PCT = 0.08;    // BTC must move >0.08% (was 0.15% — too strict, never fired)
    this.MOVE_STRONG_PCT = 0.30;     // Strong move threshold (was 0.40%)
    this.MOVE_MAX_TOKEN = 0.45;      // Token must be < 45¢ (was 35¢ — too strict)
    this.MOVE_MIN_TOKEN = 0.03;      // Ignore dust
    this.MOVE_SIZE = 2;              // $2 per confirmed move (small — focus is arb)
    this.MOVE_SIZE_STRONG = 2;       // $2 even on strong moves (protect arb capital)
    this.MOVE_MIN_EDGE = 0.15;       // Need 15% edge (was 20% — too strict with fees accounted)
    
    // ═══ TIMING ════════════════════════════════════════
    this.MIN_BUY_COOLDOWN = 15000;   // 15s cooldown (faster for arb)
    this.MIN_CANDLE_MINUTE = 1;      // Arb can trade from minute 1
    this.MAX_CANDLE_MINUTE = 13;     // Can trade until minute 13
    
    // ═══ GUARDRAILS ═════════════════════════════════════
    this.DAILY_DRAWDOWN_LIMIT = -10; // Stop at -$10 daily
    this.MAX_EXPOSURE = 80;          // $80 max — arb is hedged so safe to go higher ($100 balance)
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
    this.lastScanLog = 0;            // Last time we logged a scan
    this.lastScan = {};              // Last scan data for /debug endpoint
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

    // Store last scan for debug endpoint
    this.lastScan = {
      time: new Date().toISOString(),
      upPrice, downPrice, sum: sum.toFixed(4),
      spotPrice, priceToBeat,
      btcMovePct: btcMovePct.toFixed(4),
      candleMinute,
      slug,
      arbThreshold: this.ARB_MAX_SUM,
      arbWouldTrigger: sum < this.ARB_MAX_SUM,
      alreadyArbTraded: slugState.arb,
      feeUp: feeUp.toFixed(4), feeDown: feeDown.toFixed(4)
    };

    // Log scan every 60 seconds so we can see what's happening
    if ((now - this.lastScanLog) > 60000) {
      console.log(`[ArbHunter] 🔍 Scan: Up $${upPrice.toFixed(3)} + Down $${downPrice.toFixed(3)} = $${sum.toFixed(3)} | Threshold: $${this.ARB_MAX_SUM} | BTC: ${btcMovePct >= 0 ? '+' : ''}${btcMovePct.toFixed(3)}% | Min ${candleMinute}/15`);
      this.lastScanLog = now;
    }

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

      // Deep value: tokens under 5¢ don't need BTC confirmation (R:R is 20:1+)
      // BUT: only trade if arb is impossible (sum > 0.98) or window closing (min > 10)
      // This prevents deep value from blocking arb opportunities
      const arbImpossible = sum > 0.98;
      const arbWindowClosing = candleMinute > 10;
      const isDeepValue = extremePrice <= this.DEEP_VALUE_MAX && extremePrice > 0.01 && (arbImpossible || arbWindowClosing);
      const isExtremeWithMove = extremePrice <= this.EXTREME_MAX_PRICE && extremePrice > 0.01 && btcMoveAbs >= this.EXTREME_MIN_BTC_MOVE;
      if (isDeepValue || isExtremeWithMove) {
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
  // For PURE_ARB: buys BOTH sides simultaneously (true arb)
  // For others: buys single directional side
  // ═══════════════════════════════════════════════════════════════
  async executeTrade(signal, marketData, priceToBeat = null) {
    if (!signal.shouldTrade) {
      return { success: false, reason: signal.reason };
    }

    try {
      // ═══ PURE ARB: BUY BOTH SIDES ═══════════════════════════
      if (signal.strategy === "PURE_ARB") {
        return await this._executeArbTrade(signal, marketData, priceToBeat);
      }

      // ═══ DIRECTIONAL: BUY ONE SIDE ══════════════════════════
      return await this._executeDirectionalTrade(signal, marketData, priceToBeat);

    } catch (error) {
      return { success: false, reason: `Trade failed: ${error.message}`, error };
    }
  }

  // ─── ARB: Buy BOTH Up AND Down simultaneously ────────────────
  async _executeArbTrade(signal, marketData, priceToBeat) {
    const upTokenId = marketData.upTokenId;
    const downTokenId = marketData.downTokenId;

    if (!upTokenId || !downTokenId) {
      return { success: false, reason: "Missing token IDs for arb (need both Up and Down)" };
    }

    const upPrice = marketData.upPrice;
    const downPrice = marketData.downPrice;
    const dollars = signal.arbDollars || this.ARB_SIZE;
    const MIN_SHARES = 5;

    // Calculate shares — buy EQUAL qty of both sides
    // Use the more expensive side to determine qty (so we can afford both)
    const maxPrice = Math.max(upPrice, downPrice);
    const halfDollars = dollars / 2;
    let size = Math.floor(halfDollars / maxPrice);
    if (size < MIN_SHARES) size = MIN_SHARES;

    const upBuyPrice = Math.min(0.95, upPrice + 0.003);
    const downBuyPrice = Math.min(0.95, downPrice + 0.003);
    const totalCost = (upBuyPrice * size) + (downBuyPrice * size);

    console.log(`[ArbHunter] 💰 ARB: Buying BOTH sides — Up ${size}x @ $${upBuyPrice.toFixed(3)} + Down ${size}x @ $${downBuyPrice.toFixed(3)} = $${totalCost.toFixed(2)}`);

    // Place BOTH orders simultaneously
    const [upOrder, downOrder] = await Promise.allSettled([
      this.tradingService.placeOrder({
        tokenId: upTokenId,
        side: "BUY",
        price: upBuyPrice,
        size,
        orderType: "GTC"
      }),
      this.tradingService.placeOrder({
        tokenId: downTokenId,
        side: "BUY",
        price: downBuyPrice,
        size,
        orderType: "GTC"
      })
    ]);

    const upOk = upOrder.status === "fulfilled" && upOrder.value?.orderID;
    const downOk = downOrder.status === "fulfilled" && downOrder.value?.orderID;

    if (!upOk && !downOk) {
      console.log("[ArbHunter] ❌ ARB FAILED: Both orders failed");
      return { success: false, reason: "Both arb orders failed" };
    }

    if (!upOk || !downOk) {
      // Only one leg filled — this is dangerous, log it clearly
      const filledSide = upOk ? "Up" : "Down";
      const failedSide = upOk ? "Down" : "Up";
      const failedReason = upOk 
        ? (downOrder.reason?.message || "unknown") 
        : (upOrder.reason?.message || "unknown");
      console.log(`[ArbHunter] ⚠️ ARB PARTIAL: ${filledSide} filled, ${failedSide} FAILED (${failedReason})`);
      console.log(`[ArbHunter] ⚠️ This is now a DIRECTIONAL bet, not an arb!`);
    } else {
      const payout = size * 1.0; // One side always pays $1/share
      const profit = payout - totalCost;
      console.log(`[ArbHunter] ✅ ARB COMPLETE: Both legs filled! Cost: $${totalCost.toFixed(2)} | Payout: $${payout.toFixed(2)} | Guaranteed profit: $${profit.toFixed(2)}`);
    }

    // Mark market as arb-traded
    const slug = marketData.marketSlug || "";
    if (slug) {
      const state = this.tradedSlugs.get(slug) || { arb: false, directional: false };
      state.arb = true;
      this.tradedSlugs.set(slug, state);
    }

    this.lastTradeTime = Date.now();
    this.lastBuyTime = Date.now();
    this.hourlyTrades.push(Date.now());
    this.todayTrades++;
    this.todayArbs++;

    // Record positions for both legs
    if (upOk) {
      const upCost = upBuyPrice * size;
      this.tradeHistory.push({
        timestamp: Date.now(), direction: "LONG", outcome: "Up",
        confidence: 95, edge: signal.edge,
        price: upBuyPrice, size, cost: upCost,
        orderId: upOrder.value.orderID, marketSlug: marketData.marketSlug
      });
      this.positionTracker.addPosition({
        orderId: upOrder.value.orderID, direction: "LONG", outcome: "Up",
        price: upBuyPrice, size, confidence: 95, edge: signal.edge,
        marketSlug: marketData.marketSlug, marketEndTime: marketData.marketEndTime || null,
        priceToBeat, upPrice, downPrice,
        indicators: {}, bullScore: 0, bearScore: 0,
        signals: signal.signals || [], strategy: "PURE_ARB_UP"
      });
    }
    if (downOk) {
      const downCost = downBuyPrice * size;
      this.tradeHistory.push({
        timestamp: Date.now(), direction: "SHORT", outcome: "Down",
        confidence: 95, edge: signal.edge,
        price: downBuyPrice, size, cost: downCost,
        orderId: downOrder.value.orderID, marketSlug: marketData.marketSlug
      });
      this.positionTracker.addPosition({
        orderId: downOrder.value.orderID, direction: "SHORT", outcome: "Down",
        price: downBuyPrice, size, confidence: 95, edge: signal.edge,
        marketSlug: marketData.marketSlug, marketEndTime: marketData.marketEndTime || null,
        priceToBeat, upPrice, downPrice,
        indicators: {}, bullScore: 0, bearScore: 0,
        signals: signal.signals || [], strategy: "PURE_ARB_DOWN"
      });
    }

    return {
      success: true,
      reason: `💰 ARB: Up ${size}x @ $${upBuyPrice.toFixed(3)} + Down ${size}x @ $${downBuyPrice.toFixed(3)} = $${totalCost.toFixed(2)} | ${upOk && downOk ? 'BOTH LEGS ✅' : 'PARTIAL ⚠️'}`
    };
  }

  // ─── DIRECTIONAL: Buy one side (extreme value or confirmed move) ─
  async _executeDirectionalTrade(signal, marketData, priceToBeat) {
    const tokenId = signal.targetOutcome === "Up" 
      ? marketData.upTokenId 
      : marketData.downTokenId;

    if (!tokenId) {
      return { success: false, reason: "Missing token ID" };
    }

    const price = Math.min(0.95, signal.marketPrice + 0.003);
    const MIN_SHARES = 5;
    
    let dollars;
    if (signal.strategy === "EXTREME_VALUE") {
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
      state.directional = true;
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

    this.todayTrades++;
    if (signal.strategy === "EXTREME_VALUE") this.todayExtremes++;
    else this.todayMoves++;

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
      tradedSlugs: this.tradedSlugs.size,
      lastScan: this.lastScan,
      opportunitiesSeen: this.opportunitiesSeen,
      arbSkipped: this.arbSkipped,
      moveSkipped: this.moveSkipped
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
