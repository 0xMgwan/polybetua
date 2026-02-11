import { PositionTracker } from "./positionTracker.js";

// ═══════════════════════════════════════════════════════════════
// DIP-ARB v3 — INSTITUTIONAL HEDGED PAIR TRADING
//
// Core: Buy BOTH sides cheap → pair cost < $1.00 → guaranteed profit.
// 
// v3 Fixes (from 1W/5L trade analysis — all losses were unhedged):
// 1. TIME-BASED HEDGE: After min 5, allow hedge up to 55¢ (stop waiting)
// 2. DYNAMIC THRESHOLD: Cheap threshold scales with time (35¢→40¢→45¢)
// 3. DIRECTIONAL FILTER: Don't buy cheap side if momentum is AGAINST it
// 4. SYMMETRIC BIAS: Block DOWN after Up wins (mirrors LONG block)
// 5. OVERREACTION FILTER: INITIAL only on real overreaction (>0.25% move)
// 6. PROFIT LOCK: Stop once min(up,down) × $1 > totalSpent
// 7. NO PILING: Max 1 unhedged buy, then wait for hedge
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
    
    // Entry thresholds — scale with time pressure
    this.CHEAP_THRESHOLD = 0.35;     // Base max price (min 2-3)
    this.CHEAP_THRESHOLD_MID = 0.40; // After min 4 (slightly relaxed)
    this.CHEAP_THRESHOLD_LATE = 0.45;// After min 6 (need to hedge)
    this.HEDGE_THRESHOLD = 0.55;     // Late hedge (min 5+, accept worse price to avoid full loss)
    this.MAX_OPPOSITE_FOR_ENTRY = 0.55; // CRITICAL: Don't enter INITIAL if opposite side > 55¢ (can't hedge)
    this.IDEAL_THRESHOLD = 0.25;     // Ideal entry (3:1+ R:R)
    this.MAX_PAIR_ASK = 0.985;       // Only enter if Up+Down ≤ 98.5¢ (edge exists)
    
    // Sizing
    this.BUY_SIZE_DOLLARS = 3;       // $3 per buy
    this.LATE_HEDGE_SIZE = 2;        // $2 for late hedges (smaller — worse price)
    this.MAX_WINDOW_SPEND = 8;       // Max $8 per window
    this.LONG_DISCOUNT = 0.7;        // Reduce LONG size to 70% after consecutive Down wins
    
    // Timing & cooldowns
    this.MIN_BUY_COOLDOWN = 45000;   // 45s between buys
    this.MIN_CANDLE_MINUTE = 2;      // Don't trade first 2 min
    this.SKIP_AFTER_MINUTE = 7;      // Don't start NEW positions after min 7
    this.LATE_HEDGE_MINUTE = 5;      // After this minute, allow late hedge at worse price
    
    // Directional / momentum filter
    this.MIN_BTC_MOVE_PCT = 0.15;    // Require ≥0.15% BTC move for any entry
    this.OVERREACTION_PCT = 0.25;    // Require ≥0.25% for INITIAL (real overreaction)
    
    // Tracking
    this.lastBuyTime = 0;
    this.consecutiveDownWins = 0;    // Track consecutive Down resolutions
    this.consecutiveUpWins = 0;      // Track consecutive Up resolutions (for SHORT bias)
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

    // ─── MOMENTUM & DIRECTION ──────────────────────────────
    const btcDelta3m = indicators.delta3m || 0;
    const btcDelta1m = indicators.delta1m || 0;
    const btcMovePct = Math.abs(btcDelta3m);
    const btcDirection = btcDelta3m > 0 ? "UP" : btcDelta3m < 0 ? "DOWN" : "FLAT";

    // Dynamic cheap threshold based on candle minute
    const effectiveCheap = candleMinute >= 6 ? this.CHEAP_THRESHOLD_LATE
                         : candleMinute >= 4 ? this.CHEAP_THRESHOLD_MID
                         : this.CHEAP_THRESHOLD;

    console.log(`[DipArb3] ══════════════════════════════════════`);
    console.log(`[DipArb3] Up: $${upPrice.toFixed(3)} | Down: $${downPrice.toFixed(3)} | Sum: $${combinedPrice.toFixed(3)} | Min ${candleMinute}/15`);
    console.log(`[DipArb3] Window: ${window.qtyUp} Up ($${window.costUp.toFixed(2)}) | ${window.qtyDown} Down ($${window.costDown.toFixed(2)}) | BTC Δ3m: ${(btcDelta3m * 100).toFixed(3)}% (${btcDirection})`);
    console.log(`[DipArb3] Threshold: $${effectiveCheap.toFixed(2)} | Streaks: ${this.consecutiveDownWins}D/${this.consecutiveUpWins}U`);

    // ─── PAIR ASK SUM CHECK ──────────────────────────────────
    if (combinedPrice > this.MAX_PAIR_ASK && window.buys.length === 0) {
      console.log(`[DipArb3] ⏳ No edge: sum $${combinedPrice.toFixed(3)} > $${this.MAX_PAIR_ASK}`);
      console.log(`[DipArb3] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No edge (sum $${combinedPrice.toFixed(3)} > $${this.MAX_PAIR_ASK})` };
    }

    // ─── DECIDE WHAT TO BUY ─────────────────────────────────
    let buyOutcome = null;
    let buyPrice = null;
    let buyReason = "";
    let isLateHedge = false;

    const hasUp = window.qtyUp > 0;
    const hasDown = window.qtyDown > 0;
    const upCheap = upPrice <= effectiveCheap && upPrice > 0.05;
    const downCheap = downPrice <= effectiveCheap && downPrice > 0.05;

    // ─── HEDGE LOGIC (have one side, need the other) ──────
    if (hasUp && !hasDown) {
      if (downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "HEDGE (need Down)";
      } else if (candleMinute >= this.LATE_HEDGE_MINUTE && downPrice <= this.HEDGE_THRESHOLD) {
        // TIME-BASED LATE HEDGE: accept worse price to avoid full loss
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = `LATE_HEDGE (min ${candleMinute}, Down $${downPrice.toFixed(3)} ≤$${this.HEDGE_THRESHOLD})`;
        isLateHedge = true;
      } else {
        console.log(`[DipArb3] ⏳ Have ${window.qtyUp} Up, waiting for Down ≤$${effectiveCheap.toFixed(2)} (currently $${downPrice.toFixed(3)})`);
        console.log(`[DipArb3] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for Down hedge (Down $${downPrice.toFixed(2)} > $${effectiveCheap.toFixed(2)})` };
      }
    } else if (hasDown && !hasUp) {
      if (upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "HEDGE (need Up)";
      } else if (candleMinute >= this.LATE_HEDGE_MINUTE && upPrice <= this.HEDGE_THRESHOLD) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = `LATE_HEDGE (min ${candleMinute}, Up $${upPrice.toFixed(3)} ≤$${this.HEDGE_THRESHOLD})`;
        isLateHedge = true;
      } else {
        console.log(`[DipArb3] ⏳ Have ${window.qtyDown} Down, waiting for Up ≤$${effectiveCheap.toFixed(2)} (currently $${upPrice.toFixed(3)})`);
        console.log(`[DipArb3] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Waiting for Up hedge (Up $${upPrice.toFixed(2)} > $${effectiveCheap.toFixed(2)})` };
      }
    } else if (hasUp && hasDown) {
      // Both sides exist — rebalance or grow
      if (window.qtyUp < window.qtyDown && upCheap) {
        buyOutcome = "Up"; buyPrice = upPrice;
        buyReason = "REBALANCE (Up qty low)";
      } else if (window.qtyDown < window.qtyUp && downCheap) {
        buyOutcome = "Down"; buyPrice = downPrice;
        buyReason = "REBALANCE (Down qty low)";
      }
      if (!buyOutcome && upCheap && downCheap) {
        if (window.qtyUp <= window.qtyDown) {
          buyOutcome = "Up"; buyPrice = upPrice;
        } else {
          buyOutcome = "Down"; buyPrice = downPrice;
        }
        buyReason = "GROW (balanced, both cheap)";
      }
    } else {
      // ─── NO POSITION: INITIAL BUY ────────────────────────
      if (candleMinute > this.SKIP_AFTER_MINUTE) {
        console.log(`[DipArb3] ⏳ Min ${candleMinute} > ${this.SKIP_AFTER_MINUTE} — too late to start`);
        console.log(`[DipArb3] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Too late for new position (min ${candleMinute})` };
      }

      // ═══ HEDGEABILITY GATE (most important filter) ═══════════
      // Data: ALL 3 unhedged losses had opposite side at 65-84¢.
      // If opposite side > 55¢, we CANNOT hedge → guaranteed directional bet → coin flip.
      // Institutional rule: NEVER enter a position you can't exit/hedge.
      const oppositeUp = upPrice;   // price of Up (opposite if we buy Down)
      const oppositeDown = downPrice; // price of Down (opposite if we buy Up)

      if (upCheap && oppositeDown > this.MAX_OPPOSITE_FOR_ENTRY) {
        console.log(`[DipArb3] ⛔ HEDGEABILITY: Up cheap ($${upPrice.toFixed(3)}) but Down $${downPrice.toFixed(3)} > $${this.MAX_OPPOSITE_FOR_ENTRY} — can't hedge`);
        console.log(`[DipArb3] ══════════════════════════════════════`);
        // Up is cheap but Down is too expensive to hedge → skip
        if (!downCheap) {
          return { shouldTrade: false, reason: `Can't hedge: Down $${downPrice.toFixed(2)} > $${this.MAX_OPPOSITE_FOR_ENTRY}` };
        }
      }
      if (downCheap && oppositeUp > this.MAX_OPPOSITE_FOR_ENTRY) {
        console.log(`[DipArb3] ⛔ HEDGEABILITY: Down cheap ($${downPrice.toFixed(3)}) but Up $${upPrice.toFixed(3)} > $${this.MAX_OPPOSITE_FOR_ENTRY} — can't hedge`);
        console.log(`[DipArb3] ══════════════════════════════════════`);
        // Down is cheap but Up is too expensive to hedge → skip
        if (!upCheap) {
          return { shouldTrade: false, reason: `Can't hedge: Up $${upPrice.toFixed(2)} > $${this.MAX_OPPOSITE_FOR_ENTRY}` };
        }
      }

      // OVERREACTION FILTER: Require real BTC move for INITIAL
      if (btcMovePct < this.OVERREACTION_PCT) {
        console.log(`[DipArb3] ⏳ Weak move: BTC Δ3m ${(btcMovePct * 100).toFixed(3)}% < ${(this.OVERREACTION_PCT * 100).toFixed(1)}% — need overreaction`);
        console.log(`[DipArb3] ══════════════════════════════════════`);
        return { shouldTrade: false, reason: `Weak move (${(btcMovePct * 100).toFixed(2)}% < ${(this.OVERREACTION_PCT * 100).toFixed(1)}%)` };
      }

      // DIRECTIONAL FILTER: Only buy cheap side if BTC momentum SUPPORTS it
      // Key insight: cheap side = market thinks it'll lose. Only buy if momentum says market is WRONG.
      if (upCheap && downCheap) {
        // Both cheap (rare & ideal) — buy the one momentum supports
        if (btcDirection === "UP") {
          buyOutcome = "Up"; buyPrice = upPrice;
        } else {
          buyOutcome = "Down"; buyPrice = downPrice;
        }
        buyReason = "INITIAL (both cheap, momentum pick)";
      } else if (upCheap && oppositeDown <= this.MAX_OPPOSITE_FOR_ENTRY) {
        // Up cheap AND Down is hedgeable
        if (btcDirection === "UP") {
          buyOutcome = "Up"; buyPrice = upPrice;
          buyReason = "INITIAL (Up cheap + BTC rising + hedgeable)";
        } else {
          console.log(`[DipArb3] ⛔ Up cheap ($${upPrice.toFixed(3)}) but BTC going ${btcDirection} — don't buy against momentum`);
          console.log(`[DipArb3] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Up cheap but BTC ${btcDirection} — skip` };
        }
      } else if (downCheap && oppositeUp <= this.MAX_OPPOSITE_FOR_ENTRY) {
        // Down cheap AND Up is hedgeable
        if (btcDirection === "DOWN") {
          buyOutcome = "Down"; buyPrice = downPrice;
          buyReason = "INITIAL (Down cheap + BTC falling + hedgeable)";
        } else {
          console.log(`[DipArb3] ⛔ Down cheap ($${downPrice.toFixed(3)}) but BTC going ${btcDirection} — don't buy against momentum`);
          console.log(`[DipArb3] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Down cheap but BTC ${btcDirection} — skip` };
        }
      }
    }

    if (!buyOutcome) {
      console.log(`[DipArb3] ⏳ No cheap side: Up $${upPrice.toFixed(3)} / Down $${downPrice.toFixed(3)} > $${effectiveCheap.toFixed(2)}`);
      console.log(`[DipArb3] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `No cheap side (Up $${upPrice.toFixed(2)}, Down $${downPrice.toFixed(2)})` };
    }

    // ─── SIMULATE PAIR COST BEFORE BUYING ────────────────────
    const tradeDollars = isLateHedge ? this.LATE_HEDGE_SIZE : this.BUY_SIZE_DOLLARS;
    if (window.buys.length > 0) {
      const simSize = Math.floor(tradeDollars / buyPrice);
      const simCost = buyPrice * simSize;
      const simUp = window.qtyUp + (buyOutcome === "Up" ? simSize : 0);
      const simDown = window.qtyDown + (buyOutcome === "Down" ? simSize : 0);
      const simCostUp = window.costUp + (buyOutcome === "Up" ? simCost : 0);
      const simCostDown = window.costDown + (buyOutcome === "Down" ? simCost : 0);
      
      if (simUp > 0 && simDown > 0) {
        const simPairCost = (simCostUp / simUp) + (simCostDown / simDown);
        const currentPairCost = this._calcPairCost(window);
        
        // For late hedges, allow pair cost up to $1.00 (break-even is better than full loss)
        const maxAllowedPairCost = isLateHedge ? 1.0 : 1.0;
        if (simPairCost >= maxAllowedPairCost) {
          console.log(`[DipArb3] ⚠ Simulated pair cost $${simPairCost.toFixed(3)} >= $${maxAllowedPairCost} — SKIP`);
          console.log(`[DipArb3] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Pair cost would be $${simPairCost.toFixed(3)} >= $${maxAllowedPairCost}` };
        }
        
        // For late hedges, don't check if it raises pair cost (it will — that's ok, better than full loss)
        if (!isLateHedge && currentPairCost && simPairCost > currentPairCost) {
          console.log(`[DipArb3] ⚠ Would raise pair cost $${currentPairCost.toFixed(3)} → $${simPairCost.toFixed(3)} — SKIP`);
          console.log(`[DipArb3] ══════════════════════════════════════`);
          return { shouldTrade: false, reason: `Would raise pair cost to $${simPairCost.toFixed(3)}` };
        }
        
        console.log(`[DipArb3] ✓ Sim pair cost: $${simPairCost.toFixed(3)} (${currentPairCost ? 'from $' + currentPairCost.toFixed(3) : 'new'})${isLateHedge ? ' [LATE HEDGE]' : ''}`);
      }
    }

    // Record starting pair cost for diagnostics
    if (window.buys.length === 0) {
      window.startPairCost = combinedPrice;
    }

    const rr = ((1 - buyPrice) / buyPrice).toFixed(1);
    const pairCostStr = this._calcPairCost(window)?.toFixed(3) || "N/A";
    console.log(`[DipArb3] ✅ BUY ${buyOutcome} @ $${buyPrice.toFixed(3)} | ${buyReason} | R:R ${rr}:1 | PairCost: $${pairCostStr}`);
    console.log(`[DipArb3] ══════════════════════════════════════`);

    // ─── SYMMETRIC BIAS BLOCKS ─────────────────────────────
    const isLong = buyOutcome === "Up";
    const isShort = buyOutcome === "Down";
    
    // Block LONG after 2+ consecutive Down wins (unless super cheap or hedge)
    if (isLong && !buyReason.includes("HEDGE") && this.consecutiveDownWins >= 2 && buyPrice > 0.28) {
      console.log(`[DipArb3] ⛔ LONG blocked: ${this.consecutiveDownWins} Down wins & Up $${buyPrice.toFixed(3)} > $0.28`);
      console.log(`[DipArb3] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `LONG blocked after ${this.consecutiveDownWins} Down wins` };
    }
    // Block SHORT after 2+ consecutive Up wins (unless super cheap or hedge)
    if (isShort && !buyReason.includes("HEDGE") && this.consecutiveUpWins >= 2 && buyPrice > 0.28) {
      console.log(`[DipArb3] ⛔ SHORT blocked: ${this.consecutiveUpWins} Up wins & Down $${buyPrice.toFixed(3)} > $0.28`);
      console.log(`[DipArb3] ══════════════════════════════════════`);
      return { shouldTrade: false, reason: `SHORT blocked after ${this.consecutiveUpWins} Up wins` };
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
      isLateHedge,
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
      
      // Apply sizing: late hedge gets smaller size, LONG discount if streak
      let dollars = signal.isLateHedge ? this.LATE_HEDGE_SIZE : this.BUY_SIZE_DOLLARS;
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
      
      console.log(`[DipArb3] ✅ Order: ${signal.strategy} ${signal.targetOutcome} ${size}x @ $${price.toFixed(3)} = $${maxCost.toFixed(2)}`);

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

  // Called when a position resolves — track streaks for bias blocks
  recordResolution(outcome, won) {
    if (outcome === "Down" && won) {
      this.consecutiveDownWins++;
      this.consecutiveUpWins = 0;
    } else if (outcome === "Up" && won) {
      this.consecutiveUpWins++;
      this.consecutiveDownWins = 0;
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
