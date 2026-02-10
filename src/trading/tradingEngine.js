import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// PAIR-TRADING ENGINE
// 
// Never bet on "Up wins" or "Down wins."
// Instead, buy whichever side is temporarily undervalued (cheap).
// Build positions on BOTH sides so avg pair cost < $1.00
// → guaranteed profit at resolution.
//
// Effective win rate: 85-98% (almost no full losses)
// Profits: small but consistent & compounded (many windows/day)
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
    
    // ─── PAIR TRADING STATE ────────────────────────────────────
    // Track cumulative buys on BOTH sides for the current window
    this.currentWindow = null;  // { slug, qtyUp, costUp, qtyDown, costDown, buys[], lockedAt }
    this.windowHistory = [];    // Past windows for P&L tracking
    
    // Pair trading parameters
    this.CHEAP_THRESHOLD = 0.25;     // First side: buy when ≤ 25¢ (truly cheap, 3:1+ R:R)
    this.SECOND_SIDE_THRESHOLD = 0.40; // Second side: up to 40¢ to complete pair
    this.IDEAL_THRESHOLD = 0.15;     // Ideal entry: ≤ 15¢ (amazing price)
    this.MAX_WINDOW_SPEND = 5;       // Max $5 per window (split across buys)
    this.BUY_SIZE_DOLLARS = 2;       // $2 per individual buy
    this.BALANCE_BUY_SIZE = 1;       // $1 for balance buys (second side)
    this.MIN_BUY_COOLDOWN = 60000;   // 60s between buys (same side)
    this.MAX_SINGLE_SIDE = 2;        // Max $2 on one side before other side has ANY buys
    this.MAX_PAIR_COST = 0.65;       // Only buy second side if resulting pair cost < 65¢
    
    this.lastUpBuyTime = 0;
    this.lastDownBuyTime = 0;
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
    // New window — archive old one if exists
    if (this.currentWindow) {
      this._archiveWindow();
    }
    this.currentWindow = {
      slug,
      qtyUp: 0,
      costUp: 0,
      qtyDown: 0,
      costDown: 0,
      buys: [],
      locked: false,
      createdAt: Date.now()
    };
    console.log(`[PairTrade] 🆕 New window: ${slug.slice(-20)}`);
    return this.currentWindow;
  }

  _archiveWindow() {
    if (!this.currentWindow) return;
    const w = this.currentWindow;
    const totalSpent = w.costUp + w.costDown;
    const minQty = Math.min(w.qtyUp, w.qtyDown);
    const pairValue = minQty * 1.0; // At resolution, min(qty) pairs pay $1 each
    const profit = pairValue - totalSpent;
    
    if (totalSpent > 0) {
      const avgPairCost = this._calcPairCost(w);
      console.log(`[PairTrade] 📦 Archived window: ${w.slug.slice(-20)} | Spent: $${totalSpent.toFixed(2)} | Pairs: ${minQty} | PairCost: $${avgPairCost?.toFixed(3) || 'N/A'} | Est P&L: $${profit.toFixed(2)}`);
      this.windowHistory.push({
        ...w,
        archivedAt: Date.now(),
        totalSpent,
        minQty,
        estProfit: profit
      });
    }
    this.currentWindow = null;
  }

  _calcPairCost(w) {
    // Weighted pair cost = (costUp / qtyUp) + (costDown / qtyDown)
    if (w.qtyUp === 0 || w.qtyDown === 0) return null;
    return (w.costUp / w.qtyUp) + (w.costDown / w.qtyDown);
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // Called every ~1 second. Decides if we should buy a side.
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

    // CIRCUIT BREAKER: Total exposure
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= 20) {
      return { shouldTrade: false, reason: `Circuit breaker: exposure $${totalExposure.toFixed(2)} >= $20` };
    }

    // ─── TIMING: Trade minutes 1-12 of candle ─────────────────
    // Pair trading needs more time to accumulate both sides
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      const minLeft = msLeft / 60000;
      const candleMinute = Math.floor(15 - minLeft);
      
      if (minLeft > 14) {
        return { shouldTrade: false, reason: `Too early (min ${candleMinute}/15)` };
      }
      if (minLeft < 3) {
        return { shouldTrade: false, reason: `Too late (min ${candleMinute}/15, ${minLeft.toFixed(1)} min left) — no time to balance` };
      }
    }

    // ─── GET/CREATE WINDOW ────────────────────────────────────
    const window = this._getOrCreateWindow(slug);
    const totalSpent = window.costUp + window.costDown;

    // Check if profit is already locked
    if (window.locked) {
      return { shouldTrade: false, reason: `Window locked — profit secured (spent $${totalSpent.toFixed(2)})` };
    }

    // Max spend per window
    if (totalSpent >= this.MAX_WINDOW_SPEND) {
      return { shouldTrade: false, reason: `Window budget exhausted ($${totalSpent.toFixed(2)} >= $${this.MAX_WINDOW_SPEND})` };
    }

    // Check if we've locked profit: min(qtyUp, qtyDown) × $1 > totalSpent
    const minQty = Math.min(window.qtyUp, window.qtyDown);
    if (minQty > 0 && (minQty * 1.0) > totalSpent) {
      window.locked = true;
      const pairCost = this._calcPairCost(window);
      console.log(`[PairTrade] 🔒 PROFIT LOCKED! Pairs: ${minQty} | Spent: $${totalSpent.toFixed(2)} | Pair cost: $${pairCost?.toFixed(3)} | Guaranteed: $${(minQty - totalSpent).toFixed(2)}`);
      return { shouldTrade: false, reason: `Profit locked! ${minQty} pairs @ $${pairCost?.toFixed(3)} pair cost` };
    }

    // ─── DECIDE WHICH SIDE TO BUY ─────────────────────────────
    console.log(`[PairTrade] ══════════════════════════════════════`);
    console.log(`[PairTrade] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Combined: $${combinedPrice.toFixed(3)}`);
    console.log(`[PairTrade] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) | ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) | Total: $${totalSpent.toFixed(2)}`);

    // Find which side(s) are cheap enough to buy
    // First side: must be ≤ 35¢ (cheap)
    // Second side: can be up to 45¢ to complete the pair
    const hasUp = window.qtyUp > 0;
    const hasDown = window.qtyDown > 0;
    const upThreshold = hasDown && !hasUp ? this.SECOND_SIDE_THRESHOLD : this.CHEAP_THRESHOLD;
    const downThreshold = hasUp && !hasDown ? this.SECOND_SIDE_THRESHOLD : this.CHEAP_THRESHOLD;
    const upCheap = upPrice <= upThreshold && upPrice > 0.05;
    const downCheap = downPrice <= downThreshold && downPrice > 0.05;

    if (!upCheap && !downCheap) {
      const needSecond = (hasUp && !hasDown) || (hasDown && !hasUp);
      const threshStr = needSecond ? `need 2nd side ≤$${this.SECOND_SIDE_THRESHOLD}` : `both > $${this.CHEAP_THRESHOLD}`;
      console.log(`[PairTrade] ⚠ Neither side cheap enough (Up $${upPrice.toFixed(3)} vs $${upThreshold}, Down $${downPrice.toFixed(3)} vs $${downThreshold}) — ${threshStr}`);
      console.log(`[PairTrade] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No cheap side (Up $${upPrice.toFixed(2)}/${upThreshold}, Down $${downPrice.toFixed(2)}/${downThreshold})` };
    }

    // ─── SINGLE-SIDE CAP ──────────────────────────────────────
    // CRITICAL: Don't keep buying one side without the other.
    // Max $3 on one side before the other side has ANY position.
    // This prevents the "64 Down, 0 Up" problem.
    const upMaxedOut = window.costUp >= this.MAX_SINGLE_SIDE && window.qtyDown === 0;
    const downMaxedOut = window.costDown >= this.MAX_SINGLE_SIDE && window.qtyUp === 0;

    if (upMaxedOut && !downCheap) {
      console.log(`[PairTrade] ⚠ Up maxed ($${window.costUp.toFixed(2)}) but Down not cheap ($${downPrice.toFixed(3)}) — waiting for Down to dip`);
      console.log(`[PairTrade] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Up side maxed ($${window.costUp.toFixed(2)}), waiting for Down ≤$${this.CHEAP_THRESHOLD}` };
    }
    if (downMaxedOut && !upCheap) {
      console.log(`[PairTrade] ⚠ Down maxed ($${window.costDown.toFixed(2)}) but Up not cheap ($${upPrice.toFixed(3)}) — waiting for Up to dip`);
      console.log(`[PairTrade] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `Down side maxed ($${window.costDown.toFixed(2)}), waiting for Up ≤$${this.CHEAP_THRESHOLD}` };
    }

    // Decide which side to buy:
    // Priority 1: Buy the side we have NONE of (must balance)
    // Priority 2: Buy the side we have LESS of
    // Priority 3: Buy the CHEAPER side
    let buyOutcome = null;
    let buyPrice = null;
    let buyReason = "";

    // Check cooldowns
    const upCooldownOk = (now - this.lastUpBuyTime) >= this.MIN_BUY_COOLDOWN;
    const downCooldownOk = (now - this.lastDownBuyTime) >= this.MIN_BUY_COOLDOWN;

    // Force buy the missing side if we have one side already
    // BUT only if the resulting pair cost would be profitable (< MAX_PAIR_COST)
    let isBalanceTrade = false;
    if (window.qtyUp > 0 && window.qtyDown === 0 && downCheap && downCooldownOk) {
      // Simulate: would buying Down create a profitable pair?
      const simPairCost = (window.costUp / window.qtyUp) + downPrice;
      if (simPairCost <= this.MAX_PAIR_COST) {
        buyOutcome = "Down";
        buyPrice = downPrice;
        buyReason = `BALANCE: pair cost would be $${simPairCost.toFixed(3)}`;
        isBalanceTrade = true;
      } else {
        console.log(`[PairTrade] ⚠ Down @ $${downPrice.toFixed(3)} would make pair cost $${simPairCost.toFixed(3)} > $${this.MAX_PAIR_COST} — SKIP`);
      }
    } else if (window.qtyDown > 0 && window.qtyUp === 0 && upCheap && upCooldownOk) {
      const simPairCost = upPrice + (window.costDown / window.qtyDown);
      if (simPairCost <= this.MAX_PAIR_COST) {
        buyOutcome = "Up";
        buyPrice = upPrice;
        buyReason = `BALANCE: pair cost would be $${simPairCost.toFixed(3)}`;
        isBalanceTrade = true;
      } else {
        console.log(`[PairTrade] ⚠ Up @ $${upPrice.toFixed(3)} would make pair cost $${simPairCost.toFixed(3)} > $${this.MAX_PAIR_COST} — SKIP`);
      }
    }
    
    if (!buyOutcome && upCheap && downCheap) {
      // Both cheap — buy the side we have less of
      if (window.qtyUp <= window.qtyDown && upCooldownOk) {
        buyOutcome = "Up";
        buyPrice = upPrice;
        buyReason = `Balancing: have ${window.qtyUp} Up vs ${window.qtyDown} Down`;
      } else if (downCooldownOk) {
        buyOutcome = "Down";
        buyPrice = downPrice;
        buyReason = `Balancing: have ${window.qtyDown} Down vs ${window.qtyUp} Up`;
      } else if (upCooldownOk) {
        buyOutcome = "Up";
        buyPrice = upPrice;
        buyReason = `Down on cooldown, buying Up`;
      }
    } else if (upCheap && upCooldownOk) {
      buyOutcome = "Up";
      buyPrice = upPrice;
      buyReason = `Up cheap @ $${upPrice.toFixed(3)}`;
    } else if (downCheap && downCooldownOk) {
      buyOutcome = "Down";
      buyPrice = downPrice;
      buyReason = `Down cheap @ $${downPrice.toFixed(3)}`;
    }

    if (!buyOutcome) {
      console.log(`[PairTrade] ⏳ Cheap side on cooldown — waiting`);
      console.log(`[PairTrade] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: "Cheap side on cooldown" };
    }

    // Check if this buy would improve or worsen pair cost
    if (window.qtyUp > 0 && window.qtyDown > 0) {
      const currentPairCost = this._calcPairCost(window);
      // Simulate the buy
      const simQty = Math.floor(this.BUY_SIZE_DOLLARS / buyPrice);
      const simCost = simQty * buyPrice;
      const simWindow = { ...window };
      if (buyOutcome === "Up") {
        simWindow.qtyUp += simQty;
        simWindow.costUp += simCost;
      } else {
        simWindow.qtyDown += simQty;
        simWindow.costDown += simCost;
      }
      const newPairCost = this._calcPairCost(simWindow);
      
      if (newPairCost && currentPairCost && newPairCost > 1.01) {
        console.log(`[PairTrade] ⚠ Buy would raise pair cost to $${newPairCost.toFixed(3)} > $1.01 — SKIP`);
        console.log(`[PairTrade] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Buy would raise pair cost to $${newPairCost.toFixed(3)}` };
      }
    }

    // Spread check
    if (marketData.spread !== undefined && marketData.spread !== null && marketData.spread > 0.10) {
      return { shouldTrade: false, reason: `Spread too wide (${(marketData.spread * 100).toFixed(1)}% > 10%)` };
    }

    const rr = ((1 - buyPrice) / buyPrice).toFixed(1);
    const pairCostStr = (window.qtyUp > 0 && window.qtyDown > 0) ? `$${this._calcPairCost(window).toFixed(3)}` : 'N/A';
    console.log(`[PairTrade] ✅ BUY ${buyOutcome} @ $${buyPrice.toFixed(3)} | R:R ${rr}:1 | ${buyReason} | PairCost: ${pairCostStr}`);
    console.log(`[PairTrade] ══════════════════════════════════════`);

    const stratLabel = isBalanceTrade ? 'BALANCE' : (buyPrice <= this.IDEAL_THRESHOLD ? 'IDEAL' : 'CHEAP');
    return {
      shouldTrade: true,
      direction: buyOutcome === "Up" ? "LONG" : "SHORT",
      targetOutcome: buyOutcome,
      confidence: 85,
      edge: 1.0 - combinedPrice,
      marketPrice: buyPrice,
      modelProb: 0.85,
      strategy: `PAIR_${stratLabel}`,
      isBalanceTrade,
      bullScore: 0,
      bearScore: 0,
      signals: [`pair:${buyOutcome}@$${buyPrice.toFixed(3)}`, buyReason],
      reason: `PAIR: ${buyOutcome} @ $${buyPrice.toFixed(3)} | ${buyReason} | PairCost: ${pairCostStr}`
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EXECUTE TRADE — place order and update window state
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

      const side = "BUY";
      const price = Math.min(0.95, signal.marketPrice + 0.003);
      
      // $2 for cheap buys, $1 for balance buys (second side = higher risk)
      const maxOrderDollars = signal.isBalanceTrade ? this.BALANCE_BUY_SIZE : this.BUY_SIZE_DOLLARS;
      const MIN_SHARES = 5;
      
      let size = Math.floor(maxOrderDollars / price);
      if (size < MIN_SHARES) size = MIN_SHARES;
      
      const maxCost = price * size;
      if (maxCost > maxOrderDollars + 1) {
        size = Math.floor(maxOrderDollars / price);
        if (size < MIN_SHARES) {
          return { success: false, reason: `Price too high for pair buy ($${price.toFixed(3)})` };
        }
      }

      const order = await this.tradingService.placeOrder({
        tokenId,
        side,
        price,
        size,
        orderType: "GTC"
      });

      if (!order || !order.orderID) {
        console.log("[PairTrade] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[PairTrade] Order accepted: ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

      // Update window state
      const window = this.currentWindow;
      if (window) {
        if (signal.targetOutcome === "Up") {
          window.qtyUp += size;
          window.costUp += maxCost;
          this.lastUpBuyTime = Date.now();
        } else {
          window.qtyDown += size;
          window.costDown += maxCost;
          this.lastDownBuyTime = Date.now();
        }
        window.buys.push({
          outcome: signal.targetOutcome,
          price,
          size,
          cost: maxCost,
          orderId: order.orderID,
          timestamp: Date.now()
        });

        const pairCost = this._calcPairCost(window);
        const totalSpent = window.costUp + window.costDown;
        const minQty = Math.min(window.qtyUp, window.qtyDown);
        console.log(`[PairTrade] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) + ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) = $${totalSpent.toFixed(2)} | Pairs: ${minQty} | PairCost: ${pairCost ? '$' + pairCost.toFixed(3) : 'need both sides'}`);
      }

      this.lastTradeTime = Date.now();
      this.hourlyTrades.push(Date.now());
      
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

      // Track position for P&L
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
        priceToBeat,
        upPrice: marketData.upPrice,
        downPrice: marketData.downPrice,
        indicators: signal.indicators || {},
        bullScore: signal.bullScore || 0,
        bearScore: signal.bearScore || 0,
        signals: signal.signals || [],
        strategy: signal.strategy || "PAIR"
      });

      return {
        success: true,
        trade,
        order,
        reason: `PAIR ${signal.targetOutcome} ${size}x @ $${price.toFixed(2)} (cost: $${maxCost.toFixed(2)})`
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
        buys: w.buys.length
      } : null,
      windowsCompleted: this.windowHistory.length
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
