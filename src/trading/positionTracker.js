import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "logs");
const PNL_FILE = path.join(LOG_DIR, "pnl.json");

export class PositionTracker {
  constructor() {
    this.openPositions = [];   // Currently open (waiting for resolution)
    this.closedPositions = []; // Resolved positions with P&L
    this.totalPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.totalCost = 0;
    this.totalReturn = 0;
    
    // Load saved P&L data
    this._loadState();
  }

  // Record a new position when an order is placed
  addPosition({ orderId, direction, outcome, price, size, confidence, edge, marketSlug, marketEndTime, priceToBeat }) {
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
  checkResolutions(currentPrice, priceToBeat) {
    const now = Date.now();
    const resolved = [];

    for (let i = this.openPositions.length - 1; i >= 0; i--) {
      const pos = this.openPositions[i];
      
      // Check if market has ended (15m candle closed)
      if (pos.marketEndTime && now >= pos.marketEndTime) {
        // Determine outcome
        let won = false;
        
        // Use stored priceToBeat from position, fall back to passed parameter
        const ptb = pos.priceToBeat !== null && pos.priceToBeat !== undefined ? pos.priceToBeat : priceToBeat;
        
        if (ptb !== null && currentPrice !== null) {
          const btcWentUp = currentPrice > ptb;
          const btcWentDown = currentPrice <= ptb;
          
          if (pos.outcome === "Up" && btcWentUp) won = true;
          if (pos.outcome === "Down" && btcWentDown) won = true;
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
        console.log(`[Tracker] ${emoji} Position resolved: ${pos.direction} ${pos.outcome} | P&L: $${pos.pnl.toFixed(2)} | Total P&L: $${this.totalPnl.toFixed(2)}`);
        
        // Detailed loss analysis for learning
        if (!won) {
          console.log(`[Loss Analysis] ────────────────────────────`);
          console.log(`[Loss Analysis] Market: ${pos.marketSlug}`);
          console.log(`[Loss Analysis] Direction: ${pos.direction} | Outcome bet: ${pos.outcome}`);
          console.log(`[Loss Analysis] Entry: $${pos.entryPrice?.toFixed(3) || 'N/A'} | Shares: ${pos.size} | Cost: $${pos.cost?.toFixed(2) || 'N/A'}`);
          console.log(`[Loss Analysis] Confidence: ${pos.confidence?.toFixed(1) || 'N/A'}% | Edge: ${pos.edge ? (pos.edge * 100).toFixed(1) : 'N/A'}%`);
          console.log(`[Loss Analysis] PriceToBeat: $${pos.priceToBeat?.toFixed(2) || 'N/A'} | Resolved BTC: $${currentPrice?.toFixed(2) || 'N/A'}`);
          console.log(`[Loss Analysis] Result: BTC moved ${pos.outcome === 'Up' ? 'DOWN' : 'UP'} — prediction was WRONG`);
          console.log(`[Loss Analysis] ────────────────────────────`);
        }
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
    
    // Stop if 3+ consecutive losses - something is wrong with the signal
    if (stats.streakType === "LOSS" && stats.currentStreak >= 3) {
      return { stop: true, reason: `${stats.currentStreak} consecutive losses - STOP` };
    }
    
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
        console.log(`[Tracker] Loaded state: ${this.wins}W/${this.losses}L | P&L: $${this.totalPnl.toFixed(2)}`);
      }
    } catch (e) {
      console.log("[Tracker] No previous state found, starting fresh");
    }
  }
}
