// Supabase Client Configuration - Lazy initialization for serverless
let _supabase = null;
let _supabaseAdmin = null;

// Custom fetch with timeout
const fetchWithTimeout = (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
};

function getSupabase() {
  if (!_supabase) {
    require('dotenv').config();
    const { createClient } = require('@supabase/supabase-js');
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn('⚠️  Supabase credentials not found in .env file');
      console.warn('   Please configure SUPABASE_URL and SUPABASE_ANON_KEY');
    }

    _supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { fetch: fetchWithTimeout }
    });

    if (supabaseServiceKey) {
      _supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { fetch: fetchWithTimeout }
      });
    } else {
      _supabaseAdmin = _supabase;
    }
  }
  return _supabase;
}

function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    getSupabase(); // ensures both are initialized
  }
  return _supabaseAdmin;
}

module.exports = { getSupabase, getSupabaseAdmin };