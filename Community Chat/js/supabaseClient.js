// =====================================================================
// supabaseClient.js – creates the ONE connection to Supabase.
// Every other file imports `supabase` from here.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

if (SUPABASE_URL.includes('YOUR-') || SUPABASE_ANON_KEY.includes('YOUR-')) {
  throw new Error('Open js/config.js and paste your Supabase URL and anon key.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } }
});