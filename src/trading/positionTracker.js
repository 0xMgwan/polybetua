import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "logs");
const PNL_FILE = path.join(LOG_DIR, "pnl.json");
const CSV_FILE = path.join(LOG_DIR, "trades.csv");
const JOURNAL_FILE = path.join(LOG_DIR, "journal.json");

export class PositionTracker {
  constructor() {
    this.openPositions = [];   // Currently open (waiting for resolution)
    this.closedPositions = []; // Resolved positions with P&L
    this.totalPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.totalCost = 0;
    this.totalReturn = 0;
    this.recentOutcomes = [];  // Track last N outcomes for streak analysis
    this.pausedAt = null;      // When trading was paused (3+ losses)
    this.pauseReason = null;   // Why trading was paused
    
    // Reset P&L if requested (set RESET_PNL=true to start fresh)
    if (process.env.RESET_PNL === "true") {
      console.log("[Tracker] ⚠ RESET_PNL=true — wiping old P&L data, starting fresh");
      this._saveState(); // Save clean state
    } else {
      // Load saved P&L data
      this._loadState();
    }
    this._ensureCsvHeader();
  }

  // Record a new position when an order is placed
  addPosition({ orderId, direction, outcome, price, size, confidence, edge, marketSlug, marketEndTime, priceToBeat, upPrice, downPrice, indicators, bullScore, bearScore, signals, strategy, assetName }) {
    const position = {
      orderId,
      direction,       // "LONG" or "SHORT"
      outcome,         // "Up" or "Down"
      entryPrice: price,
      size,
      cost: price * size,
      confidence,
      edge,
      marketSlug,
      marketEndTime,   // When the 15m market resolves
      priceToBeat,     // Market opening price - used to determine win/loss
      upPrice: upPrice || null,
      downPrice: downPrice || null,
      indicators: indicators || {},
      bullScore: bullScore || 0,
      bearScore: bearScore || 0,
      signals: signals || [],
      strategy: strategy || "UNKNOWN",
      assetName: assetName || "BTC",  // Track which asset this position is for
      openedAt: Date.now(),
      status: "OPEN",  // OPEN -> RESOLVED_WIN / RESOLVED_LOSS
      pnl: null,
      returnAmount: null
    };

    this.openPositions.push(position);
    this.totalCost += position.cost;
    
    console.log(`[Tracker] Position opened: ${direction} ${outcome} | ${size} shares @ $${price.toFixed(3)} | Cost: $${position.cost.toFixed(2)} | Edge: ${(edge * 100).toFixed(1)}%`);
    this._saveState();
    
    return position;
  }

  // Check if any open positions should be resolved based on market end time
  // assetName filter ensures we only resolve positions for the given asset
  // using that asset's own spot price (not BTC price for XRP positions, etc.)
  checkResolutions(currentPrice, priceToBeat, assetName = null) {
    const now = Date.now();
    const resolved = [];

    for (let i = this.openPositions.length - 1; i >= 0; i--) {
      const pos = this.openPositions[i];
      
      // Only resolve positions matching the specified asset (if provided)
      // This prevents resolving XRP positions with BTC's price, etc.
      if (assetName && pos.assetName && pos.assetName !== assetName) {
        continue;
      }

      // Check if market has ended (15m candle closed)
      if (pos.marketEndTime && now >= pos.marketEndTime) {
        // Determine outcome
        let won = false;
        
        // Use stored priceToBeat from position, fall back to passed parameter
        const ptb = pos.priceToBeat !== null && pos.priceToBeat !== undefined ? pos.priceToBeat : priceToBeat;
        
        if (ptb !== null && currentPrice !== null) {
          const priceWentUp = currentPrice > ptb;
          const priceWentDown = currentPrice <= ptb;
          
          if (pos.outcome === "Up" && priceWentUp) won = true;
          if (pos.outcome === "Down" && priceWentDown) won = true;
        } else {
          // Can't determine - mark as unknown, assume loss for safety
          won = false;
        }

        // Calculate P&L
        if (won) {
          // Winning position: each share pays $1
          pos.returnAmount = pos.size * 1.0;
          pos.pnl = pos.returnAmount - pos.cost;
          pos.status = "RESOLVED_WIN";
          this.wins++;
        } else {
          // Losing position: shares worth $0
          pos.returnAmount = 0;
          pos.pnl = -pos.cost;
          pos.status = "RESOLVED_LOSS";
          this.losses++;
        }

        this.totalPnl += pos.pnl;
        this.totalReturn += pos.returnAmount;
        pos.resolvedAt = now;
        pos.resolvedPrice = currentPrice;
        pos.resolvedPriceToBeat = priceToBeat;

        this.closedPositions.push(pos);
        this.openPositions.splice(i, 1);
        resolved.push(pos);

        const emoji = won ? "✅" : "❌";
        const assetTag = pos.assetName ? `[${pos.assetName}]` : "";
        console.log(`[Tracker] ${emoji} ${assetTag} Position resolved: ${pos.direction} ${pos.outcome} | P&L: $${pos.pnl.toFixed(2)} | Total P&L: $${this.totalPnl.toFixed(2)}`);
        
        // Track outcomes for streak analysis
        this.recentOutcomes.push(won ? "W" : "L");
        if (this.recentOutcomes.length > 20) this.recentOutcomes.shift();
        
        // Enhanced analysis for ALL trades (wins and losses)
        this._enhancedTradeAnalysis(pos, currentPrice, won);
      }
    }

    if (resolved.length > 0) {
      this._saveState();
    }

    return resolved;
  }

  // Force-resolve old positions that are past their market end time
  // (in case we missed the resolution window)
  cleanupStalePositions() {
    const now = Date.now();
    const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes past end time
    
    for (let i = this.openPositions.length - 1; i >= 0; i--) {
      const pos = this.openPositions[i];
      if (pos.marketEndTime && now - pos.marketEndTime > STALE_THRESHOLD) {
        // Assume loss for stale positions we couldn't resolve
        pos.returnAmount = 0;
        pos.pnl = -pos.cost;
        pos.status = "RESOLVED_STALE";
        pos.resolvedAt = now;
        this.losses++;
        this.totalPnl += pos.pnl;
        
        this.closedPositions.push(pos);
        this.openPositions.splice(i, 1);
        
        console.log(`[Tracker] ⚠ Stale position resolved as loss: ${pos.direction} ${pos.outcome} | P&L: $${pos.pnl.toFixed(2)}`);
      }
    }
    
    this._saveState();
  }

  // Check if any open positions should be stopped out (20% loss)
  checkStopLoss(currentMarketPrices) {
    const STOP_LOSS_THRESHOLD = 0.20; // 20% loss triggers stop
    const stoppedOut = [];

    for (const pos of this.openPositions) {
      // Get current market price for this position's outcome
      const currentPrice = pos.outcome === "Up" 
        ? currentMarketPrices?.upPrice 
        : currentMarketPrices?.downPrice;
      
      if (!currentPrice || currentPrice <= 0) continue;

      // Calculate unrealized loss
      const currentValue = currentPrice * pos.size;
      const unrealizedPnl = currentValue - pos.cost;
      const lossPercent = unrealizedPnl / pos.cost;

      // If we're down 20% or more, flag for stop-loss
      if (lossPercent <= -STOP_LOSS_THRESHOLD) {
        console.log(`[Stop-Loss] Position down ${(lossPercent * 100).toFixed(1)}% | ${pos.outcome} @ $${pos.entryPrice.toFixed(3)} → $${currentPrice.toFixed(3)}`);
        console.log(`[Stop-Loss] Would sell now to cut losses (current value: $${currentValue.toFixed(2)} vs cost: $${pos.cost.toFixed(2)})`);
        stoppedOut.push({
          position: pos,
          currentPrice,
          lossPercent,
          unrealizedPnl
        });
      }
    }

    return stoppedOut;
  }

  getStats() {
    const totalTrades = this.wins + this.losses;
    const winRate = totalTrades > 0 ? (this.wins / totalTrades * 100) : 0;
    const avgPnl = totalTrades > 0 ? this.totalPnl / totalTrades : 0;
    const roi = this.totalCost > 0 ? (this.totalPnl / this.totalCost * 100) : 0;
    
    // Recent performance (last 10 trades)
    const recent = this.closedPositions.slice(-10);
    const recentWins = recent.filter(p => p.status === "RESOLVED_WIN").length;
    const recentWinRate = recent.length > 0 ? (recentWins / recent.length * 100) : 0;
    const recentPnl = recent.reduce((sum, p) => sum + (p.pnl || 0), 0);

    // Streak tracking
    let currentStreak = 0;
    let streakType = null;
    for (let i = this.closedPositions.length - 1; i >= 0; i--) {
      const p = this.closedPositions[i];
      const isWin = p.status === "RESOLVED_WIN";
      if (streakType === null) {
        streakType = isWin ? "WIN" : "LOSS";
        currentStreak = 1;
      } else if ((isWin && streakType === "WIN") || (!isWin && streakType === "LOSS")) {
        currentStreak++;
      } else {
        break;
      }
    }

    return {
      openPositions: this.openPositions.length,
      totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate,
      totalPnl: this.totalPnl,
      totalCost: this.totalCost,
      totalReturn: this.totalReturn,
      avgPnl,
      roi,
      recentWinRate,
      recentPnl,
      currentStreak,
      streakType,
      positions: this.openPositions
    };
  }

  // Check if we should stop trading (circuit breaker) - SURVIVAL MODE
  shouldStopTrading() {
    const stats = this.getStats();
    const now = Date.now();
    const PAUSE_DURATION = 30 * 60 * 1000; // 30 minutes
    
    // ─── LOSS-STREAK PAUSE ───────────────────────────────────────
    // Pause for 30 min after 3+ consecutive losses
    // Resume early if a win breaks the streak
    if (stats.streakType === "LOSS" && stats.currentStreak >= 3) {
      // First time hitting 3 losses — start pause
      if (!this.pausedAt) {
        this.pausedAt = now;
        this.pauseReason = `${stats.currentStreak} consecutive losses`;
        console.log(`[Pause] ⏸ Trading paused: ${this.pauseReason} | Will resume in 30 min or on next WIN`);
        return { stop: true, reason: `${this.pauseReason} (paused, will resume in 30 min or on WIN)` };
      }
      
      // Already paused — check if 30 min has passed
      const pausedFor = now - this.pausedAt;
      if (pausedFor >= PAUSE_DURATION) {
        console.log(`[Pause] ▶ Auto-resuming after 30 min pause`);
        this.pausedAt = null;
        this.pauseReason = null;
        return { stop: false };
      }
      
      // Still within 30 min pause window
      const minLeft = Math.ceil((PAUSE_DURATION - pausedFor) / 60000);
      return { stop: true, reason: `Paused (${minLeft} min left) | ${this.pauseReason}` };
    }
    
    // ─── RESUME ON WIN ───────────────────────────────────────────
    // If we were paused but now have a win (streak broken), resume immediately
    if (this.pausedAt && (stats.streakType === "WIN" || stats.currentStreak === 1)) {
      console.log(`[Pause] ▶ Resuming early: WIN broke the loss streak!`);
      this.pausedAt = null;
      this.pauseReason = null;
      return { stop: false };
    }
    
    // ─── OTHER CIRCUIT BREAKERS ──────────────────────────────────
    // Stop if total P&L is worse than -$8 (16% of $50)
    if (stats.totalPnl < -8) {
      return { stop: true, reason: `P&L $${stats.totalPnl.toFixed(2)} hit max drawdown (-$8)` };
    }
    
    // Stop if win rate below 30% after 6+ trades
    if (stats.totalTrades >= 6 && stats.winRate < 30) {
      return { stop: true, reason: `Win rate ${stats.winRate.toFixed(0)}% too low after ${stats.totalTrades} trades` };
    }
    
    return { stop: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // ENHANCED TRADE ANALYSIS — learn from every trade
  // ═══════════════════════════════════════════════════════════════
  _enhancedTradeAnalysis(pos, resolvedPrice, won) {
    const ptb = pos.priceToBeat;
    const moveAbs = ptb && resolvedPrice ? Math.abs(resolvedPrice - ptb) : null;
    const movePct = ptb && resolvedPrice ? ((resolvedPrice - ptb) / ptb) * 100 : null;
    const btcDirection = resolvedPrice > ptb ? "UP" : "DOWN";
    const wasOverreaction = movePct !== null && Math.abs(movePct) > 0.06; // >0.06% is a sharp 15m move
    const oppositePrice = pos.outcome === "Up" ? pos.downPrice : pos.upPrice;
    const combinedPrice = (pos.upPrice && pos.downPrice) ? pos.upPrice + pos.downPrice : null;
    const arbOpportunity = combinedPrice !== null && combinedPrice < 0.97; // Up+Down < 97¢ = arb

    const last3 = this.recentOutcomes.slice(-3).join(" → ");
    const last5 = this.recentOutcomes.slice(-5).join(" → ");
    const recentWinRate = this.recentOutcomes.length >= 5 
      ? (this.recentOutcomes.slice(-5).filter(o => o === "W").length / 5 * 100).toFixed(0) 
      : "N/A";

    const tag = won ? "✅ WIN" : "❌ LOSS";
    console.log(`[Analysis] ════════════════════════════════════════`);
    console.log(`[Analysis] ${tag} | ${pos.direction} ${pos.outcome} | Market: ${pos.marketSlug?.slice(-20)}`);
    console.log(`[Analysis] BTC: $${ptb?.toFixed(2) || 'N/A'} → $${resolvedPrice?.toFixed(2) || 'N/A'} (${btcDirection} ${movePct !== null ? movePct.toFixed(3) : 'N/A'}%)`);
    console.log(`[Analysis] Entry: $${pos.entryPrice?.toFixed(3)} | Opposite was: $${oppositePrice?.toFixed(3) || 'N/A'}`);
    console.log(`[Analysis] Up+Down combined: $${combinedPrice?.toFixed(3) || 'N/A'} ${arbOpportunity ? '⚡ ARB OPPORTUNITY MISSED' : ''}`);
    console.log(`[Analysis] Sharp move? ${wasOverreaction ? 'YES — overreaction' : 'No — normal range'} | Move: $${moveAbs?.toFixed(2) || 'N/A'}`);
    console.log(`[Analysis] Indicators: BULL ${pos.bullScore} vs BEAR ${pos.bearScore} | Signals: ${(pos.signals || []).join(', ') || 'N/A'}`);
    console.log(`[Analysis] Streak: ${last3} | Last 5: ${last5} | Recent WR: ${recentWinRate}%`);

    // Pattern detection
    if (!won) {
      if (wasOverreaction) {
        console.log(`[Analysis] 💡 LESSON: Sharp ${btcDirection} move — consider mean-reversion (fade the move)`);
      }
      if (oppositePrice && oppositePrice < 0.45) {
        console.log(`[Analysis] 💡 LESSON: Opposite token was cheap ($${oppositePrice.toFixed(3)}) — could have hedged`);
      }
      if (pos.bullScore && pos.bearScore && Math.abs(pos.bullScore - pos.bearScore) < 4) {
        console.log(`[Analysis] 💡 LESSON: Weak signal (diff ${Math.abs(pos.bullScore - pos.bearScore)}) — should have skipped`);
      }
    }
    if (won && wasOverreaction) {
      console.log(`[Analysis] 💰 PATTERN: Won on sharp move — momentum was strong`);
    }
    console.log(`[Analysis] ════════════════════════════════════════`);

    // Write to CSV for offline analysis
    this._appendCsv(pos, resolvedPrice, won, movePct, wasOverreaction, oppositePrice, combinedPrice);

    // Save to persistent journal
    this._appendJournal(pos, resolvedPrice, won, movePct, wasOverreaction, oppositePrice, combinedPrice);

    // Rolling window analysis every 4 trades
    const totalTrades = this.wins + this.losses;
    if (totalTrades > 0 && totalTrades % 4 === 0) {
      this._printRollingAnalysis();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ROLLING WINDOW ANALYSIS — printed every 4 trades
  // ═══════════════════════════════════════════════════════════════
  _printRollingAnalysis() {
    const closed = this.closedPositions;
    const total = closed.length;
    
    const windows = [
      { name: "Last 4", trades: closed.slice(-4) },
      { name: "Last 10", trades: closed.slice(-10) },
      { name: "All time", trades: closed }
    ];

    console.log(`\n[Memory] ╔══════════════════════════════════════════════╗`);
    console.log(`[Memory] ║  TRADE MEMORY — ${total} trades recorded          ║`);
    console.log(`[Memory] ╠══════════════════════════════════════════════╣`);

    for (const w of windows) {
      if (w.trades.length === 0) continue;
      const wins = w.trades.filter(t => t.status === "RESOLVED_WIN").length;
      const losses = w.trades.length - wins;
      const wr = (wins / w.trades.length * 100).toFixed(0);
      const pnl = w.trades.reduce((s, t) => s + (t.pnl || 0), 0);
      const avgEntry = w.trades.reduce((s, t) => s + (t.entryPrice || 0), 0) / w.trades.length;
      console.log(`[Memory] ║ ${w.name.padEnd(8)}: ${wins}W/${losses}L (${wr}%) | P&L: $${pnl.toFixed(2)} | Avg entry: $${avgEntry.toFixed(3)}`);
    }

    // Strategy breakdown
    const stratCounts = {};
    for (const t of closed) {
      const strat = t.strategy || "UNKNOWN";
      if (!stratCounts[strat]) stratCounts[strat] = { wins: 0, losses: 0, pnl: 0 };
      if (t.status === "RESOLVED_WIN") stratCounts[strat].wins++;
      else stratCounts[strat].losses++;
      stratCounts[strat].pnl += t.pnl || 0;
    }
    console.log(`[Memory] ╠══════════════════════════════════════════════╣`);
    console.log(`[Memory] ║ STRATEGY BREAKDOWN:`);
    for (const [strat, data] of Object.entries(stratCounts)) {
      const wr = ((data.wins / (data.wins + data.losses)) * 100).toFixed(0);
      console.log(`[Memory] ║   ${strat.padEnd(18)}: ${data.wins}W/${data.losses}L (${wr}%) | P&L: $${data.pnl.toFixed(2)}`);
    }

    // Price tier breakdown
    const tierCounts = { cheap: { w: 0, l: 0, pnl: 0 }, mid: { w: 0, l: 0, pnl: 0 }, expensive: { w: 0, l: 0, pnl: 0 } };
    for (const t of closed) {
      const tier = (t.entryPrice || 0) < 0.30 ? "cheap" : (t.entryPrice || 0) < 0.40 ? "mid" : "expensive";
      if (t.status === "RESOLVED_WIN") tierCounts[tier].w++;
      else tierCounts[tier].l++;
      tierCounts[tier].pnl += t.pnl || 0;
    }
    console.log(`[Memory] ╠══════════════════════════════════════════════╣`);
    console.log(`[Memory] ║ PRICE TIER BREAKDOWN:`);
    for (const [tier, data] of Object.entries(tierCounts)) {
      if (data.w + data.l === 0) continue;
      const wr = ((data.w / (data.w + data.l)) * 100).toFixed(0);
      console.log(`[Memory] ║   ${tier.padEnd(12)}: ${data.w}W/${data.l}L (${wr}%) | P&L: $${data.pnl.toFixed(2)}`);
    }

    // Key insights
    console.log(`[Memory] ╠══════════════════════════════════════════════╣`);
    const last4 = closed.slice(-4);
    const last4WR = last4.length > 0 ? (last4.filter(t => t.status === "RESOLVED_WIN").length / last4.length * 100) : 0;
    if (last4WR >= 75) {
      console.log(`[Memory] ║ 🔥 HOT STREAK: ${last4WR.toFixed(0)}% win rate last 4 trades`);
    } else if (last4WR <= 25) {
      console.log(`[Memory] ║ ⚠ COLD STREAK: ${last4WR.toFixed(0)}% win rate last 4 trades — strategy may need adjustment`);
    }
    const bestStrat = Object.entries(stratCounts).sort((a, b) => b[1].pnl - a[1].pnl)[0];
    if (bestStrat) {
      console.log(`[Memory] ║ 💰 Best strategy: ${bestStrat[0]} ($${bestStrat[1].pnl.toFixed(2)} P&L)`);
    }
    console.log(`[Memory] ╚══════════════════════════════════════════════╝\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // PERSISTENT JOURNAL — survives restarts, detailed trade records
  // ═══════════════════════════════════════════════════════════════
  _appendJournal(pos, resolvedPrice, won, movePct, wasOverreaction, oppositePrice, combinedPrice) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      let journal = [];
      if (fs.existsSync(JOURNAL_FILE)) {
        try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); } catch (e) { journal = []; }
      }
      const assetName = pos.assetName || "BTC";
      journal.push({
        timestamp: new Date().toISOString(),
        asset: assetName,
        market: pos.marketSlug || "",
        direction: pos.direction,
        outcome: pos.outcome,
        won,
        strategy: pos.strategy || "UNKNOWN",
        entryPrice: pos.entryPrice,
        oppositePrice: oppositePrice || null,
        combinedPrice: combinedPrice || null,
        cost: pos.cost,
        pnl: pos.pnl,
        priceStart: pos.priceToBeat,
        priceEnd: resolvedPrice,
        movePct: movePct || null,
        overreaction: wasOverreaction || false,
        bullScore: pos.bullScore || 0,
        bearScore: pos.bearScore || 0,
        signals: pos.signals || [],
        streak: this.recentOutcomes.slice(-10).join('')
      });
      fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2), "utf8");
    } catch (e) { /* ignore */ }
  }

  _ensureCsvHeader() {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      if (!fs.existsSync(CSV_FILE)) {
        const header = "timestamp,asset,market,direction,outcome,won,strategy,entryPrice,oppositePrice,combinedPrice,cost,pnl,priceStart,priceEnd,movePct,overreaction,bullScore,bearScore,signals,streak\n";
        fs.writeFileSync(CSV_FILE, header, "utf8");
      }
    } catch (e) { /* ignore */ }
  }

  _appendCsv(pos, resolvedPrice, won, movePct, wasOverreaction, oppositePrice, combinedPrice) {
    try {
      const assetName = pos.assetName || "BTC";
      const row = [
        new Date().toISOString(),
        assetName,
        pos.marketSlug || "",
        pos.direction,
        pos.outcome,
        won ? "WIN" : "LOSS",
        pos.strategy || "UNKNOWN",
        pos.entryPrice?.toFixed(3) || "",
        oppositePrice?.toFixed(3) || "",
        combinedPrice?.toFixed(3) || "",
        pos.cost?.toFixed(2) || "",
        pos.pnl?.toFixed(2) || "",
        pos.priceToBeat?.toFixed(2) || "",
        resolvedPrice?.toFixed(2) || "",
        movePct?.toFixed(4) || "",
        wasOverreaction ? "YES" : "NO",
        pos.bullScore || 0,
        pos.bearScore || 0,
        `"${(pos.signals || []).join('; ')}"`,
        `"${this.recentOutcomes.slice(-10).join('')}"`
      ].join(",");
      fs.appendFileSync(CSV_FILE, row + "\n", "utf8");
    } catch (e) { /* ignore */ }
  }

  _saveState() {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const state = {
        openPositions: this.openPositions,
        closedPositions: this.closedPositions,
        totalPnl: this.totalPnl,
        wins: this.wins,
        losses: this.losses,
        totalCost: this.totalCost,
        totalReturn: this.totalReturn,
        recentOutcomes: this.recentOutcomes,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(PNL_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      // ignore
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(PNL_FILE)) {
        const data = JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
        this.openPositions = data.openPositions || [];
        this.closedPositions = data.closedPositions || [];
        this.totalPnl = data.totalPnl || 0;
        this.wins = data.wins || 0;
        this.losses = data.losses || 0;
        this.totalCost = data.totalCost || 0;
        this.totalReturn = data.totalReturn || 0;
        this.recentOutcomes = data.recentOutcomes || [];
        console.log(`[Tracker] Loaded state: ${this.wins}W/${this.losses}L | P&L: $${this.totalPnl.toFixed(2)} | Streak: ${this.recentOutcomes.slice(-5).join(' → ') || 'none'}`);
        console.log(`[Tracker] ${this.closedPositions.length} historical trades loaded for strategy learning`);
      }
    } catch (e) {
      console.log("[Tracker] No previous state found, starting fresh");
    }
  }
}
