import { TradingService } from "./tradingService.js";
import { TradingEngine } from "./tradingEngine.js";
import { CONFIG } from "../config.js";

let tradingService = null;
let tradingEngine = null;

export async function initializeTrading() {
  const fs = await import("fs");
  const path = await import("path");
  
  const logFile = path.join(process.cwd(), "logs", "trading-init.log");
  const log = (msg) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} - ${msg}\n`);
    } catch (e) {
      // ignore
    }
  };

  log(`Starting trading initialization. TRADING_ENABLED=${CONFIG.trading.enabled}`);

  if (!CONFIG.trading.enabled) {
    log("Trading is disabled in config");
    return { enabled: false, message: "Trading is disabled" };
  }

  if (!CONFIG.trading.privateKey) {
    log("No private key configured");
    return { enabled: false, message: "No private key configured" };
  }

  try {
    log("Creating TradingService with private key...");
    tradingService = new TradingService(CONFIG.trading.privateKey);
    
    log("Initializing TradingService with 30s timeout...");
    // Add timeout to prevent hanging on CLOB initialization
    const initPromise = tradingService.initialize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("CLOB initialization timeout")), 30000)
    );
    
    try {
      await Promise.race([initPromise, timeoutPromise]);
    } catch (err) {
      if (err.message === "CLOB initialization timeout") {
        log("CLOB initialization timed out - continuing without trading");
        return { 
          enabled: false, 
          message: "CLOB initialization timeout - trading disabled",
          walletAddress: null,
          dryRun: false
        };
      }
      throw err;
    }

    log("Creating TradingEngine...");
    tradingEngine = new TradingEngine(tradingService, {
      enabled: !CONFIG.trading.dryRun,
      minConfidence: CONFIG.trading.minConfidence,
      orderSize: CONFIG.trading.orderSize,
      maxPositionSize: CONFIG.trading.maxPositionSize,
      minEdge: CONFIG.trading.minEdge,
      cooldownMs: CONFIG.trading.cooldownMs,
      maxTokenPrice: CONFIG.trading.maxTokenPrice,
      maxTradesPerHour: CONFIG.trading.maxTradesPerHour,
      maxDailyLoss: CONFIG.trading.maxDailyLoss
    });

    const walletAddress = tradingService.getWalletAddress();
    log(`Trading initialized successfully. Wallet: ${walletAddress}`);
    
    return {
      enabled: true,
      dryRun: CONFIG.trading.dryRun,
      walletAddress,
      message: `Trading initialized (${CONFIG.trading.dryRun ? 'DRY RUN' : 'LIVE'})`
    };
  } catch (error) {
    log(`Trading initialization failed: ${error.message}`);
    return {
      enabled: false,
      error: error.message,
      message: `Trading initialization failed: ${error.message}`
    };
  }
}

export async function evaluateAndTrade(prediction, marketData, currentPrice, indicators = {}, priceToBeat = null) {
  if (!tradingEngine || !CONFIG.trading.enabled) {
    return { traded: false, reason: "Trading not enabled" };
  }

  const signal = tradingEngine.shouldTrade(prediction, marketData, currentPrice, indicators);

  if (CONFIG.trading.dryRun) {
    return {
      traded: false,
      dryRun: true,
      signal,
      reason: signal.shouldTrade ? `DRY RUN: Would trade ${signal.direction}` : signal.reason
    };
  }

  if (!signal.shouldTrade) {
    return { traded: false, signal, reason: signal.reason };
  }

  const result = await tradingEngine.executeTrade(signal, marketData, priceToBeat);
  
  return {
    traded: result.success,
    signal,
    result,
    reason: result.reason
  };
}

export function checkResolutions(currentPrice, priceToBeat, assetName = null) {
  if (!tradingEngine) return [];
  return tradingEngine.checkResolutions(currentPrice, priceToBeat, assetName);
}

export function checkStopLoss(currentMarketPrices) {
  if (!tradingEngine) return [];
  return tradingEngine.checkStopLoss(currentMarketPrices);
}

export function cleanupStalePositions() {
  if (!tradingEngine) return;
  tradingEngine.cleanupStalePositions();
}

export function getTradingStats() {
  if (!tradingEngine) {
    return null;
  }
  return tradingEngine.getStats();
}

export function getTradingService() {
  return tradingService;
}

export function getTradingEngine() {
  return tradingEngine;
}
