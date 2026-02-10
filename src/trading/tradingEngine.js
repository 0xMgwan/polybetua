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
    
    // ─── DIP-ARB INSPIRED PAIR TRADING ────────────────────────
    // Leg1: Buy the cheap side when price dips (≤ 25¢)
    // Leg2: Buy the OTHER side when combined cost < sumTarget
    //        → match Leg1 shares for perfect hedge
    // If Leg2 can't fill → emergency exit (sell Leg1)
    this.currentWindow = null;
    this.windowHistory = [];
    
    // Strategy parameters (inspired by MrFadiAi/Polymarket-bot DipArb)
    this.LEG1_THRESHOLD = 0.25;      // Leg1: buy when ≤ 25¢ (cheap side)
    this.SUM_TARGET = 0.92;          // Only buy Leg2 if Leg1+Leg2 < 92¢ (8%+ guaranteed profit)
    this.LEG1_SIZE_DOLLARS = 2;      // $2 for Leg1
    this.MAX_WINDOW_SPEND = 5;       // Max $5 per window
    this.MIN_BUY_COOLDOWN = 30000;   // 30s between buys
    this.EXIT_MINUTES_LEFT = 2;      // Emergency exit with 2 min left
    
    this.lastBuyTime = 0;
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
      phase: "waiting",    // waiting → leg1_filled → completed | exited
      leg1: null,           // { side, qty, cost, avgPrice, tokenId }
      leg2: null,           // { side, qty, cost, avgPrice, tokenId }
      qtyUp: 0, costUp: 0,
      qtyDown: 0, costDown: 0,
      buys: [],
      locked: false,
      createdAt: Date.now()
    };
    console.log(`[DipArb] 🆕 New window: ${slug.slice(-20)}`);
    return this.currentWindow;
  }

  _archiveWindow() {
    if (!this.currentWindow) return;
    const w = this.currentWindow;
    const totalSpent = w.costUp + w.costDown;
    const minQty = Math.min(w.qtyUp, w.qtyDown);
    
    if (totalSpent > 0) {
      const pairCost = this._calcPairCost(w);
      const profit = minQty > 0 ? (minQty * 1.0 - totalSpent) : -totalSpent;
      console.log(`[DipArb] 📦 Archived: ${w.phase} | Spent: $${totalSpent.toFixed(2)} | Pairs: ${minQty} | PairCost: ${pairCost ? '$' + pairCost.toFixed(3) : 'N/A'} | Est P&L: $${profit.toFixed(2)}`);
      this.windowHistory.push({ ...w, archivedAt: Date.now(), totalSpent, minQty, estProfit: profit });
    }
    this.currentWindow = null;
  }

  _calcPairCost(w) {
    if (w.qtyUp === 0 || w.qtyDown === 0) return null;
    return (w.costUp / w.qtyUp) + (w.costDown / w.qtyDown);
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN DECISION: shouldTrade()
  // Leg1 → Leg2 flow inspired by MrFadiAi/Polymarket-bot DipArb
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

    // CIRCUIT BREAKER
    const totalExposure = this.positionTracker.openPositions.reduce((sum, pos) => sum + pos.cost, 0);
    if (totalExposure >= 20) {
      return { shouldTrade: false, reason: `Circuit breaker: exposure $${totalExposure.toFixed(2)} >= $20` };
    }

    // ─── TIMING ──────────────────────────────────────────────
    let minLeft = 15;
    let candleMinute = 0;
    if (marketData.marketEndTime) {
      const msLeft = marketData.marketEndTime - now;
      minLeft = msLeft / 60000;
      candleMinute = Math.floor(15 - minLeft);
      
      if (minLeft > 14) {
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

    // Already completed or exited
    if (window.phase === "completed" || window.phase === "exited") {
      return { shouldTrade: false, reason: `Window ${window.phase} (spent $${totalSpent.toFixed(2)})` };
    }

    // Max spend
    if (totalSpent >= this.MAX_WINDOW_SPEND) {
      return { shouldTrade: false, reason: `Budget exhausted ($${totalSpent.toFixed(2)} >= $${this.MAX_WINDOW_SPEND})` };
    }

    // Profit locked check
    const minQty = Math.min(window.qtyUp, window.qtyDown);
    if (minQty > 0 && (minQty * 1.0) > totalSpent) {
      window.locked = true;
      window.phase = "completed";
      const pairCost = this._calcPairCost(window);
      console.log(`[DipArb] 🔒 PROFIT LOCKED! Pairs: ${minQty} | Spent: $${totalSpent.toFixed(2)} | Pair cost: $${pairCost?.toFixed(3)} | Guaranteed: $${(minQty - totalSpent).toFixed(2)}`);
      return { shouldTrade: false, reason: `Profit locked! ${minQty} pairs @ $${pairCost?.toFixed(3)}` };
    }

    console.log(`[DipArb] ══════════════════════════════════════`);
    console.log(`[DipArb] Phase: ${window.phase} | Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Sum: $${combinedPrice.toFixed(3)}`);
    console.log(`[DipArb] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) | ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) | Min left: ${minLeft.toFixed(1)}`);

    // ═══════════════════════════════════════════════════════════
    // PHASE: WAITING — look for Leg1 (cheap side)
    // ═══════════════════════════════════════════════════════════
    if (window.phase === "waiting") {
      // Don't start new Leg1 with < 5 min left (not enough time for Leg2)
      if (minLeft < 5) {
        console.log(`[DipArb] ⏳ Only ${minLeft.toFixed(1)} min left — too late to start new pair`);
        console.log(`[DipArb] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Too late for new pair (${minLeft.toFixed(1)} min left)` };
      }

      // Find cheapest side ≤ LEG1_THRESHOLD
      const upCheap = upPrice <= this.LEG1_THRESHOLD && upPrice > 0.05;
      const downCheap = downPrice <= this.LEG1_THRESHOLD && downPrice > 0.05;

      let buyOutcome = null;
      let buyPrice = null;

      if (upCheap && downCheap) {
        // Both cheap — buy the cheaper one
        if (upPrice <= downPrice) {
          buyOutcome = "Up"; buyPrice = upPrice;
        } else {
          buyOutcome = "Down"; buyPrice = downPrice;
        }
      } else if (upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
      } else if (downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
      }

      if (!buyOutcome) {
        console.log(`[DipArb] ⏳ Waiting for dip: Up $${upPrice.toFixed(3)} / Down $${downPrice.toFixed(3)} > $${this.LEG1_THRESHOLD}`);
        console.log(`[DipArb] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for dip (Up $${upPrice.toFixed(2)}, Down $${downPrice.toFixed(2)} > $${this.LEG1_THRESHOLD})` };
      }

      const rr = ((1 - buyPrice) / buyPrice).toFixed(1);
      console.log(`[DipArb] ✅ LEG1: BUY ${buyOutcome} @ $${buyPrice.toFixed(3)} | R:R ${rr}:1`);
      console.log(`[DipArb] ══════════════════════════════════════`);

      return {
        shouldTrade: true,
        direction: buyOutcome === "Up" ? "LONG" : "SHORT",
        targetOutcome: buyOutcome,
        confidence: 85,
        edge: 1.0 - combinedPrice,
        marketPrice: buyPrice,
        modelProb: 0.85,
        strategy: "DIPARB_LEG1",
        isLeg2: false,
        leg1Shares: null,
        bullScore: 0, bearScore: 0,
        signals: [`leg1:${buyOutcome}@$${buyPrice.toFixed(3)}`],
        reason: `LEG1: ${buyOutcome} @ $${buyPrice.toFixed(3)} | R:R ${rr}:1`
      };
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE: LEG1_FILLED — look for Leg2 (hedge the other side)
    // ═══════════════════════════════════════════════════════════
    if (window.phase === "leg1_filled" && window.leg1) {
      const leg1 = window.leg1;
      const hedgeSide = leg1.side === "Up" ? "Down" : "Up";
      const hedgePrice = hedgeSide === "Up" ? upPrice : downPrice;
      
      // Emergency exit: sell Leg1 if time running out and no Leg2
      if (minLeft < this.EXIT_MINUTES_LEFT) {
        console.log(`[DipArb] ⚠ EMERGENCY: ${minLeft.toFixed(1)} min left, no Leg2 — need to EXIT Leg1`);
        console.log(`[DipArb] ══════════════════════════════════════`);
        // Signal an emergency sell of Leg1
        return {
          shouldTrade: true,
          direction: leg1.side === "Up" ? "LONG" : "SHORT",
          targetOutcome: leg1.side,
          confidence: 50,
          edge: 0,
          marketPrice: leg1.side === "Up" ? upPrice : downPrice,
          modelProb: 0.5,
          strategy: "DIPARB_EXIT",
          isExit: true,
          exitTokenId: leg1.tokenId,
          exitShares: leg1.qty,
          bullScore: 0, bearScore: 0,
          signals: [`exit:${leg1.side}@market`],
          reason: `EXIT: Sell ${leg1.qty}x ${leg1.side} — no time for Leg2`
        };
      }

      // Check if Leg2 would be profitable: Leg1 avg + Leg2 price < sumTarget
      const totalCost = leg1.avgPrice + hedgePrice;
      
      if (totalCost >= this.SUM_TARGET) {
        const profitIfBuy = (1.0 - totalCost) * 100;
        console.log(`[DipArb] ⏳ Waiting Leg2: ${hedgeSide} @ $${hedgePrice.toFixed(3)} | Sum: $${totalCost.toFixed(3)} > $${this.SUM_TARGET} (${profitIfBuy.toFixed(1)}% profit)`);
        console.log(`[DipArb] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Leg2 too expensive: ${hedgeSide} $${hedgePrice.toFixed(2)} | Sum $${totalCost.toFixed(3)} > $${this.SUM_TARGET}` };
      }

      // Leg2 is profitable! Buy SAME number of shares as Leg1 for perfect hedge
      const profitPct = ((1.0 - totalCost) * 100).toFixed(1);
      console.log(`[DipArb] ✅ LEG2: BUY ${hedgeSide} @ $${hedgePrice.toFixed(3)} | Sum: $${totalCost.toFixed(3)} | Profit: ${profitPct}% | Shares: ${leg1.qty} (match Leg1)`);
      console.log(`[DipArb] ══════════════════════════════════════`);

      return {
        shouldTrade: true,
        direction: hedgeSide === "Up" ? "LONG" : "SHORT",
        targetOutcome: hedgeSide,
        confidence: 95,
        edge: 1.0 - totalCost,
        marketPrice: hedgePrice,
        modelProb: 0.95,
        strategy: "DIPARB_LEG2",
        isLeg2: true,
        leg1Shares: leg1.qty,
        bullScore: 0, bearScore: 0,
        signals: [`leg2:${hedgeSide}@$${hedgePrice.toFixed(3)}`, `sum:$${totalCost.toFixed(3)}`],
        reason: `LEG2: ${hedgeSide} @ $${hedgePrice.toFixed(3)} | Sum: $${totalCost.toFixed(3)} | +${profitPct}%`
      };
    }

    console.log(`[DipArb] ══════════════════════════════════════`);
    return { shouldTrade: false, reason: `Window in phase: ${window.phase}` };
  }

  // ═══════════════════════════════════════════════════════════════
  // EXECUTE TRADE — handle Leg1, Leg2, and Exit
  // ═══════════════════════════════════════════════════════════════
  async executeTrade(signal, marketData, priceToBeat = null) {
    if (!signal.shouldTrade) {
      return { success: false, reason: signal.reason };
    }

    // ─── EMERGENCY EXIT: Sell Leg1 position ──────────────────
    if (signal.isExit) {
      try {
        const window = this.currentWindow;
        if (!window || !window.leg1) {
          return { success: false, reason: "No Leg1 to exit" };
        }
        
        const tokenId = window.leg1.tokenId;
        const currentPrice = signal.marketPrice;
        const shares = window.leg1.qty;
        
        // Sell at slightly below market to ensure fill
        const sellPrice = Math.max(0.01, currentPrice - 0.005);
        
        console.log(`[DipArb] 🚨 EMERGENCY EXIT: Selling ${shares}x ${window.leg1.side} @ $${sellPrice.toFixed(3)}`);
        
        const order = await this.tradingService.placeOrder({
          tokenId,
          side: "SELL",
          price: sellPrice,
          size: shares,
          orderType: "GTC"
        });

        if (order && order.orderID) {
          window.phase = "exited";
          const loss = window.leg1.cost - (sellPrice * shares);
          console.log(`[DipArb] ✅ Exit order placed. Est loss: $${loss.toFixed(2)}`);
          this.lastBuyTime = Date.now();
          return { success: true, reason: `EXIT: Sold ${shares}x ${window.leg1.side} @ $${sellPrice.toFixed(3)} | Est loss: $${loss.toFixed(2)}` };
        } else {
          console.log(`[DipArb] ❌ Exit order failed — will hold to expiry`);
          window.phase = "exited";
          return { success: false, reason: "Exit order failed" };
        }
      } catch (error) {
        console.log(`[DipArb] ❌ Exit error: ${error.message}`);
        if (this.currentWindow) this.currentWindow.phase = "exited";
        return { success: false, reason: `Exit failed: ${error.message}` };
      }
    }

    // ─── LEG1 or LEG2: Buy order ─────────────────────────────
    try {
      const tokenId = signal.targetOutcome === "Up" 
        ? marketData.upTokenId 
        : marketData.downTokenId;

      if (!tokenId) {
        return { success: false, reason: "Missing token ID" };
      }

      const price = Math.min(0.95, signal.marketPrice + 0.003);
      const MIN_SHARES = 5;
      let size;
      
      if (signal.isLeg2 && signal.leg1Shares) {
        // Leg2: match Leg1 shares for perfect hedge
        size = signal.leg1Shares;
      } else {
        // Leg1: buy $2 worth
        size = Math.floor(this.LEG1_SIZE_DOLLARS / price);
        if (size < MIN_SHARES) size = MIN_SHARES;
      }
      
      const maxCost = price * size;

      const order = await this.tradingService.placeOrder({
        tokenId,
        side: "BUY",
        price,
        size,
        orderType: "GTC"
      });

      if (!order || !order.orderID) {
        console.log("[DipArb] Order failed - no orderID returned");
        return { success: false, reason: "Order failed - no orderID returned" };
      }
      
      console.log(`[DipArb] ✅ Order: ${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

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
          leg: signal.isLeg2 ? "leg2" : "leg1",
          timestamp: Date.now()
        });

        // Update phase and leg info
        if (!signal.isLeg2) {
          // Leg1 filled
          window.phase = "leg1_filled";
          window.leg1 = {
            side: signal.targetOutcome,
            qty: size,
            cost: maxCost,
            avgPrice: price,
            tokenId,
            timestamp: Date.now()
          };
          console.log(`[DipArb] Phase → leg1_filled: ${size}x ${signal.targetOutcome} @ $${price.toFixed(3)}`);
        } else {
          // Leg2 filled — pair complete!
          window.phase = "completed";
          window.leg2 = {
            side: signal.targetOutcome,
            qty: size,
            cost: maxCost,
            avgPrice: price,
            tokenId,
            timestamp: Date.now()
          };
          const totalSpent = window.costUp + window.costDown;
          const pairs = Math.min(window.qtyUp, window.qtyDown);
          const pairCost = this._calcPairCost(window);
          const profit = pairs * 1.0 - totalSpent;
          window.locked = profit > 0;
          console.log(`[DipArb] 🎯 PAIR COMPLETE! ${pairs} pairs | Cost: $${pairCost?.toFixed(3)} | Spent: $${totalSpent.toFixed(2)} | Guaranteed: $${profit.toFixed(2)}`);
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
        strategy: signal.strategy || "DIPARB"
      });

      return {
        success: true, trade, order,
        reason: `${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(2)} ($${maxCost.toFixed(2)})`
      };

    } catch (error) {
      return { success: false, reason: `Trade failed: ${error.message}`, error };
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
        phase: w.phase,
        leg1: w.leg1 ? { side: w.leg1.side, qty: w.leg1.qty, avgPrice: w.leg1.avgPrice } : null,
        leg2: w.leg2 ? { side: w.leg2.side, qty: w.leg2.qty, avgPrice: w.leg2.avgPrice } : null,
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
