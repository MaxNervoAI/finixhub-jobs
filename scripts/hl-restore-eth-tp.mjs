import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const exchange = new ccxt.hyperliquid({
  walletAddress: process.env.HL_WALLET_ADDRESS,
  privateKey: process.env.HL_PRIVATE_KEY,
  sandbox: process.env.HL_TESTNET !== "false",
});
await exchange.loadMarkets();

const tpOrder = await exchange.createOrder("ETH/USDC:USDC", "limit", "buy", 0.0604, 1786.8, {
  postOnly: true,
  reduceOnly: true,
});
console.log(`✓ TP re-placed at $1786.8 | id:${tpOrder.id}`);

const { error } = await supabase
  .from("hyperliquid_trades")
  .update({ hl_tp_order_id: tpOrder.id, updated_at: new Date().toISOString() })
  .eq("id", "f63f41c5-4b28-4026-92e5-ffb1ec71aa0b");

if (error) console.error(`DB update failed: ${error.message}`);
else console.log("✓ DB updated");
