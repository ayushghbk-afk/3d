import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const cloudEnabled = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!cloudEnabled) throw new Error('Supabase is not configured (local mode).');
    client = createClient(url as string, anonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 30 } },
    });
  }
  return client;
}

export function trySupabase(): SupabaseClient | null {
  try {
    return cloudEnabled ? supabase() : null;
  } catch {
    return null;
  }
}
