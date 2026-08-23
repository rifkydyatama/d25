// Supabase Client Configuration - Lazy initialization for serverless
let _supabase = null;
let _supabaseAdmin = null;

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

    _supabase = createClient(supabaseUrl, supabaseAnonKey);

    if (supabaseServiceKey) {
      _supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });
    } else {
      _supabaseAdmin = _supabase;
    }
  }
  return _supabase;
}

function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    getSupabase();
  }
  return _supabaseAdmin;
}

module.exports = { getSupabase, getSupabaseAdmin };