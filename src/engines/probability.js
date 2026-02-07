import { clamp } from "../utils.js";

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim
  } = inputs;

  let up = 1;
  let down = 1;

  // Price vs VWAP (most reliable for 15m) - INCREASED WEIGHT
  if (price !== null && vwap !== null) {
    if (price > vwap) up += 3;  // Increased from 2
    if (price < vwap) down += 3;  // Increased from 2
  }

  // VWAP slope (strong momentum signal) - INCREASED WEIGHT
  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 3;  // Increased from 2
    if (vwapSlope < 0) down += 3;  // Increased from 2
  }

  // RSI (lagging, less reliable for 15m) - REDUCED WEIGHT & STRICTER THRESHOLDS
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 60 && rsiSlope > 0) up += 1;  // Decreased from 2, raised threshold from 55
    if (rsi < 40 && rsiSlope < 0) down += 1;  // Decreased from 2, lowered threshold from 45
  }

  // MACD (lagging indicator) - REDUCED WEIGHT
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 1;  // Decreased from 2
    if (expandingRed) down += 1;  // Decreased from 2

    if (macd.macd > 0) up += 0.5;  // Decreased from 1
    if (macd.macd < 0) down += 0.5;  // Decreased from 1
  }

  // Heiken Ashi (good for trend) - REQUIRE MORE CONFIRMATION
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 3) up += 2;  // Increased from 1, require 3+ candles
    if (heikenColor === "red" && heikenCount >= 3) down += 2;  // Increased from 1, require 3+ candles
  }

  // Failed VWAP reclaim (strong bearish signal) - KEEP STRONG
  if (failedVwapReclaim === true) down += 3;

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
