// =====================================================================
// config.js – the only file with settings.
// The anon/publishable key is PUBLIC by design (safe to put on GitHub).
// NEVER put the "service_role" key anywhere in this project.
// =====================================================================

export const SUPABASE_URL = 'https://zhmjkypilsczwknmatak.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_colgDUQi2m1G0RXLgK-JPA_2EPmMF9G';

// Words that get masked (****) in messages before sending. Add your own.
export const BAD_WORDS = [
  'damn', 'stupid', 'idiot', 'dumb', 'hate', 'shut up', 'loser', 'trash'
];
