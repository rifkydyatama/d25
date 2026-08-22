// Supabase Client Configuration
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️  Supabase credentials not found in .env file');
  console.warn('   Please configure SUPABASE_URL and SUPABASE_ANON_KEY');
}

// Public client (for client-side operations with RLS)
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin client (for server-side operations bypassing RLS)
const supabaseAdmin = supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : supabase;

module.exports = { supabase, supabaseAdmin };