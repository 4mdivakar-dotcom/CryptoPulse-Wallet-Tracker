import express from "express";
import "dotenv/config";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import speakeasy from "speakeasy";
import axios from "axios";
import Moralis from "moralis";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let moralisStartedPromise: Promise<void> | null = null;

const ensureMoralisStarted = async () => {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("MORALIS_API_KEY is not set in environment variables.");
  }
  
  if (!moralisStartedPromise) {
    moralisStartedPromise = Moralis.start({ apiKey }).catch(err => {
      if (err.message?.includes("already started")) {
        return;
      }
      moralisStartedPromise = null;
      throw err;
    });
  }
  return moralisStartedPromise;
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // 2FA: Generate secret
  app.post("/api/2fa/generate", (req, res) => {
    const { email } = req.body;
    const secret = speakeasy.generateSecret({
      name: `CryptoPulse (${email})`,
    });
    res.json({
      secret: secret.base32,
      otpauth_url: secret.otpauth_url,
    });
  });

  // 2FA: Verify token
  app.post("/api/2fa/verify", (req, res) => {
    const { secret, token } = req.body;
    const verified = speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token,
    });
    res.json({ verified });
  });

  // Crypto Prices Proxy (CoinGecko) with Caching
  let cachedPrices: any = null;
  let lastFetchTime = 0;
  const CACHE_DURATION = 60000; // 1 minute

  app.get("/api/prices", async (req, res) => {
    const now = Date.now();
    if (cachedPrices && now - lastFetchTime < CACHE_DURATION) {
      return res.json(cachedPrices);
    }

    try {
      const response = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price",
        {
          params: {
            ids: "ethereum,bitcoin,binancecoin,solana,cardano",
            vs_currencies: "usd",
            include_24hr_change: "true",
          },
          timeout: 5000,
        }
      );
      cachedPrices = response.data;
      lastFetchTime = now;
      res.json(cachedPrices);
    } catch (error: any) {
      console.error("Error fetching prices:", error.message);
      if (cachedPrices) {
        // Fallback to stale cache if API fails
        return res.json(cachedPrices);
      }
      const status = error.response?.status || 500;
      res.status(status).json({ error: "Failed to fetch prices", details: error.message });
    }
  });

  // Moralis: Get Wallet Token Balances
  app.get("/api/wallet/tokens/:address", async (req, res) => {
    const { address } = req.params;
    const { chain } = req.query;
    
    try {
      if (!address || !address.startsWith("0x") || address.length < 40) {
        return res.status(400).json({ 
          error: "Invalid Address", 
          details: "The provided wallet address is invalid." 
        });
      }

      const checksummedAddress = ethers.getAddress(address);
      await ensureMoralisStarted();
      
      const response = await Moralis.EvmApi.token.getWalletTokenBalances({
        address: checksummedAddress,
        chain: (chain as string) || "0x1",
      });
      
      res.json(response.toJSON());
    } catch (error: any) {
      console.error("Moralis Token Error:", error.message);
      const isKeyError = error.message?.includes("MORALIS_API_KEY") || error.message?.includes("unauthorized") || error.message?.includes("API Key");
      res.status(isKeyError ? 401 : 400).json({ 
        error: "Moralis Error", 
        details: error.message 
      });
    }
  });

  // Moralis: Get Wallet Transaction History
  app.get("/api/wallet/history/:address", async (req, res) => {
    const { address } = req.params;
    const { chain } = req.query;
    
    try {
      if (!address || !address.startsWith("0x") || address.length < 40) {
        return res.status(400).json({ 
          error: "Invalid Address", 
          details: "The provided wallet address is invalid." 
        });
      }

      const checksummedAddress = ethers.getAddress(address);
      await ensureMoralisStarted();
      
      const response = await Moralis.EvmApi.transaction.getWalletTransactions({
        address: checksummedAddress,
        chain: (chain as string) || "0x1",
        limit: 10,
      });
      
      res.json(response.toJSON());
    } catch (error: any) {
      console.error("Moralis History Error:", error.message);
      const isKeyError = error.message?.includes("MORALIS_API_KEY") || error.message?.includes("unauthorized") || error.message?.includes("API Key");
      res.status(isKeyError ? 401 : 400).json({ 
        error: "Moralis Error", 
        details: error.message 
      });
    }
  });

  // Crypto News Proxy
  app.get("/api/news", async (req, res) => {
    try {
      const response = await axios.get("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", {
        timeout: 5000,
      });
      
      if (response.data && response.data.Data) {
        res.json(response.data);
      } else {
        console.error("Invalid news API response:", response.data);
        res.status(502).json({ 
          error: "Invalid news data format from provider", 
          details: response.data?.Message || "Unknown API error" 
        });
      }
    } catch (error: any) {
      console.error("Error fetching news:", error.message);
      res.status(500).json({ error: "Failed to fetch news", details: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
