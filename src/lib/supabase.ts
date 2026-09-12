import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readSupabaseConfig } from './cloud-config.js';

const config = readSupabaseConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
});
export const cloudEnabled = config.enabled;
export const cloudConfigError = config.error;
/**
 * Validated public config (URL + browser key). Both values are already shipped
 * to every browser in the bundle; exposed for the cloud diagnostics probes.
 * Never write `key` into a log, toast or report — use `keyKind()` instead.
 */
export const cloudConfig = config;

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!cloudEnabled) throw new Error(config.error ?? 'Supabase is not configured (local mode).');
    client = createClient(config.url, config.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
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
