import { CONFIG } from "../config.js";

let binanceErrorLogged = false;

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function fetchKlines({ interval, limit }) {
  const url = new URL("/api/v3/klines", CONFIG.binanceBaseUrl);
  url.searchParams.set("symbol", CONFIG.symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (!binanceErrorLogged && res.status === 451) {
        console.log("⚠️  Binance geo-blocked (451) - using Chainlink fallback");
        binanceErrorLogged = true;
      }
      return null;
    }
    const data = await res.json();
    binanceErrorLogged = false;

    return data.map((k) => ({
      openTime: Number(k[0]),
      open: toNumber(k[1]),
      high: toNumber(k[2]),
      low: toNumber(k[3]),
      close: toNumber(k[4]),
      volume: toNumber(k[5]),
      closeTime: Number(k[6])
    }));
  } catch (err) {
    if (!binanceErrorLogged) {
      console.log("⚠️  Binance unavailable - using Chainlink fallback");
      binanceErrorLogged = true;
    }
    return null;
  }
}

export async function fetchLastPrice() {
  const url = new URL("/api/v3/ticker/price", CONFIG.binanceBaseUrl);
  url.searchParams.set("symbol", CONFIG.symbol);
  
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    return toNumber(data.price);
  } catch (err) {
    return null;
  }
}
