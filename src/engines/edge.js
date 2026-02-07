import { clamp } from "../utils.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null }) {
  // CAPITAL PRESERVATION: Don't trade in first 8 minutes (too much uncertainty)
  if (remainingMinutes > 7) {
    return { action: "NO_TRADE", side: null, phase: "TOO_EARLY", reason: "avoid_early_candle_uncertainty" };
  }

  const phase = remainingMinutes > 5 ? "MID" : "LATE";

  // STRICTER EDGE REQUIREMENTS (was 5%, 10%, 20%)
  const threshold = phase === "MID" ? 0.15 : 0.20;  // 15% mid, 20% late

  // STRICTER PROBABILITY REQUIREMENTS (was 55%, 60%, 65%)
  const minProb = phase === "MID" ? 0.70 : 0.75;  // 70% mid, 75% late

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  // CONSERVATIVE: Only "STRONG" trades (25%+ edge) or "GOOD" trades (15%+ edge)
  const strength = bestEdge >= 0.25 ? "STRONG" : bestEdge >= 0.15 ? "GOOD" : "SKIP";
  
  if (strength === "SKIP") {
    return { action: "NO_TRADE", side: null, phase, reason: "edge_not_strong_enough" };
  }

  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
