/**
 * fetch-fear-greed.ts
 * 
 * Fetches the Fear & Greed Index from Alternative.me 
 * and updates all asset_daily_summary records for today.
 * 
 * Usage: npx tsx scripts/fetch-fear-greed.ts
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    // Validate env
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const today = new Date().toISOString().split('T')[0];

    console.log(`🚀 Fetching Fear & Greed Index for ${today}...`);

    try {
        const response = await fetch('https://api.alternative.me/fng/?limit=1');

        if (!response.ok) {
            throw new Error(`Failed to fetch Fear & Greed data: ${response.status}`);
        }

        const data = await response.json();

        if (!data?.data?.[0]) {
            throw new Error('Invalid Fear & Greed data format');
        }

        const fearGreedValue = parseInt(data.data[0].value);
        const classification = data.data[0].value_classification;

        console.log(`  Value: ${fearGreedValue} (${classification})`);

        // Update all records for today
        const { count, error } = await supabase
            .from('asset_daily_summary')
            .update({
                fear_greed_index: fearGreedValue,
                updated_at: new Date().toISOString()
            })
            .eq('date', today);

        if (error) {
            console.error('  ❌ Database update error:', error.message);
        } else {
            console.log(`✅ Updated ${count || 0} records with Fear & Greed Index.`);
        }

    } catch (error: any) {
        console.error('💥 Fatal error:', error.message);
        process.exit(1);
    }
}

main().then(() => process.exit(0)).catch((err) => { console.error('💥 Fatal:', err); process.exit(1); });
