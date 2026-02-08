import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const USDC_ADDRESS = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // Native USDC
const PROXY_WALLET = process.env.PROXY_WALLET; // Polymarket account address for custodial balance

export class TradingService {
  constructor(privateKey) {
    if (!privateKey) {
      throw new Error("Private key is required for trading");
    }
    
    this.wallet = new Wallet(privateKey);
    this.client = null;
    this.credentials = null;
    this.isInitialized = false;
    this.activeOrders = new Map();
  }

  async initialize() {
    try {
      // Verify wallet is valid
      if (!this.wallet.address) {
        throw new Error("Invalid wallet address");
      }

      // Initialize CLOB client with wallet
      console.log("[Trading] Initializing CLOB client...");
      this.client = new ClobClient(HOST, CHAIN_ID, this.wallet);
      
      // Derive API credentials from wallet
      console.log("[Trading] Deriving API credentials...");
      try {
        this.credentials = await this.client.deriveApiKey();
      } catch (e) {
        console.log("[Trading] deriveApiKey failed, trying createOrDeriveApiKey...");
        this.credentials = await this.client.createOrDeriveApiKey();
      }
      
      // Reinitialize client with credentials
      // signatureType: 2 = POLY_GNOSIS_SAFE (smart contract wallet)
      // funder: proxy wallet (becomes the maker in orders)
      // Your MetaMask signs, proxy wallet executes
      const signatureType = 2;
      const funder = PROXY_WALLET;
      
      this.client = new ClobClient(
        HOST, 
        CHAIN_ID, 
        this.wallet,
        this.credentials,
        signatureType,
        funder
      );
      
      console.log("[Trading] CLOB client initialized successfully");
      console.log("[Trading] Signer (MetaMask):", this.wallet.address);
      console.log("[Trading] Maker (Proxy wallet):", funder);
      console.log("[Trading] Using delegation model - MetaMask signs, proxy executes");
      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error("Failed to initialize trading service:", error.message);
      console.error("Error details:", error);
      throw error;
    }
  }

  async getBalance() {
    if (!this.isInitialized) {
      throw new Error("Trading service not initialized");
    }
    
    try {
      // Get balance allowance from CLOB API for USDC (PoS) token
      // USDC (PoS) on Polygon: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
      const USDC_POS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
      
      const balanceAllowance = await this.client.getBalanceAllowance({
        asset_type: USDC_POS
      });
      
      console.log("[Trading] Balance response:", JSON.stringify(balanceAllowance, null, 2));
      
      if (balanceAllowance) {
        let balanceAmount = null;
        
        // Try different response formats
        if (balanceAllowance.balance !== undefined) {
          // Format: { balance: "50000000" }
          balanceAmount = parseFloat(balanceAllowance.balance) / 1e6;
        } else if (balanceAllowance.allowance !== undefined) {
          // Format: { allowance: "50000000" }
          balanceAmount = parseFloat(balanceAllowance.allowance) / 1e6;
        } else if (typeof balanceAllowance === 'string') {
          // Direct string response
          balanceAmount = parseFloat(balanceAllowance) / 1e6;
        } else if (typeof balanceAllowance === 'number') {
          // Direct number response
          balanceAmount = balanceAllowance / 1e6;
        }
        
        if (balanceAmount !== null && balanceAmount >= 0) {
          console.log(`[Trading] Current balance: ${balanceAmount.toFixed(2)} USDC`);
          return balanceAmount;
        }
      }
      
      console.warn("[Trading] Could not parse balance from API response");
      return null;
    } catch (error) {
      console.error("[Trading] Failed to get balance:", error.message);
      console.error("[Trading] Error details:", error);
      return null;
    }
  }

  async placeOrder({ tokenId, side, price, size, orderType = "GTC" }) {
    if (!this.isInitialized) {
      throw new Error("Trading service not initialized");
    }

    try {
      console.log(`[Trading] Creating order: ${side} ${size} shares at $${price.toFixed(3)}`);
      console.log(`[Trading] Token ID: ${tokenId}, Price: ${price}, Size: ${size}`);
      
      // Fetch the actual fee rate for this market
      let feeRate = 1000; // Default to 10% (1000 bps)
      try {
        const feeData = await this.client.getFeeRate(tokenId);
        if (feeData && feeData.feeRateBps) {
          feeRate = parseInt(feeData.feeRateBps);
          console.log(`[Trading] Market fee rate: ${feeRate} bps (${(feeRate / 100).toFixed(2)}%)`);
        }
      } catch (e) {
        console.log(`[Trading] Could not fetch fee rate, using default 1000 bps`);
      }
      
      // v4 CLOB client: createOrder + postOrder (two steps)
      const orderArgs = {
        tokenID: tokenId,
        price: price,
        side: side.toUpperCase(),
        size: size,
        feeRateBps: feeRate
      };
      
      const options = {
        tickSize: "0.01",
        negRisk: false
      };
      
      console.log(`[Trading] Order args:`, JSON.stringify(orderArgs));
      
      // Step 1: Create signed order
      const signedOrder = await this.client.createOrder(orderArgs, options);
      console.log(`[Trading] Order signed, posting...`);
      
      // Step 2: Post order to CLOB with retry for proxy timeouts
      let order = null;
      let retries = 0;
      const maxRetries = 3;
      
      while (retries < maxRetries) {
        try {
          order = await this.client.postOrder(signedOrder, orderType);
          break; // Success - exit retry loop
        } catch (error) {
          retries++;
          console.log(`[Trading] ⚠ Proxy timeout (attempt ${retries}/${maxRetries}): ${error.message}`);
          
          if (retries < maxRetries) {
            console.log(`[Trading] Retrying in 2 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            console.log(`[Trading] ✗ Failed after ${maxRetries} attempts`);
            throw new Error(`Proxy timeout after ${maxRetries} attempts: ${error.message}`);
          }
        }
      }
      
      // Double-check we got an order
      if (!order) {
        throw new Error("Failed to place order: No response after retries");
      }

      // Safe log - avoid circular structure errors from proxy agents
      try {
        const safeOrder = order ? { orderID: order.orderID, status: order.status, ...( order.errorMsg ? { errorMsg: order.errorMsg } : {}) } : order;
        console.log(`[Trading] Order response:`, JSON.stringify(safeOrder));
      } catch { console.log(`[Trading] Order response: [object]`); }

      if (order && order.orderID) {
        this.activeOrders.set(order.orderID, {
          ...order,
          timestamp: Date.now(),
          tokenId,
          side,
          price,
          size
        });
        console.log(`[Trading] ✓ Order placed successfully: ${order.orderID}`);
      } else {
        console.log(`[Trading] ⚠ Order created but no orderID returned`);
      }

      return order;
    } catch (error) {
      console.error("[Trading] ✗ Failed to place order:", error.message);
      throw error;
    }
  }

  async cancelOrder(orderId) {
    if (!this.isInitialized) {
      throw new Error("Trading service not initialized");
    }

    try {
      const result = await this.client.cancelOrder(orderId);
      this.activeOrders.delete(orderId);
      console.log(`[Trading] Order cancelled: ${orderId}`);
      return result;
    } catch (error) {
      console.error("Failed to cancel order:", error.message);
      throw error;
    }
  }

  async cancelAllOrders() {
    if (!this.isInitialized) {
      throw new Error("Trading service not initialized");
    }

    try {
      const result = await this.client.cancelAll();
      this.activeOrders.clear();
      console.log(`[Trading] All orders cancelled`);
      return result;
    } catch (error) {
      console.error("Failed to cancel all orders:", error.message);
      throw error;
    }
  }

  async getOpenOrders() {
    if (!this.isInitialized) {
      throw new Error("Trading service not initialized");
    }

    try {
      const orders = await this.client.getOrders();
      return orders;
    } catch (error) {
      console.error("Failed to get open orders:", error.message);
      return [];
    }
  }

  getActiveOrdersCount() {
    return this.activeOrders.size;
  }

  getWalletAddress() {
    return this.wallet.address;
  }
}
