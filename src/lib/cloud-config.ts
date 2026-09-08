export interface SupabaseEnv {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Legacy browser-safe JWT key; still supported. */
  VITE_SUPABASE_ANON_KEY?: string;
}

export interface SupabaseConfig {
  url: string;
  key: string;
  enabled: boolean;
  error: string | null;
}

/** Shared by Vite (before bundling) and the browser. Never include a key in errors. */
export function readSupabaseConfig(env: SupabaseEnv): SupabaseConfig {
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '') ?? '';
  const publishable = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  const anon = env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  const key = publishable || anon;
  const invalid = (error: string): SupabaseConfig => ({ url: '', key: '', enabled: false, error });

  if (!url && !key) return { url: '', key: '', enabled: false, error: null };
  if (!url || !key) {
    return invalid('Set both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or the legacy VITE_SUPABASE_ANON_KEY), or leave both empty for local mode.');
  }
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Invalid URL');
    }
  } catch {
    return invalid('VITE_SUPABASE_URL must be your Supabase project HTTP(S) URL, without credentials, a query, or a hash.');
  }

  // Validate BOTH fields, even if one takes precedence: Vite exposes all VITE_* values.
  for (const candidate of [publishable, anon].filter(Boolean)) {
    if (candidate.startsWith('sb_publishable_') && candidate.length > 'sb_publishable_'.length) continue;
    try {
      const parts = candidate.split('.');
      if (parts.length !== 3) throw new Error('Not a JWT');
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role === 'anon') continue;
    } catch {
      // Return the same safe error for invalid, secret, and service-role keys.
    }
    return invalid('Use only a Supabase publishable key (sb_publishable_…) or legacy anon key. Secret and service-role keys must never be used in this frontend.');
  }
  return { url, key, enabled: true, error: null };
}
