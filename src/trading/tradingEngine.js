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
    this.tradedMarkets = new Set();
    this.hourlyTrades = [];
    this.positionTracker = new PositionTracker();
    
    // ═══ NEW: Streak tracking for mean-reversion strategy ═══
    // Track actual BTC direction outcomes (Up/Down) for last N resolved markets
    this.outcomeDirections = [];  // ["Up","Down","Up",...] — actual BTC results
    this.maxOutcomeHistory = 10;
    
    // ═══ NEW: Risk management state ═══
    this.consecutiveLosses = 0;      // Current consecutive loss count
    this.reducedSizeTradesLeft = 0;   // How many trades remain at half-size
    this.dailyPnl = 0;               // Reset each day
    this.dailyPnlDate = new Date().toDateString();  // Track which day
    this.bankroll = 50;               // Starting bankroll estimate ($50)
  }

  _tradesInLastHour() {
    const oneHourAgo = Date.now() - 3600000;
    this.hourlyTrades = this.hourlyTrades.filter(t => t > oneHourAgo);
    return this.hourlyTrades.length;
  }

  // ═══ Derive actual BTC direction from resolved positions ═══
  _updateOutcomeDirections() {
    const closed = this.positionTracker.closedPositions;
    this.outcomeDirections = [];
    for (const pos of closed.slice(-this.maxOutcomeHistory)) {
      // Derive actual BTC direction from bet outcome + win/loss
      let actualDir;
      if (pos.status === "RESOLVED_WIN") {
        actualDir = pos.outcome; // Won → BTC went the way we bet
      } else {
        actualDir = pos.outcome === "Up" ? "Down" : "Up"; // Lost → BTC went opposite
      }
      this.outcomeDirections.push(actualDir);
    }
  }

  // ═══ Get the recent streak of same-direction outcomes ═══
  _getRecentStreak() {
    this._updateOutcomeDirections();
    if (this.outcomeDirections.length === 0) return { direction: null, length: 0 };
    
    const last = this.outcomeDirections[this.outcomeDirections.length - 1];
    let count = 0;
    for (let i = this.outcomeDirections.length - 1; i >= 0; i--) {
      if (this.outcomeDirections[i] === last) count++;
      else break;
    }
    return { direction: last, length: count };
  }

  // ═══ Calculate trade size based on signal strength + risk controls ═══
  _calculateTradeSize(signalStrength, marketPrice) {
    // Reset daily P&L if new day
    const today = new Date().toDateString();
    if (today !== this.dailyPnlDate) {
      this.dailyPnl = 0;
      this.dailyPnlDate = today;
    }

    // Daily stop: 12-15% drawdown → pause
    const dailyStopLimit = -(this.bankroll * 0.12);
    if (this.dailyPnl <= dailyStopLimit) {
      return { size: 0, reason: `Daily stop: P&L $${this.dailyPnl.toFixed(2)} hit ${dailyStopLimit.toFixed(2)} limit` };
    }

    // Base sizing: % of bankroll based on signal strength
    let pctOfBankroll;
    if (signalStrength === "STRONG") {
      pctOfBankroll = 0.10;  // 10% bankroll on strong signals
    } else if (signalStrength === "MEDIUM") {
      pctOfBankroll = 0.06;  // 6% bankroll on medium signals
    } else {
      pctOfBankroll = 0.04;  // 4% bankroll on weak/fallback signals
    }

    let maxDollars = Math.min(this.bankroll * pctOfBankroll, 5); // Never exceed $5

    // After 2-3 consecutive losses: reduce size on WEAK/MEDIUM signals only
    // Keep STRONG signals at full size to capture big wins on high-conviction setups
    if (this.reducedSizeTradesLeft > 0 && signalStrength !== "STRONG") {
      maxDollars = Math.min(maxDollars * 0.5, 3);
      console.log(`[Risk] Reduced size mode: ${this.reducedSizeTradesLeft} trades left | ${signalStrength} → half-size ($${maxDollars.toFixed(2)} max)`);
    }

    // Minimum $1 trade (except STRONG signals can go higher)
    if (signalStrength !== "STRONG") {
      maxDollars = Math.max(maxDollars, 1);
    }

    return { size: maxDollars, reason: null };
  }

  // ═══ Update risk state after a trade resolves ═══
  updateRiskState(won, pnl) {
    // Update daily P&L
    const today = new Date().toDateString();
    if (today !== this.dailyPnlDate) {
      this.dailyPnl = 0;
      this.dailyPnlDate = today;
    }
    this.dailyPnl += pnl;

    // Track consecutive losses
    if (won) {
      this.consecutiveLosses = 0;
      // Don't reset reducedSizeTradesLeft — let it count down naturally
    } else {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= 2) {
        this.reducedSizeTradesLeft = 5; // Halve size for next 5 trades
        console.log(`[Risk] ${this.consecutiveLosses} consecutive losses → entering reduced-size mode (5 trades at half-size)`);
      }
    }

    // Decrement reduced-size counter
    if (this.reducedSizeTradesLeft > 0) {
      this.reducedSizeTradesLeft--;
    }

    // Update bankroll estimate
    this.bankroll += pnl;
    if (this.bankroll < 10) this.bankroll = 10; // Floor
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

    // DAILY STOP: 12% drawdown → pause until next day
    const sizeCheck = this._calculateTradeSize("WEAK", 0.50);
    if (sizeCheck.size === 0) {
      return { shouldTrade: false, reason: sizeCheck.reason };
    }

    if (!prediction || !marketData) {
      return { shouldTrade: false, reason: "Missing prediction or market data" };
    }

    // TIMING: Enter minute 1-14 of candle
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
    // NEW STRATEGY ENGINE: Streak Reversion → Wick Fade → Indicators → Fallback
    // Key insight: 15m BTC outcomes revert after streaks
    // Always trade once per window with variable sizing
    // ═══════════════════════════════════════════════════════════════

    const upPrice = marketData.upPrice;
    const downPrice = marketData.downPrice;
    const combinedPrice = (upPrice && downPrice) ? upPrice + downPrice : null;
    const ptb = marketData.priceToBeat;

    console.log(`[Strategy] ══════════════════════════════════════`);
    console.log(`[Strategy] Up: $${upPrice?.toFixed(3) || 'N/A'} | Down: $${downPrice?.toFixed(3) || 'N/A'} | Combined: $${combinedPrice?.toFixed(3) || 'N/A'}`);

    // Spread check first — no point analyzing if spread is too wide
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.08) {
      return { shouldTrade: false, reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 8%)` };
    }

    // ─── STRATEGY 0: ARB / HEDGE ───────────────────────────────
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
        signalStrength: "STRONG",
        bullScore: 0, bearScore: 0, signals: [`ARB:combined=$${combinedPrice.toFixed(3)}`],
        reason: `ARB: ${cheaperSide} @ $${cheaperPrice.toFixed(3)} (combined $${combinedPrice.toFixed(3)})`
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // COMPUTE INDICATOR SCORES (used by multiple strategies below)
    // ═══════════════════════════════════════════════════════════════
    let bullScore = 0;
    let bearScore = 0;
    const signals = [];
    let indicatorCount = 0; // Total indicators that have an opinion

    // RSI — PRIORITIZED (weight: 2, extreme bonus: +2)
    let rsiDir = 0;
    if (indicators.rsi !== undefined && indicators.rsi !== null) {
      indicatorCount++;
      if (indicators.rsi > 70) { bearScore += 4; rsiDir = -1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):OVERBOUGHT(+4bear)`); }
      else if (indicators.rsi < 30) { bullScore += 4; rsiDir = 1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):OVERSOLD(+4bull)`); }
      else if (indicators.rsi > 55) { bullScore += 1; rsiDir = 1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):BULL(+1)`); }
      else if (indicators.rsi < 45) { bearScore += 1; rsiDir = -1; signals.push(`RSI(${indicators.rsi.toFixed(0)}):BEAR(+1)`); }
      else { signals.push(`RSI(${indicators.rsi.toFixed(0)}):NEUT`); }
    }

    // MACD Histogram (weight: 2, cross bonus: +1)
    let macdDir = 0;
    if (indicators.macdHist !== undefined && indicators.macdHist !== null) {
      indicatorCount++;
      if (indicators.macdHist > 0) { bullScore += 2; macdDir = 1; signals.push(`MACD:BULL(+2)`); }
      else if (indicators.macdHist < 0) { bearScore += 2; macdDir = -1; signals.push(`MACD:BEAR(+2)`); }
      // MACD cross (histogram changing sign = momentum shift)
      if (indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null) {
        if (indicators.macdHistDelta > 0 && indicators.macdHist > 0) { bullScore += 1; signals.push(`MACD-cross:BULL(+1)`); }
        else if (indicators.macdHistDelta < 0 && indicators.macdHist < 0) { bearScore += 1; signals.push(`MACD-cross:BEAR(+1)`); }
      }
    }

    // Heiken Ashi (weight: 2, reversal bonus)
    let heikenDir = 0;
    if (indicators.heikenColor !== undefined && indicators.heikenColor !== null) {
      indicatorCount++;
      if (indicators.heikenColor === "green") {
        bullScore += 2; heikenDir = 1; signals.push(`HA:BULL(+2)`);
        if (indicators.heikenCount >= 3) { bullScore += 1; signals.push(`HA-streak(${indicators.heikenCount}):+1`); }
      } else if (indicators.heikenColor === "red") {
        bearScore += 2; heikenDir = -1; signals.push(`HA:BEAR(+2)`);
        if (indicators.heikenCount >= 3) { bearScore += 1; signals.push(`HA-streak(${indicators.heikenCount}):+1`); }
      }
    }

    // Price vs VWAP (weight: 1)
    let vwapDir = 0;
    if (indicators.priceVsVwap !== undefined) {
      indicatorCount++;
      if (indicators.priceVsVwap > 0) { bullScore += 1; vwapDir = 1; signals.push(`VWAP:BULL(+1)`); }
      else if (indicators.priceVsVwap < 0) { bearScore += 1; vwapDir = -1; signals.push(`VWAP:BEAR(+1)`); }
    }

    // VWAP Slope (weight: 1)
    if (indicators.vwapSlope !== undefined && indicators.vwapSlope !== null) {
      indicatorCount++;
      if (indicators.vwapSlope > 0) { bullScore += 1; signals.push(`Slope:BULL(+1)`); }
      else if (indicators.vwapSlope < 0) { bearScore += 1; signals.push(`Slope:BEAR(+1)`); }
    }

    const scoreDiff = Math.abs(bullScore - bearScore);
    const winningDir = bullScore >= bearScore ? 1 : -1;
    const indicatorConf = (bullScore + bearScore) > 0 ? (Math.max(bullScore, bearScore) / (bullScore + bearScore)) * 100 : 50;

    console.log(`[Strategy] BULL: ${bullScore} | BEAR: ${bearScore} | Diff: ${scoreDiff} | Conf: ${indicatorConf.toFixed(0)}%`);
    console.log(`[Strategy] Signals: ${signals.join(', ')}`);

    // ─── STRATEGY 1 (PRIMARY): MEAN REVERSION ON RECENT STREAKS ──
    // Track last 3-5 resolved outcomes. After 2+ consecutive same direction → bet opposite
    // This is the STRONGEST edge in 15m BTC markets (ranging/choppy regime)
    const streak = this._getRecentStreak();
    console.log(`[Strategy] Outcome streak: ${streak.length}x ${streak.direction || 'none'} | History: [${this.outcomeDirections.slice(-5).join(',')}]`);

    if (streak.length >= 2 && streak.direction) {
      // Bet OPPOSITE to the streak (mean reversion)
      const revertDir = streak.direction === "Up" ? "Down" : "Up";
      const revertPrice = revertDir === "Up" ? upPrice : downPrice;
      const revertDirection = revertDir === "Up" ? "LONG" : "SHORT";
      
      // Check if the revert side is cheap enough (good R:R)
      if (revertPrice && revertPrice <= 0.45 && revertPrice > 0.08) {
        // Higher conviction with longer streaks
        const streakConf = streak.length >= 3 ? 75 : 68;
        const signalStr = streak.length >= 3 ? "STRONG" : "MEDIUM";
        
        // Check if indicators also support the reversion (bonus, not required)
        const indicatorsAgree = (revertDir === "Up" && bullScore > bearScore) || (revertDir === "Down" && bearScore > bullScore);
        const finalConf = indicatorsAgree ? Math.min(streakConf + 5, 85) : streakConf;
        const finalStr = indicatorsAgree && streak.length >= 3 ? "STRONG" : signalStr;
        
        console.log(`[Strategy] 🔄 STREAK REVERSION: ${streak.length}x ${streak.direction} → bet ${revertDir} @ $${revertPrice.toFixed(3)} | Conf: ${finalConf}% | Indicators agree: ${indicatorsAgree}`);
        console.log(`[Strategy] ══════════════════════════════════════`);
        return {
          shouldTrade: true,
          direction: revertDirection,
          targetOutcome: revertDir,
          confidence: finalConf,
          edge: Math.max(0.50 - revertPrice, 0.05),
          marketPrice: revertPrice,
          modelProb: finalConf / 100,
          strategy: `STREAK_REVERT_${streak.length}x`,
          signalStrength: finalStr,
          bullScore, bearScore, signals: [...signals, `STREAK:${streak.length}x${streak.direction}→${revertDir}`, `IND_AGREE:${indicatorsAgree}`],
          reason: `STREAK REVERT: ${streak.length}x ${streak.direction} → ${revertDir} @ $${revertPrice.toFixed(3)}${indicatorsAgree ? ' +indicators' : ''}`
        };
      } else {
        console.log(`[Strategy] ⚠ Streak revert to ${revertDir} but price $${revertPrice?.toFixed(3)} out of range — falling through`);
      }
    }

    // ─── STRATEGY 2 (SECONDARY): OVERREACTION / WICK FADE ─────────
    // If BTC moved >0.5% in last 1-5 minutes, fade the panic/retail FOMO
    // Prefer entries when the opposite side is cheap (≤ 40-45¢)
    if (ptb && indicators.lastPrice) {
      const currentMove = ((indicators.lastPrice - ptb) / ptb) * 100;
      const absMove = Math.abs(currentMove);
      
      if (absMove >= 0.05) { // 0.05% on BTC ≈ significant for 15m
        const fadeDir = currentMove > 0 ? "Down" : "Up"; // Fade the move
        const fadePrice = fadeDir === "Up" ? upPrice : downPrice;
        const fadeDirection = fadeDir === "Up" ? "LONG" : "SHORT";
        
        // RSI extreme adds conviction to the fade
        const rsiConfirms = (currentMove > 0 && indicators.rsi > 70) || (currentMove < 0 && indicators.rsi < 30);
        // MACD decelerating = momentum exhaustion
        const macdDecel = indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null &&
          ((currentMove > 0 && indicators.macdHistDelta < 0) || (currentMove < 0 && indicators.macdHistDelta > 0));
        
        if (fadePrice && fadePrice <= 0.45 && fadePrice > 0.08) {
          const hasExhaustion = rsiConfirms || macdDecel;
          
          if (hasExhaustion) {
            const fadeConf = (rsiConfirms && macdDecel) ? 72 : 65;
            const fadeStr = (rsiConfirms && macdDecel && fadePrice < 0.35) ? "STRONG" : "MEDIUM";
            
            console.log(`[Strategy] 🔥 WICK FADE: BTC ${currentMove > 0 ? 'UP' : 'DOWN'} ${absMove.toFixed(3)}% → fade with ${fadeDir} @ $${fadePrice.toFixed(3)} | RSI:${rsiConfirms} MACD-decel:${macdDecel}`);
            console.log(`[Strategy] ══════════════════════════════════════`);
            return {
              shouldTrade: true,
              direction: fadeDirection,
              targetOutcome: fadeDir,
              confidence: fadeConf,
              edge: Math.max(0.50 - fadePrice, 0.05),
              marketPrice: fadePrice,
              modelProb: fadeConf / 100,
              strategy: "WICK_FADE",
              signalStrength: fadeStr,
              bullScore, bearScore, signals: [...signals, `FADE:move=${currentMove.toFixed(3)}%`, `RSI_EXT:${rsiConfirms}`, `MACD_DECEL:${macdDecel}`],
              reason: `WICK FADE: ${absMove.toFixed(3)}% move → ${fadeDir} @ $${fadePrice.toFixed(3)} (exhaustion confirmed)`
            };
          } else {
            console.log(`[Strategy] ⚠ BTC moved ${currentMove.toFixed(3)}% but no exhaustion (RSI:${rsiConfirms}, MACD-decel:${macdDecel}) — not fading`);
          }
        }
      }
    }

    // ─── STRATEGY 3 (SECONDARY): INDICATOR CONSENSUS ──────────────
    // Require strong agreement: ≥4 indicators voting same way + conf ≥65%
    // Prioritize RSI extremes + MACD cross + Heiken reversal
    
    let direction = winningDir > 0 ? "LONG" : "SHORT";
    let targetOutcome = direction === "LONG" ? "Up" : "Down";
    let marketPrice = direction === "LONG" ? upPrice : downPrice;

    if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
      // Try other side
      direction = direction === "LONG" ? "SHORT" : "LONG";
      targetOutcome = direction === "LONG" ? "Up" : "Down";
      marketPrice = direction === "LONG" ? upPrice : downPrice;
      if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
        return { shouldTrade: false, reason: "Invalid market prices" };
      }
    }

    // Max price cap — 45¢
    if (marketPrice > 0.45) {
      const otherDirection = direction === "LONG" ? "SHORT" : "LONG";
      const otherOutcome = otherDirection === "LONG" ? "Up" : "Down";
      const otherPrice = otherDirection === "LONG" ? upPrice : downPrice;
      
      if (otherPrice && otherPrice <= 0.45 && otherPrice > 0.08) {
        direction = otherDirection;
        targetOutcome = otherOutcome;
        marketPrice = otherPrice;
        console.log(`[Strategy] 🔄 Winning side too expensive, switching to ${targetOutcome} @ $${marketPrice.toFixed(3)}`);
      }
    }

    // Strong consensus: scoreDiff >= 4 AND conf >= 65% AND price <= 45¢
    if (scoreDiff >= 4 && indicatorConf >= 65 && marketPrice <= 0.45) {
      // Check if RSI extreme or MACD cross is part of the signal (bonus)
      const hasRsiExtreme = indicators.rsi !== undefined && (indicators.rsi > 70 || indicators.rsi < 30);
      const hasMacdCross = indicators.macdHistDelta !== undefined && indicators.macdHistDelta !== null &&
        ((macdDir === 1 && indicators.macdHistDelta > 0) || (macdDir === -1 && indicators.macdHistDelta < 0));
      
      // Don't bet AGAINST the streak if there's an active streak
      const streakConflict = streak.length >= 2 && streak.direction === targetOutcome;
      if (streakConflict) {
        console.log(`[Strategy] ⚠ Indicator consensus says ${targetOutcome} but streak is ${streak.length}x ${streak.direction} (same dir) — skip momentum, let streak reversion handle it`);
      } else {
        const momentumConf = hasRsiExtreme ? 72 : hasMacdCross ? 68 : 65;
        const momentumStr = (hasRsiExtreme && hasMacdCross && marketPrice < 0.35) ? "STRONG" : (scoreDiff >= 6) ? "STRONG" : "MEDIUM";
        
        console.log(`[Strategy] ✅ INDICATOR CONSENSUS: ${direction} ${targetOutcome} @ $${marketPrice.toFixed(3)} | Diff: ${scoreDiff} | Conf: ${indicatorConf.toFixed(0)}% | RSI-ext: ${hasRsiExtreme} | MACD-cross: ${hasMacdCross}`);
        console.log(`[Strategy] ══════════════════════════════════════`);
        return {
          shouldTrade: true,
          direction,
          targetOutcome,
          confidence: momentumConf,
          edge: Math.max((momentumConf / 100) - marketPrice, 0.01),
          marketPrice,
          modelProb: momentumConf / 100,
          strategy: "INDICATOR_CONSENSUS",
          signalStrength: momentumStr,
          bullScore, bearScore, signals,
          reason: `CONSENSUS ${direction} ${bullScore}v${bearScore} @ $${marketPrice.toFixed(2)}${hasRsiExtreme ? ' +RSI' : ''}${hasMacdCross ? ' +MACD' : ''}`
        };
      }
    }

    // ─── MANDATORY FALLBACK: Always trade once per window ──────────
    // Pick the side with highest combined probability from ALL signals
    // Size very small on weak signals (4% bankroll)
    
    // Determine best direction from all available data
    let fallbackDir, fallbackOutcome, fallbackPrice;
    
    // Start with indicator direction
    if (bullScore > bearScore && upPrice && upPrice <= 0.45 && upPrice > 0.08) {
      fallbackDir = "LONG"; fallbackOutcome = "Up"; fallbackPrice = upPrice;
    } else if (bearScore > bullScore && downPrice && downPrice <= 0.45 && downPrice > 0.08) {
      fallbackDir = "SHORT"; fallbackOutcome = "Down"; fallbackPrice = downPrice;
    } else {
      // Pick cheapest side (better R:R on coin-flip)
      if (upPrice && downPrice) {
        if (upPrice <= downPrice && upPrice > 0.08 && upPrice <= 0.45) {
          fallbackDir = "LONG"; fallbackOutcome = "Up"; fallbackPrice = upPrice;
        } else if (downPrice > 0.08 && downPrice <= 0.45) {
          fallbackDir = "SHORT"; fallbackOutcome = "Down"; fallbackPrice = downPrice;
        }
      }
    }

    // If streak exists, override fallback to bet AGAINST streak
    if (streak.length >= 1 && streak.direction) {
      const antiStreakDir = streak.direction === "Up" ? "Down" : "Up";
      const antiStreakPrice = antiStreakDir === "Up" ? upPrice : downPrice;
      if (antiStreakPrice && antiStreakPrice <= 0.45 && antiStreakPrice > 0.08) {
        fallbackDir = antiStreakDir === "Up" ? "LONG" : "SHORT";
        fallbackOutcome = antiStreakDir;
        fallbackPrice = antiStreakPrice;
        console.log(`[Strategy] 🔸 Fallback: using anti-streak direction (${streak.length}x ${streak.direction} → ${antiStreakDir})`);
      }
    }

    if (fallbackDir && fallbackPrice) {
      console.log(`[Strategy] 🔸 FALLBACK: ${fallbackDir} ${fallbackOutcome} @ $${fallbackPrice.toFixed(3)} | Score: ${bullScore}v${bearScore} | Weak signal — small size`);
      console.log(`[Strategy] ══════════════════════════════════════`);
      return {
        shouldTrade: true,
        direction: fallbackDir,
        targetOutcome: fallbackOutcome,
        confidence: 55,
        edge: Math.max(0.50 - fallbackPrice, 0.02),
        marketPrice: fallbackPrice,
        modelProb: 0.52,
        strategy: "FALLBACK",
        signalStrength: "WEAK",
        bullScore, bearScore, signals: [...signals, `FALLBACK:cheapest_side`],
        reason: `FALLBACK ${fallbackDir} @ $${fallbackPrice.toFixed(2)} (mandatory trade, small size)`
      };
    }

    console.log(`[Strategy] ⚠ No valid entry found — both sides too expensive or invalid`);
    console.log(`[Strategy] ══════════════════════════════════════`);
    return { shouldTrade: false, reason: "No valid entry — prices out of range" };
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
      
      // ═══ VARIABLE SIZING based on signal strength + risk controls ═══
      const signalStrength = signal.signalStrength || "WEAK";
      const sizeCalc = this._calculateTradeSize(signalStrength, price);
      
      if (sizeCalc.size === 0) {
        return { success: false, reason: sizeCalc.reason || "Size calculation returned 0" };
      }

      const maxOrderDollars = sizeCalc.size; // Dynamic based on signal strength
      const MIN_SHARES = 5; // Polymarket minimum order size
      
      // Calculate shares to stay under dynamic max
      let size = Math.floor(maxOrderDollars / price);
      
      // Ensure we meet Polymarket's minimum of 5 shares
      if (size < MIN_SHARES) {
        size = MIN_SHARES;
      }
      
      // Verify cost doesn't exceed max
      const maxCost = price * size;
      if (maxCost > 5) {
        // Hard cap at $5 regardless
        size = Math.floor(5 / price);
        if (size < MIN_SHARES) {
          return { success: false, reason: `Cannot place order: price too high ($${price.toFixed(3)}, min 5 shares = $${(price * MIN_SHARES).toFixed(2)} > $5)` };
        }
      }
      
      console.log(`[Sizing] Signal: ${signalStrength} | Max: $${maxOrderDollars.toFixed(2)} | Shares: ${size} @ $${price.toFixed(3)} = $${(price * size).toFixed(2)} | Reduced mode: ${this.reducedSizeTradesLeft > 0 ? 'YES' : 'NO'}`);

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

  // Check and resolve positions when market ends — also updates risk state
  checkResolutions(currentPrice, priceToBeat) {
    const resolved = this.positionTracker.checkResolutions(currentPrice, priceToBeat);
    
    // Update risk state for each resolved position
    for (const pos of resolved) {
      const won = pos.status === "RESOLVED_WIN";
      this.updateRiskState(won, pos.pnl || 0);
    }
    
    return resolved;
  }

  // Check if any positions should be stopped out (20% loss)
  checkStopLoss(currentMarketPrices) {
    return this.positionTracker.checkStopLoss(currentMarketPrices);
  }

  // Cleanup stale positions
  cleanupStalePositions() {
    this.positionTracker.cleanupStalePositions();
  }

  // ═══ MID-WINDOW HEDGING ═══════════════════════════════════════
  // After ~7-10 min: if we have a directional position and the opposite
  // side becomes very cheap (≤ 25-30¢), add a small hedge.
  // This turns full losses into small net wins/losses → pushes win rate up.
  async checkHedgeOpportunity(marketData) {
    if (!this.config.enabled || !marketData) return null;

    const slug = marketData.marketSlug || "";
    const openForThisMarket = this.positionTracker.openPositions.filter(
      p => p.marketSlug === slug && p.status === "OPEN"
    );

    if (openForThisMarket.length === 0) return null;

    // Only hedge if we're 7+ minutes into the candle
    const now = Date.now();
    const marketEndTime = marketData.marketEndTime;
    if (!marketEndTime) return null;
    
    const msLeft = marketEndTime - now;
    const minLeft = msLeft / 60000;
    if (minLeft > 8 || minLeft < 2) return null; // Only hedge in minute 7-13

    const pos = openForThisMarket[0]; // Our main position
    const oppositeOutcome = pos.outcome === "Up" ? "Down" : "Up";
    const oppositePrice = oppositeOutcome === "Up" ? marketData.upPrice : marketData.downPrice;
    const oppositeTokenId = oppositeOutcome === "Up" ? marketData.upTokenId : marketData.downTokenId;

    // Only hedge if opposite side is very cheap (≤ 28¢)
    if (!oppositePrice || oppositePrice > 0.28 || oppositePrice < 0.05) return null;
    if (!oppositeTokenId) return null;

    // Check if we already hedged this market
    const hedgeKey = `hedge_${slug}`;
    if (this.tradedMarkets.has(hedgeKey)) return null;

    // Small hedge: ~30-40% of original position cost
    const hedgeDollars = Math.min(pos.cost * 0.35, 2); // Max $2 hedge
    const hedgeShares = Math.max(5, Math.floor(hedgeDollars / oppositePrice));
    const hedgeCost = oppositePrice * hedgeShares;

    console.log(`[Hedge] 🛡 Opportunity: ${oppositeOutcome} @ $${oppositePrice.toFixed(3)} (${minLeft.toFixed(1)} min left) | Main pos: ${pos.outcome} @ $${pos.entryPrice.toFixed(3)}`);
    console.log(`[Hedge] Hedge size: ${hedgeShares} shares @ $${oppositePrice.toFixed(3)} = $${hedgeCost.toFixed(2)} (${((hedgeCost / pos.cost) * 100).toFixed(0)}% of main)`);

    try {
      const hedgePrice = Math.min(0.95, oppositePrice + 0.003);
      const order = await this.tradingService.placeOrder({
        tokenId: oppositeTokenId,
        side: "BUY",
        price: hedgePrice,
        size: hedgeShares,
        orderType: "GTC"
      });

      if (!order || !order.orderID) {
        console.log("[Hedge] Hedge order failed - no orderID");
        return null;
      }

      // Mark as hedged so we don't double-hedge
      this.tradedMarkets.add(hedgeKey);

      // Track the hedge position
      this.positionTracker.addPosition({
        orderId: order.orderID,
        direction: oppositeOutcome === "Up" ? "LONG" : "SHORT",
        outcome: oppositeOutcome,
        price: hedgePrice,
        size: hedgeShares,
        confidence: 50,
        edge: 0.50 - oppositePrice,
        marketSlug: slug,
        marketEndTime: marketEndTime,
        priceToBeat: pos.priceToBeat,
        upPrice: marketData.upPrice,
        downPrice: marketData.downPrice,
        indicators: {},
        bullScore: 0,
        bearScore: 0,
        signals: [`HEDGE:opposite_of_${pos.outcome}`],
        strategy: "HEDGE"
      });

      console.log(`[Hedge] ✅ Hedge placed: ${oppositeOutcome} ${hedgeShares}x @ $${hedgePrice.toFixed(3)}`);
      return { hedged: true, outcome: oppositeOutcome, cost: hedgeCost };
    } catch (err) {
      console.log(`[Hedge] Hedge failed: ${err.message}`);
      return null;
    }
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
      tradesThisHour: this._tradesInLastHour(),
      // New risk state info
      consecutiveLosses: this.consecutiveLosses,
      reducedSizeTradesLeft: this.reducedSizeTradesLeft,
      dailyPnl: this.dailyPnl,
      bankroll: this.bankroll,
      outcomeStreak: this._getRecentStreak()
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
