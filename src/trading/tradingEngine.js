import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// DIP-ARB v2 — HEDGED PAIR TRADING WITH STRICT FIXES
//
// Core: Buy BOTH sides cheap → pair cost < $1.00 → guaranteed profit.
// 
// v2 Fixes (from trade data analysis):
// 1. STRICT HEDGING: Leg2 only if ≤ 35¢ (never buy 69¢ hedges)
// 2. QTY BALANCE: Always buy the side with lower qty first
// 3. PROFIT LOCK: Stop once min(up,down) × $1 > totalSpent
// 4. LONG BIAS: Reduce LONG size after consecutive Down wins
// 5. WICK FILTER: Require BTC move > 0.15% for entry
// 6. SKIP FLAT: No forced entries — skip if no cheap side by min 7
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
    
    // ─── DIP-ARB v2 PARAMETERS ──────────────────────────────
    this.currentWindow = null;
    this.windowHistory = [];
    
    // Entry thresholds — BOTH sides must be cheap
    this.CHEAP_THRESHOLD = 0.35;     // Max price to buy ANY side
    this.IDEAL_THRESHOLD = 0.25;     // Ideal entry (3:1+ R:R)
    this.MAX_PAIR_ASK = 0.985;       // Only enter if Up+Down ≤ 98.5¢ (edge exists)
    
    // Sizing
    this.BUY_SIZE_DOLLARS = 2;       // $2 per buy
    this.MAX_WINDOW_SPEND = 6;       // Max $6 per window (enough for 2-3 buys)
    this.LONG_DISCOUNT = 0.7;        // Reduce LONG size to 70% after consecutive Down wins
    
    // Timing & cooldowns
    this.MIN_BUY_COOLDOWN = 45000;   // 45s between buys (was 30s — too fast)
    this.MIN_CANDLE_MINUTE = 2;      // Don't trade first 2 min
    this.SKIP_AFTER_MINUTE = 7;      // Don't start NEW positions after min 7
    this.HEDGE_DEADLINE_MIN = 2;     // Must hedge by 2 min left or hold
    
    // Wick / momentum filter
    this.MIN_BTC_MOVE_PCT = 0.30;    // Require ≥0.30% BTC move to trigger entry (was 0.15 — too weak)
    
    // Tracking
    this.lastBuyTime = 0;
    this.consecutiveDownWins = 0;    // Track consecutive Down resolutions
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
    console.log(`[DipArb2] 🆕 New window: ${slug.slice(-20)}`);
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
      console.log(`[DipArb2] 📦 Archived | Spent: $${totalSpent.toFixed(2)} | Pairs: ${minQty} | PairCost: ${pairCost ? '$' + pairCost.toFixed(3) : 'N/A'} | Balance: ${balanceRatio}% | Est P&L: $${estProfit.toFixed(2)} | ${w.locked ? '🔒LOCKED' : '⚠OPEN'}`);
      if (pairCost && pairCost > 1.0) {
        console.log(`[DipArb2] ⚠ WARNING: Final pair cost $${pairCost.toFixed(3)} > $1.00 — hedge failed!`);
      }
      this.windowHistory.push({ ...w, archivedAt: Date.now(), totalSpent, minQty, estProfit, pairCost });
    }
    this.currentWindow = null;
  }

  _calcPairCost(w) {
    if (w.qtyUp === 0 || w.qtyDown === 0) return null;
    return (w.costUp / w.qtyUp) + (w.costDown / w.qtyDown);
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // DipArb v2 — strict hedging, qty balance, wick filter
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

    const combinedPrice = upPrice + downPrice;

    // CIRCUIT BREAKER: Max $15 total open exposure
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= 15) {
      return { shouldTrade: false, reason: `Circuit breaker: exposure $${totalExposure.toFixed(2)} >= $15` };
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

    // ─── GET/CREATE WINDOW ────────────────────────────────────
    const window = this._getOrCreateWindow(slug);
    const totalSpent = window.costUp + window.costDown;

    // ─── FIX 3: PROFIT LOCK — stop once guaranteed profit ────
    const minQty = Math.min(window.qtyUp, window.qtyDown);
    if (minQty > 0 && (minQty * 1.0) > totalSpent) {
      window.locked = true;
      const pairCost = this._calcPairCost(window);
      const profit = minQty * 1.0 - totalSpent;
      console.log(`[DipArb2] 🔒 PROFIT LOCKED! ${minQty} pairs | Cost: $${pairCost?.toFixed(3)} | Guaranteed: +$${profit.toFixed(2)}`);
      return { shouldTrade: false, reason: `Profit locked! ${minQty} pairs +$${profit.toFixed(2)}` };
    }

    // Max window spend
    if (totalSpent >= this.MAX_WINDOW_SPEND) {
      return { shouldTrade: false, reason: `Window budget exhausted ($${totalSpent.toFixed(2)})` };
    }

    // ─── FIX 5: WICK / MOMENTUM FILTER ──────────────────────
    // Require some BTC movement — skip flat/low-vol windows
    const btcDelta3m = indicators.delta3m || 0;
    const btcMovePct = Math.abs(btcDelta3m);

    console.log(`[DipArb2] ══════════════════════════════════════`);
    console.log(`[DipArb2] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Sum: $${combinedPrice.toFixed(3)} | Min ${candleMinute}/15`);
    console.log(`[DipArb2] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) | ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) | BTC Δ3m: ${(btcDelta3m * 100).toFixed(3)}%`);

    // ─── FIX 1: PAIR ASK SUM CHECK ──────────────────────────
    // Only enter if there's actual mispricing (sum < 98.5¢)
    if (combinedPrice > this.MAX_PAIR_ASK && window.buys.length === 0) {
      console.log(`[DipArb2] ⏳ No edge: sum $${combinedPrice.toFixed(3)} > $${this.MAX_PAIR_ASK}`);
      console.log(`[DipArb2] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No edge (sum $${combinedPrice.toFixed(3)} > $${this.MAX_PAIR_ASK})` };
    }

    // ─── DECIDE WHAT TO BUY ─────────────────────────────────
    // FIX 2: Always prefer the side with LOWER qty (force balance)
    // FIX 1: Only buy if the target side is ≤ CHEAP_THRESHOLD
    
    let buyOutcome = null;
    let buyPrice = null;
    let buyReason = "";

    const hasUp = window.qtyUp > 0;
    const hasDown = window.qtyDown > 0;
    const upCheap = upPrice <= this.CHEAP_THRESHOLD && upPrice > 0.05;
    const downCheap = downPrice <= this.CHEAP_THRESHOLD && downPrice > 0.05;

    // ─── FIX 7: NO PILING INTO ONE SIDE ────────────────────
    // If we have one side but NOT the other, only buy the MISSING side.
    // Never add more to a side that's already filled — that's just
    // increasing directional risk with no hedge benefit.
    // Max 1 unhedged buy ($2 risk), then WAIT for hedge or skip.
    
    if (hasUp && !hasDown) {
      if (downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "HEDGE (need Down)";
      } else {
        console.log(`[DipArb2] ⏳ Have ${window.qtyUp} Up, waiting for Down ≤$${this.CHEAP_THRESHOLD} (currently $${downPrice.toFixed(3)})`);
        console.log(`[DipArb2] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for Down hedge (Down $${downPrice.toFixed(2)} > $${this.CHEAP_THRESHOLD})` };
      }
    } else if (hasDown && !hasUp) {
      if (upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "HEDGE (need Up)";
      } else {
        console.log(`[DipArb2] ⏳ Have ${window.qtyDown} Down, waiting for Up ≤$${this.CHEAP_THRESHOLD} (currently $${upPrice.toFixed(3)})`);
        console.log(`[DipArb2] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for Up hedge (Up $${upPrice.toFixed(2)} > $${this.CHEAP_THRESHOLD})` };
      }
    } else if (hasUp && hasDown) {
      // Both sides exist — buy the side with FEWER shares if cheap
      if (window.qtyUp < window.qtyDown && upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "REBALANCE (Up qty low)";
      } else if (window.qtyDown < window.qtyUp && downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "REBALANCE (Down qty low)";
      }
      // If balanced and both cheap, buy the cheaper one to grow position
      if (!buyOutcome && upCheap && downCheap) {
        if (window.qtyUp <= window.qtyDown) {
          buyOutcome = "Up"; buyPrice = upPrice;
        } else {
          buyOutcome = "Down"; buyPrice = downPrice;
        }
        buyReason = "GROW (balanced, both cheap)";
      }
    } else {
      // No position yet — FIX 6: only start new position if not too late
      if (candleMinute > this.SKIP_AFTER_MINUTE) {
        console.log(`[DipArb2] ⏳ Min ${candleMinute} > ${this.SKIP_AFTER_MINUTE} — too late to start new position`);
        console.log(`[DipArb2] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Too late for new position (min ${candleMinute})` };
      }

      // FIX 5: Require BTC movement for initial entry
      if (btcMovePct < this.MIN_BTC_MOVE_PCT) {
        console.log(`[DipArb2] ⏳ Low vol: BTC Δ3m ${(btcMovePct * 100).toFixed(3)}% < ${this.MIN_BTC_MOVE_PCT}% — skip flat window`);
        console.log(`[DipArb2] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Low volatility (${(btcMovePct * 100).toFixed(2)}% < ${this.MIN_BTC_MOVE_PCT}%)` };
      }

      // FIX 7 refinement: Only restrict single-side buys if ONE is cheap and OTHER is expensive
      // If BOTH are cheap, allow INITIAL buys (they'll hedge quickly)
      // If ONLY ONE is cheap, skip (wait for both to be cheap)
      if (upCheap && downCheap) {
        // Both cheap — buy the cheaper one (or either if equal)
        if (upPrice <= downPrice) {
          buyOutcome = "Up"; buyPrice = upPrice;
        } else {
          buyOutcome = "Down"; buyPrice = downPrice;
        }
        buyReason = "INITIAL (both cheap)";
      } else if ((upCheap && !downCheap) || (downCheap && !upCheap)) {
        // Only one side cheap — skip for now (wait for both)
        const cheapSide = upCheap ? "Up" : "Down";
        const expensiveSide = upCheap ? "Down" : "Up";
        const expensivePrice = upCheap ? downPrice : upPrice;
        console.log(`[DipArb2] ⏳ Only ${cheapSide} cheap, ${expensiveSide} too expensive ($${expensivePrice.toFixed(3)}) — wait for both`);
        console.log(`[DipArb2] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Only ${cheapSide} cheap ($${(upCheap ? upPrice : downPrice).toFixed(2)}) — wait for both sides ≤$${this.CHEAP_THRESHOLD}` };
      }
    }

    if (!buyOutcome) {
      console.log(`[DipArb2] ⏳ No cheap side: Up $${upPrice.toFixed(3)} / Down $${downPrice.toFixed(3)} > $${this.CHEAP_THRESHOLD}`);
      console.log(`[DipArb2] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No cheap side (Up $${upPrice.toFixed(2)}, Down $${downPrice.toFixed(2)})` };
    }

    // ─── FIX 1: SIMULATE PAIR COST BEFORE BUYING ────────────
    // Only buy Leg2/balance if it would LOWER the projected pair cost
    if (window.buys.length > 0) {
      const simSize = Math.floor(this.BUY_SIZE_DOLLARS / buyPrice);
      const simCost = buyPrice * simSize;
      const simUp = window.qtyUp + (buyOutcome === "Up" ? simSize : 0);
      const simDown = window.qtyDown + (buyOutcome === "Down" ? simSize : 0);
      const simCostUp = window.costUp + (buyOutcome === "Up" ? simCost : 0);
      const simCostDown = window.costDown + (buyOutcome === "Down" ? simCost : 0);
      
      if (simUp > 0 && simDown > 0) {
        const simPairCost = (simCostUp / simUp) + (simCostDown / simDown);
        const currentPairCost = this._calcPairCost(window);
        
        if (simPairCost >= 1.0) {
          console.log(`[DipArb2] ⚠ Simulated pair cost $${simPairCost.toFixed(3)} >= $1.00 — SKIP (would lose money)`);
          console.log(`[DipArb2] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Pair cost would be $${simPairCost.toFixed(3)} >= $1.00` };
        }
        
        if (currentPairCost && simPairCost > currentPairCost) {
          console.log(`[DipArb2] ⚠ Would raise pair cost $${currentPairCost.toFixed(3)} → $${simPairCost.toFixed(3)} — SKIP`);
          console.log(`[DipArb2] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Would raise pair cost to $${simPairCost.toFixed(3)}` };
        }
        
        console.log(`[DipArb2] ✓ Sim pair cost: $${simPairCost.toFixed(3)} (${currentPairCost ? 'from $' + currentPairCost.toFixed(3) : 'new'})`);
      }
    }

    // Record starting pair cost for diagnostics
    if (window.buys.length === 0) {
      window.startPairCost = combinedPrice;
    }

    const rr = ((1 - buyPrice) / buyPrice).toFixed(1);
    const pairCostStr = this._calcPairCost(window)?.toFixed(3) || "N/A";
    console.log(`[DipArb2] ✅ BUY ${buyOutcome} @ $${buyPrice.toFixed(3)} | ${buyReason} | R:R ${rr}:1 | PairCost: $${pairCostStr}`);
    console.log(`[DipArb2] ══════════════════════════════════════`);

    // ─── FIX 4: LONG BIAS — BLOCK LONG after consecutive Down wins unless super cheap
    const isLong = buyOutcome === "Up";
    if (isLong && this.consecutiveDownWins >= 2 && buyPrice > 0.28) {
      console.log(`[DipArb2] ⛔ LONG blocked: ${this.consecutiveDownWins} consecutive Down wins & Up $${buyPrice.toFixed(3)} > $0.28`);
      console.log(`[DipArb2] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `LONG blocked after ${this.consecutiveDownWins} Down wins (Up $${buyPrice.toFixed(2)} > $0.28)` };
    }
    const applyLongDiscount = isLong && this.consecutiveDownWins >= 1;

    return {
      shouldTrade: true,
      direction: isLong ? "LONG" : "SHORT",
      targetOutcome: buyOutcome,
      confidence: 85,
      edge: 1.0 - combinedPrice,
      marketPrice: buyPrice,
      modelProb: 0.85,
      strategy: `DIPARB_${buyReason.split(' ')[0]}`,
      applyLongDiscount,
      bullScore: 0, bearScore: 0,
      signals: [`diparb:${buyOutcome}@$${buyPrice.toFixed(3)}`, buyReason],
      reason: `${buyOutcome} @ $${buyPrice.toFixed(3)} | ${buyReason} | R:R ${rr}:1`
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
      
      // FIX 4: Apply LONG discount if consecutive Down wins
      let dollars = this.BUY_SIZE_DOLLARS;
      if (signal.applyLongDiscount) {
        dollars = Math.max(1, Math.floor(dollars * this.LONG_DISCOUNT));
        console.log(`[DipArb2] ⚠ LONG discount: $${dollars} (${this.consecutiveDownWins} consecutive Down wins)`);
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
        console.log("[DipArb2] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[DipArb2] ✅ Order: ${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

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
        console.log(`[DipArb2] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) | ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) | Pairs: ${pairs} | PairCost: ${pairCost ? '$' + pairCost.toFixed(3) : 'N/A'} | Spent: $${totalSpent.toFixed(2)}`);
        
        // Check if profit is now locked
        if (pairs > 0 && pairs * 1.0 > totalSpent) {
          window.locked = true;
          console.log(`[DipArb2] 🔒 PROFIT LOCKED after this buy! +$${(pairs - totalSpent).toFixed(2)} guaranteed`);
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
        bullScore: 0, bearScore: 0,
        signals: signal.signals || [],
        strategy: signal.strategy || "DIPARB2"
      });

      return {
        success: true, trade, order,
        reason: `${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(2)} ($${maxCost.toFixed(2)})`
      };

    } catch (error) {
      return { success: false, reason: `Trade failed: ${error.message}`, error };
    }
  }

  // Called when a position resolves — track consecutive Down wins for FIX 4
  recordResolution(outcome, won) {
    if (outcome === "Down" && won) {
      this.consecutiveDownWins++;
    } else if (outcome === "Up" && won) {
      this.consecutiveDownWins = 0; // Reset on Up win
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
      consecutiveDownWins: this.consecutiveDownWins
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
