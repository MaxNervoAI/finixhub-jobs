#!/usr/bin/env node

/**
 * Ephemeral RSS News Scraper
 * 
 * Parses crypto RSS feeds, extracts article metadata with sentiment analysis,
 * and inserts ONLY metadata to Supabase (no full content stored for copyright compliance).
 * 
 * Libraries:
 * - rss-parser: RSS feed parsing
 * - @supabase/supabase-js: Database operations
 * - vader-sentiment: Sentiment analysis
 * - @mozilla/readability + jsdom: Clean text extraction (in-memory only)
 */

import Parser from 'rss-parser';
import { createClient } from '@supabase/supabase-js';
import Sentiment from 'sentiment';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const RSS_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { name: 'Bitcoin.com', url: 'https://news.bitcoin.com/feed/' }
];

const SYMBOL_DICTIONARY = {
  'bitcoin': 'BTC',
  'btc': 'BTC',
  'ethereum': 'ETH',
  'ether': 'ETH',
  'eth': 'ETH',
  'solana': 'SOL',
  'sol': 'SOL',
  'etf': 'ETF'
};

const ARTICLES_PER_FEED = 10;
const SENTIMENT_THRESHOLD = 0.05;

// --------------------------------------------------------------------------
// Initialize Clients
// --------------------------------------------------------------------------

const parser = new Parser();
const sentiment = new Sentiment();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --------------------------------------------------------------------------
// Helper Functions
// --------------------------------------------------------------------------

/**
 * Fetch full HTML from article URL
 */
async function fetchArticleHtml(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      console.log(`  ⚠️  Failed to fetch HTML: ${response.status}`);
      return null;
    }

    return await response.text();
  } catch (error) {
    console.log(`  ⚠️  Error fetching HTML: ${error.message}`);
    return null;
  }
}

/**
 * Extract clean article text using Mozilla Readability
 * This is ephemeral - text is processed in memory and discarded
 */
function extractArticleText(html) {
  try {
    const dom = new JSDOM(html, { url: 'http://example.com' });
    const document = dom.window.document;
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) {
      console.log('  ⚠️  Readability failed to parse article');
      return null;
    }

    return article.textContent;
  } catch (error) {
    console.log(`  ⚠️  Error extracting text: ${error.message}`);
    return null;
  }
}

/**
 * Run sentiment analysis on text
 */
function analyzeSentiment(text) {
  const result = sentiment.analyze(text);
  const score = result.score;

  if (score > SENTIMENT_THRESHOLD) {
    return 'positive';
  } else if (score < -SENTIMENT_THRESHOLD) {
    return 'negative';
  } else {
    return 'neutral';
  }
}

/**
 * Scan text for crypto ticker symbols
 */
function extractRelatedSymbols(text) {
  const lowerText = text.toLowerCase();
  const symbols = new Set();

  for (const [keyword, symbol] of Object.entries(SYMBOL_DICTIONARY)) {
    if (lowerText.includes(keyword)) {
      symbols.add(symbol);
    }
  }

  return Array.from(symbols);
}

/**
 * Detect if article is breaking news
 */
function isBreaking(title) {
  return /\b(BREAKING|URGENT|JUST IN)\b/i.test(title);
}

/**
 * Extract image URL from RSS item
 */
function extractImageUrl(item) {
  // Try different RSS feed image fields
  if (item.enclosure && item.enclosure.url && item.enclosure.type?.startsWith('image/')) {
    return item.enclosure.url;
  }
  if (item.image) {
    return item.image;
  }
  if (item['media:content']) {
    return item['media:content'].$?.url || item['media:content'];
  }
  if (item['media:thumbnail']) {
    return item['media:thumbnail'].$?.url || item['media:thumbnail'];
  }
  
  // Try to extract from content:encoded HTML
  if (item['content:encoded'] || item.content) {
    const html = item['content:encoded'] || item.content;
    const imgMatch = html.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
    if (imgMatch && imgMatch[1]) {
      return imgMatch[1];
    }
  }

  // Try to extract from description HTML (CoinDesk uses this)
  if (item.description) {
    const imgMatch = item.description.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
    if (imgMatch && imgMatch[1]) {
      return imgMatch[1];
    }
  }

  // Try og:image from content
  if (item['content:encoded'] || item.content) {
    const html = item['content:encoded'] || item.content;
    const ogImageMatch = html.match(/<meta[^>]+property=['"]og:image['"][^>]+content=['"]([^'"]+)['"]/i);
    if (ogImageMatch && ogImageMatch[1]) {
      return ogImageMatch[1];
    }
  }
  
  return null;
}

/**
 * Determine category from title and content
 */
function detectCategory(title, content = '') {
  const combined = (title + ' ' + content).toLowerCase();

  // Count occurrences of each symbol to determine primary category
  const symbolCounts = {
    'bitcoin': (combined.match(/bitcoin/g) || []).length + (combined.match(/btc/g) || []).length,
    'ethereum': (combined.match(/ethereum/g) || []).length + (combined.match(/eth/g) || []).length + (combined.match(/ether/g) || []).length,
    'solana': (combined.match(/solana/g) || []).length + (combined.match(/sol/g) || []).length,
  };

  // Return the symbol with highest count (prioritize title mentions)
  const titleLower = title.toLowerCase();
  const titleCounts = {
    'bitcoin': (titleLower.match(/bitcoin/g) || []).length + (titleLower.match(/btc/g) || []).length,
    'ethereum': (titleLower.match(/ethereum/g) || []).length + (titleLower.match(/eth/g) || []).length + (titleLower.match(/ether/g) || []).length,
    'solana': (titleLower.match(/solana/g) || []).length + (titleLower.match(/sol/g) || []).length,
  };

  // Check title first for primary symbol
  if (titleCounts.ethereum > 0) return 'Ethereum';
  if (titleCounts.bitcoin > 0) return 'Bitcoin';
  if (titleCounts.solana > 0) return 'Solana';

  // Then check overall counts
  if (symbolCounts.ethereum > symbolCounts.bitcoin && symbolCounts.ethereum > symbolCounts.solana) return 'Ethereum';
  if (symbolCounts.bitcoin > symbolCounts.ethereum && symbolCounts.bitcoin > symbolCounts.solana) return 'Bitcoin';
  if (symbolCounts.solana > symbolCounts.bitcoin && symbolCounts.solana > symbolCounts.ethereum) return 'Solana';

  // Fallback to keyword checks for other categories
  if (combined.includes('defi') || combined.includes('finance')) return 'DeFi';
  if (combined.includes('nft') || combined.includes('collectible')) return 'NFT';
  if (combined.includes('sec') || combined.includes('regulation') || combined.includes('law')) return 'Regulation';
  if (combined.includes('mining') || combined.includes('miner')) return 'Mining';
  if (combined.includes('trading') || combined.includes('price') || combined.includes('market')) return 'Trading';
  if (combined.includes('tech') || combined.includes('development') || combined.includes('upgrade')) return 'Technology';

  return 'Markets';
}

// --------------------------------------------------------------------------
// Main Processing
// --------------------------------------------------------------------------

async function processFeed(feed) {
  console.log(`\n📰 Processing ${feed.name}...`);
  console.log(`   URL: ${feed.url}`);

  try {
    const feedData = await parser.parseURL(feed.url);
    console.log(`   ✅ Fetched ${feedData.items.length} items from RSS`);

    // Take top N articles
    const items = feedData.items.slice(0, ARTICLES_PER_FEED);
    console.log(`   📋 Processing ${items.length} articles (limit: ${ARTICLES_PER_FEED})`);

    let newArticles = 0;
    let updatedArticles = 0;
    let errorArticles = 0;

    for (const item of items) {
      if (!item.link || !item.title) {
        console.log(`   ⚠️  Skipping item without link or title`);
        errorArticles++;
        continue;
      }

      console.log(`\n   📄 Article: ${item.title.substring(0, 60)}...`);
      console.log(`      ✓ Processing article...`);

      // Fetch full HTML
      const html = await fetchArticleHtml(item.link);
      if (!html) {
        console.log(`      ✗ Failed to fetch HTML, skipping`);
        errorArticles++;
        continue;
      }

      console.log(`      ✓ Fetched HTML (${html.length} chars)`);

      // Extract clean text (ephemeral - in memory only)
      const cleanText = extractArticleText(html);
      if (!cleanText) {
        console.log(`      ✗ Failed to extract text, skipping`);
        errorArticles++;
        continue;
      }

      console.log(`      ✓ Extracted clean text (${cleanText.length} chars)`);

      // Run sentiment analysis
      const sentimentResult = analyzeSentiment(cleanText);
      console.log(`      ✓ Sentiment: ${sentimentResult}`);

      // Extract related symbols
      const relatedSymbols = extractRelatedSymbols(item.title + ' ' + cleanText);
      console.log(`      ✓ Related symbols: ${relatedSymbols.join(', ') || 'none'}`);

      // Determine category
      const category = detectCategory(item.title, cleanText);
      console.log(`      ✓ Category: ${category}`);

      // Extract image URL
      const imageUrl = extractImageUrl(item);
      if (imageUrl) {
        console.log(`      ✓ Image URL: ${imageUrl.substring(0, 60)}...`);
      }

      // Prepare metadata for insertion
      const articleData = {
        title: item.title,
        source: feed.name,
        category: category,
        excerpt: item.contentSnippet?.substring(0, 300) || '',
        url: item.link,
        image_url: imageUrl,
        author: item.creator || item.author || feed.name,
        related_symbols: relatedSymbols,
        sentiment: sentimentResult,
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        is_breaking: isBreaking(item.title),
        is_featured: false,
        view_count: 0
      };

      // Upsert to Supabase (insert or update if exists)
      const { error: upsertError } = await supabase
        .from('news_articles')
        .upsert(articleData, { onConflict: 'url' });

      if (upsertError) {
        console.log(`      ✗ Upsert failed: ${upsertError.message}`);
        errorArticles++;
      } else {
        console.log(`      ✓ Upserted successfully`);
        newArticles++;
      }

      // Discard clean text from memory (ephemeral)
      // No need to explicitly delete in Node.js, GC handles it
    }

    console.log(`\n   📊 ${feed.name} summary:`);
    console.log(`      Upserted: ${newArticles}`);
    console.log(`      Errors: ${errorArticles}`);

    return { upserted: newArticles, errors: errorArticles };

  } catch (error) {
    console.log(`   ❌ Error processing ${feed.name}: ${error.message}`);
    return { upserted: 0, errors: 1 };
  }
}

// --------------------------------------------------------------------------
// Main Entry Point
// --------------------------------------------------------------------------

async function main() {
  console.log('🚀 Starting RSS News Scraper');
  console.log('='.repeat(60));
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Feeds: ${RSS_FEEDS.length}`);
  console.log(`Articles per feed: ${ARTICLES_PER_FEED}`);
  console.log('='.repeat(60));

  const startTime = Date.now();

  let totalUpserted = 0;
  let totalErrors = 0;

  for (const feed of RSS_FEEDS) {
    const result = await processFeed(feed);
    totalUpserted += result.upserted;
    totalErrors += result.errors;
  }

  const duration = Date.now() - startTime;

  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total upserted: ${totalUpserted}`);
  console.log(`Total errors: ${totalErrors}`);
  console.log(`Duration: ${(duration / 1000).toFixed(2)}s`);
  console.log('='.repeat(60));

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
