import { describe, it, expect } from 'vitest';
import { readSupabaseConfig } from '../../src/lib/cloud-config.js';
import { appUrl } from '../../src/lib/app-url.js';
import { cloudErrorMessage } from '../../src/lib/cloud-errors.js';

const url = 'https://example.supabase.co';
const key = 'sb_publishable_browser_safe_test';
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.signature`;

describe('Supabase public configuration', () => {
  it('keeps unconfigured development in local mode', () => {
    expect(readSupabaseConfig({})).toMatchObject({ enabled: false, error: null });
  });
  it('accepts and trims modern publishable keys', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: ` ${url}/ `, VITE_SUPABASE_PUBLISHABLE_KEY: ` ${key} ` }))
      .toEqual({ url, key, enabled: true, error: null });
  });
  it('continues supporting legacy anon keys', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: jwt('anon') }).enabled).toBe(true);
  });
  it('prefers publishable over a legacy anon key', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key, VITE_SUPABASE_ANON_KEY: jwt('anon') }).key).toBe(key);
  });
  it.each(['sb_secret_do_not_expose', jwt('service_role'), 'not-a-key'])('rejects non-public/invalid keys without echoing them: %s', (badKey) => {
    const result = readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: badKey });
    expect(result.enabled).toBe(false);
    expect(result.error).toMatch(/only a Supabase publishable key/);
    expect(JSON.stringify(result)).not.toContain(badKey);
  });
  it('rejects a private key even in the lower-priority legacy field', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key, VITE_SUPABASE_ANON_KEY: jwt('service_role') }).enabled).toBe(false);
  });
  it.each([{ VITE_SUPABASE_URL: url }, { VITE_SUPABASE_PUBLISHABLE_KEY: key }])('reports incomplete configuration', (env) => {
    expect(readSupabaseConfig(env).error).toMatch(/Set both/);
  });
  it.each(['not a url', 'javascript:alert(1)', 'https://user:password@example.com', `${url}?key=oops`, `${url}#hash`])('rejects invalid project URL %s', (badUrl) => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: badUrl, VITE_SUPABASE_PUBLISHABLE_KEY: key }).enabled).toBe(false);
  });
});

describe('Pages auth return URLs', () => {
  it.each([
    ['https://ayushghbk-afk.github.io/3d/#/login', 'https://ayushghbk-afk.github.io/3d/'],
    ['https://ayushghbk-afk.github.io/3d/?code=sensitive#/join/id?code=invite', 'https://ayushghbk-afk.github.io/3d/'],
    ['https://example.com/index.html#access_token=sensitive', 'https://example.com/'],
    ['http://localhost:5173/#/login', 'http://localhost:5173/'],
  ])('uses the deployment directory for %s', (href, expected) => {
    expect(appUrl(href)).toBe(expected);
  });
});

it('turns missing-schema errors into actionable setup guidance', () => {
  expect(cloudErrorMessage({ code: 'PGRST205', message: 'Missing projects' })).toContain('supabase/migrations');
});
