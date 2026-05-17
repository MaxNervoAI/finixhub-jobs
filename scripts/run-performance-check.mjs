#!/usr/bin/env node
/**
 * AI Trade Performance Check
 * Runs daily to check SL/TP hits for AI-generated plans
 */

import { createClient } from '@supabase/supabase-js';


const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Fetch current price from Binance API
 */
async function fetchCurrentPrice(symbol) {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    const data = await response.json();
    return parseFloat(data.price);
  } catch (error) {
    console.error(`Error fetching price for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Check if price hit SL or TP
 */
function checkPriceLevels(currentPrice, entry, sl, tps, bias) {
  const isLong = bias === 'long';
  
  // Check SL
  const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
  
  // Check TPs
  const tpHit = tps.some((tp, index) => {
    return isLong ? currentPrice >= tp : currentPrice <= tp;
  });
  
  const tpLevelHit = tps.findIndex((tp, index) => {
    return isLong ? currentPrice >= tp : currentPrice <= tp;
  });
  
  return { slHit, tpHit, tpLevelHit: tpLevelHit >= 0 ? tpLevelHit + 1 : null };
}

/**
 * Calculate time elapsed in hours
 */
function calculateTimeHours(start, end) {
  const diff = new Date(end).getTime() - new Date(start).getTime();
  return diff / (1000 * 60 * 60);
}

/**
 * Main performance check function
 */
async function runPerformanceCheck() {
  console.log('🔍 Starting AI trade performance check...');
  
  // Fetch all active AI-generated plans
  const { data: plans, error: plansError } = await supabase
    .from('investment_plans')
    .select('*')
    .eq('is_active', true)
    .eq('ai_generated', true);
  
  if (plansError) {
    console.error('Error fetching AI-generated plans:', plansError);
    throw plansError;
  }
  
  console.log(`Found ${plans.length} active AI-generated plans`);
  
  for (const plan of plans) {
    try {
      const currentPrice = await fetchCurrentPrice(plan.asset_symbol);
      const { slHit, tpHit, tpLevelHit } = checkPriceLevels(
        currentPrice,
        plan.entry_price,
        plan.invalidation_level,
        plan.take_profit_levels.map(tp => tp.level),
        plan.bias
      );
      
      // Calculate time elapsed
      const timeElapsed = calculateTimeHours(plan.created_at, new Date().toISOString());
      
      // Determine final status
      let finalStatus = 'pending';
      let whipsaw = false;
      
      if (slHit && tpHit) {
        // Check if both hit within 1 hour (whipsaw)
        const timeToSl = calculateTimeHours(plan.created_at, new Date().toISOString());
        const timeToTp = calculateTimeHours(plan.created_at, new Date().toISOString());
        
        if (Math.abs(timeToSl - timeToTp) < 1) {
          finalStatus = 'whipsaw';
          whipsaw = true;
        } else {
          finalStatus = tpHit ? 'winner' : 'loser';
        }
      } else if (tpHit) {
        finalStatus = 'winner';
      } else if (slHit) {
        finalStatus = 'loser';
      }
      
      // Update or create performance record
      const { error: upsertError } = await supabase
        .from('ai_trade_performance')
        .upsert({
          plan_id: plan.id,
          asset_symbol: plan.asset_symbol,
          bias: plan.bias === 'bullish' ? 'long' : 'short',
          entry_price: plan.entry_price,
          invalidation_level: plan.invalidation_level,
          take_profit_levels: plan.take_profit_levels,
          sl_hit: slHit,
          sl_hit_timestamp: slHit ? new Date().toISOString() : null,
          tp_hit: tpHit,
          tp_hit_timestamp: tpHit ? new Date().toISOString() : null,
          tp_level_hit: tpLevelHit,
          time_to_tp_hours: tpHit ? timeElapsed : null,
          time_to_sl_hours: slHit ? timeElapsed : null,
          whipsaw,
          final_status,
          checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'plan_id'
        });
      
      if (upsertError) {
        console.error(`Error upserting performance for plan ${plan.id}:`, upsertError);
      } else {
        console.log(`✅ Plan ${plan.id}: ${finalStatus} (SL: ${slHit}, TP: ${tpHit})`);
      }
    } catch (error) {
      console.error(`Error processing plan ${plan.id}:`, error);
    }
  }
  
  console.log('✅ Performance check completed');
}

runPerformanceCheck().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
