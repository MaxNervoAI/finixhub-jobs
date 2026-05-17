#!/usr/bin/env node
/**
 * Trade Opportunity Scanner
 * Runs every 12 hours to scan BTC, ETH, SOL and generate AI-powered trade scenarios
 */

import { createClient } from '@supabase/supabase-js';

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ASSETS = ['BTC', 'ETH', 'SOL'];

// Initialize Supabase client with service role for write access
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Fetch current price from Binance API
 */
async function fetchCurrentPrice(symbol) {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`);
    if (!response.ok) {
      throw new Error(`Binance API returned ${response.status}`);
    }
    const data = await response.json();
    const price = parseFloat(data.price);
    if (isNaN(price) || price <= 0) {
      throw new Error(`Invalid price for ${symbol}: ${data.price}`);
    }
    return price;
  } catch (error) {
    console.error(`Error fetching price for ${symbol}:`, error);
    // Return a fallback price based on asset symbol
    const fallbackPrices = {
      BTC: 95000,
      ETH: 3500,
      SOL: 150,
      AVAX: 40,
      ADA: 0.5,
      DOT: 7,
      MATIC: 0.8,
      LINK: 15,
      UNI: 10,
      AAVE: 150
    };
    console.warn(`Using fallback price for ${symbol}: $${fallbackPrices[symbol]}`);
    return fallbackPrices[symbol] || 100;
  }
}

/**
 * Fetch technical indicators from asset_daily_summary
 */
async function fetchTechnicalIndicators(symbol) {
  try {
    const { data, error } = await supabase
      .from('asset_daily_summary')
      .select('*')
      .eq('symbol', symbol)
      .order('date', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error fetching technical indicators for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Fetch comprehensive insights
 */
async function fetchComprehensiveInsights(symbol) {
  try {
    const { data, error } = await supabase
      .from('comprehensive_insights')
      .select('*')
      .eq('symbol', symbol)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error(`Error fetching comprehensive insights for ${symbol}:`, error);
    throw error;
  }
}

/**
 * Generate AI-powered trade scenario
 */
async function generateScenario(symbol, bias, technicalData, insights, currentPrice) {
  const prompt = `
    You are an expert trading analyst. Generate a ${bias} trade scenario for ${symbol}.
    
    Current context:
    - Current price: $${currentPrice}
    - Technical indicators: ${JSON.stringify(technicalData)}
    - Market insights: ${JSON.stringify(insights)}
    
    Return JSON with this structure:
    {
      "thesis": "Brief 2-3 sentence thesis explaining the ${bias} setup",
      "entry_price": ${currentPrice},
      "invalidation_level": price_level,
      "take_profit_levels": [tp1, tp2, tp3],
      "confluence_factors": ["factor1", "factor2", "factor3"],
      "confidence_level": 0.0-1.0
    }
    
    Risk/reward should be at least 2:1. Provide realistic price levels.
  `;

  // Use DeepSeek directly
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API failed: ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    // Strip markdown code blocks if present
    const jsonContent = content.replace(/```json\n?/, '').replace(/```\n?/, '').trim();
    const parsed = JSON.parse(jsonContent);
    return parsed;
  } catch (error) {
    console.error('DeepSeek failed:', error);
    throw error;
  }
}

/**
 * Calculate 5-component quality score
 */
function calculateQualityScore(scenario, technicalData, insights) {
  const scores = {
    technical_confluence: 0,
    sentiment_alignment: 0,
    risk_reward_quality: 0,
    entry_quality: 0,
    thesis_quality: 0,
  };

  // Technical confluence (0-1)
  if (technicalData?.sma_20 && technicalData?.sma_50) {
    scores.technical_confluence = 0.8;
  }

  // Sentiment alignment (0-1)
  if (insights?.fear_greed_index) {
    scores.sentiment_alignment = 0.7;
  }

  // Risk/reward quality (0-1)
  const entry = scenario.entry_price;
  const sl = scenario.invalidation_level;
  const tps = scenario.take_profit_levels;
  const rr = tps[0] ? Math.abs(tps[0] - entry) / Math.abs(entry - sl) : 0;
  scores.risk_reward_quality = Math.min(1, rr / 2);

  // Entry quality (0-1)
  scores.entry_quality = 0.8;

  // Thesis quality (0-1)
  scores.thesis_quality = scenario.thesis.length > 50 ? 0.8 : 0.5;

  // Calculate weighted total (0-100)
  const weighted = (
    scores.technical_confluence * 25 +
    scores.sentiment_alignment * 20 +
    scores.risk_reward_quality * 20 +
    scores.entry_quality * 15 +
    scores.thesis_quality * 20
  );

  return {
    total: Math.round(weighted),
    technical_confluence: scores.technical_confluence,
    sentiment_alignment: scores.sentiment_alignment,
    risk_reward_quality: scores.risk_reward_quality,
    entry_quality: scores.entry_quality,
    thesis_quality: scores.thesis_quality,
  };
}

/**
 * Apply contrarian retail interest logic
 */
function applyContrarianLogic(scenarios, insights) {
  const retailInterest = insights?.retail_interest || 0.5;

  return scenarios.map(scenario => {
    // If retail interest is low (<0.4), boost long scenarios
    if (retailInterest < 0.4 && scenario.bias === 'long') {
      scenario.quality_score = Math.min(100, scenario.quality_score + 10);
    }
    // If retail interest is high (>0.6), boost short scenarios
    if (retailInterest > 0.6 && scenario.bias === 'short') {
      scenario.quality_score = Math.min(100, scenario.quality_score + 10);
    }
    return scenario;
  });
}

/**
 * Main scanner function
 */
async function runScanner() {
  console.log('🚀 Starting trade opportunity scanner...');
  const startTime = Date.now();

  const allScenarios = [];

  // Process assets in parallel
  await Promise.all(ASSETS.map(async (symbol) => {
    console.log(`\n📊 Scanning ${symbol}...`);

    try {
      const [currentPrice, technicalData, insights] = await Promise.all([
        fetchCurrentPrice(symbol),
        fetchTechnicalIndicators(symbol),
        fetchComprehensiveInsights(symbol),
      ]);

      console.log(`   Current price: $${currentPrice}`);

      // Generate long and short scenarios
      const [longScenario, shortScenario] = await Promise.all([
        generateScenario(symbol, 'long', technicalData, insights, currentPrice),
        generateScenario(symbol, 'short', technicalData, insights, currentPrice),
      ]);

      // Calculate quality scores
      const longScores = calculateQualityScore(longScenario, technicalData, insights);
      const shortScores = calculateQualityScore(shortScenario, technicalData, insights);

      allScenarios.push({
        asset_symbol: symbol,
        bias: 'long',
        quality_score: longScores.total,
        risk_reward_ratio: longScenario.take_profit_levels[0] 
          ? Math.abs(longScenario.take_profit_levels[0] - longScenario.entry_price) / Math.abs(longScenario.entry_price - longScenario.invalidation_level)
          : 0,
        entry_price: longScenario.entry_price,
        invalidation_level: longScenario.invalidation_level,
        take_profit_levels: longScenario.take_profit_levels,
        thesis: longScenario.thesis,
        confluence_factors: longScenario.confluence_factors,
        confidence_level: longScenario.confidence_level,
        technical_confluence_score: longScores.technical_confluence,
        sentiment_alignment_score: longScores.sentiment_alignment,
        risk_reward_quality_score: longScores.risk_reward_quality,
        entry_quality_score: longScores.entry_quality,
        thesis_quality_score: longScores.thesis_quality,
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString(), // 14 hours
      });

      allScenarios.push({
        asset_symbol: symbol,
        bias: 'short',
        quality_score: shortScores.total,
        risk_reward_ratio: shortScenario.take_profit_levels[0]
          ? Math.abs(shortScenario.take_profit_levels[0] - shortScenario.entry_price) / Math.abs(shortScenario.entry_price - shortScenario.invalidation_level)
          : 0,
        entry_price: shortScenario.entry_price,
        invalidation_level: shortScenario.invalidation_level,
        take_profit_levels: shortScenario.take_profit_levels,
        thesis: shortScenario.thesis,
        confluence_factors: shortScenario.confluence_factors,
        confidence_level: shortScenario.confidence_level,
        technical_confluence_score: shortScores.technical_confluence,
        sentiment_alignment_score: shortScores.sentiment_alignment,
        risk_reward_quality_score: shortScores.risk_reward_quality,
        entry_quality_score: shortScores.entry_quality,
        thesis_quality_score: shortScores.thesis_quality,
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString(),
      });

      console.log(`   ✅ Generated 2 scenarios for ${symbol}`);
    } catch (error) {
      console.error(`   ❌ Failed to scan ${symbol}:`, error);
    }
  }));

  // Apply contrarian retail interest logic
  const adjustedScenarios = applyContrarianLogic(allScenarios, await fetchComprehensiveInsights('BTC'));

  // Rank by quality score
  adjustedScenarios.sort((a, b) => b.quality_score - a.quality_score);
  adjustedScenarios.forEach((scenario, index) => {
    scenario.rank = index + 1;
  });

  // Clear old opportunities
  console.log('\n🗑️  Clearing old opportunities...');
  await supabase.from('trade_opportunities').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Insert new opportunities
  console.log(`\n💾 Inserting ${adjustedScenarios.length} new opportunities...`);
  const { error: insertError } = await supabase.from('trade_opportunities').insert(adjustedScenarios);

  if (insertError) {
    console.error('❌ Failed to insert opportunities:', insertError);
    throw insertError;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n✅ Scanner completed in ${duration}s`);
  console.log(`   Generated ${adjustedScenarios.length} opportunities`);
  console.log(`   Top opportunity: ${adjustedScenarios[0]?.asset_symbol} ${adjustedScenarios[0]?.bias} (${adjustedScenarios[0]?.quality_score}/100)`);
}

// Run scanner with retry logic
async function runWithRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await runScanner();
      return;
    } catch (error) {
      console.error(`\n❌ Attempt ${i + 1} failed:`, error);
      
      if (i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('❌ All retry attempts failed');
        throw error;
      }
    }
  }
}

// Execute
runWithRetry().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
