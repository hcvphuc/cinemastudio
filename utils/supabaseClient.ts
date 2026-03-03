import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta as any).env.VITE_SUPABASE_URL || 'https://dummy.supabase.co';
const supabaseAnonKey = (import.meta as any).env.VITE_SUPABASE_ANON_KEY || 'dummy_key';

if (supabaseUrl === 'https://dummy.supabase.co') {
    console.warn('Supabase URL or Anon Key is missing. Using dummy values for now. Please check your .env.local file.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
