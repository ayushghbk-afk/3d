import { test, expect } from '@playwright/test';

// Authentication responses are mocked: these tests never create real accounts,
// send emails, or write to the user's live Supabase project.
test('loads only built assets within the GitHub Pages directory', async ({ page, request }) => {
  const errors: string[] = [];
  const assets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (req) => { if (/\.(js|css)(\?|$)/.test(req.url())) assets.push(new URL(req.url()).pathname); });
  await page.goto('./');
  await expect(page.locator('#cloud-badge')).toContainText('Cloud (signed out)');
  await expect(page.getByRole('button', { name: 'Start blank', exact: true })).toBeVisible();
  expect(assets.length).toBeGreaterThan(1);
  expect(assets.every((path) => path.startsWith('/3d/assets/'))).toBe(true);
  expect(errors).toEqual([]);
  expect((await request.get('/assets/not-a-real-file.js')).status()).toBe(404);
  expect((await request.get('/3d/src/main.ts')).status()).toBe(404);
  expect((await request.get('/3d/.nojekyll')).status()).toBe(200);
  const manifest = await (await request.get('/3d/manifest.webmanifest')).json();
  expect(manifest.start_url).toBe('./');
  expect((await request.get('/3d/icons/icon.svg')).status()).toBe(200);
  await page.goto('./#/login');
  await page.reload();
  await expect(page.locator('#auth-form')).toBeVisible();
});

test('creates a local project, loads the lazy editor, and reopens it offline under /3d/', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await page.getByRole('button', { name: 'Start blank', exact: true }).click();
  await page.locator('#np-name').fill('Pages smoke test');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('#tb-name')).toContainText('Pages smoke test');
  await page.locator('#rail [data-prim="cube"]').click();
  await expect(page.locator('.out-row')).toHaveCount(1);
  await page.keyboard.press('Control+s');
  await expect(page.locator('#tb-save')).toContainText('Local');
  // Wait for the IndexedDB transaction to commit, not an arbitrary timeout.
  await expect.poll(() => page.evaluate(async () => {
    const id = location.hash.split('/')[2];
    return new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('web3dstudio');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('projects', 'readonly').objectStore('projects').get(id);
        read.onsuccess = () => { resolve(read.result?.objects?.length ?? 0); db.close(); };
      };
    });
  })).toBe(1);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.locator('.out-row')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).toContain('/3d/sw.js');
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#tb-name')).toContainText('Pages smoke test');
  await expect(page.locator('.out-row')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('signup clearly asks for email confirmation and returns to the Pages URL', async ({ page }) => {
  let redirect: string | null = null;
  let body: Record<string, unknown> = {};
  await page.route('https://*.supabase.co/auth/v1/signup**', async (route) => {
    redirect = new URL(route.request().url()).searchParams.get('redirect_to');
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: '00000000-0000-4000-8000-000000000001', email: 'artist@example.com',
      aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(),
      app_metadata: {}, user_metadata: { display_name: 'Artist' }, identities: [],
    }) });
  });
  await page.goto('./#/login');
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.locator('#a-email').fill('artist@example.com');
  await page.locator('#a-name').fill('Artist');
  await page.locator('#a-pass').fill('testing-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.locator('#auth-info')).toContainText('Check your email to confirm');
  await expect(page).toHaveURL(/#\/login$/);
  expect(redirect).toBe('http://127.0.0.1:4174/3d/');
  expect(body.email).toBe('artist@example.com');
  await expect(page.locator('#a-go')).toBeEnabled();
});

test('magic links use the correct callback and failures stay visible/retryable', async ({ page }) => {
  let redirect: string | null = null;
  await page.route('https://*.supabase.co/auth/v1/otp**', async (route) => {
    redirect = new URL(route.request().url()).searchParams.get('redirect_to');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('https://*.supabase.co/auth/v1/token**', async (route) => {
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'invalid_credentials', msg: 'Invalid login credentials' }) });
  });
  await page.goto('./#/login');
  await page.getByRole('button', { name: 'Magic link', exact: true }).click();
  await page.locator('#a-email').fill('artist@example.com');
  await page.locator('#a-email').press('Enter');
  await expect(page.locator('#auth-info')).toContainText('Check your email for the magic link');
  expect(redirect).toBe('http://127.0.0.1:4174/3d/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.locator('#a-email').fill('artist@example.com');
  await page.locator('#a-pass').fill('wrong-password');
  await page.locator('#a-go').click();
  await expect(page.locator('#auth-err')).toContainText('Invalid login credentials');
  await expect(page.locator('#a-go')).toBeEnabled();
});

test('an unavailable cloud schema does not hide existing local projects after sign-in', async ({ page }) => {
  await page.route('https://*.supabase.co/rest/v1/**', async (route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.projects' }) });
  });
  await page.route('https://*.supabase.co/auth/v1/token**', async (route) => {
    const payload = { sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'test-refresh-token',
      user: { id: payload.sub, aud: 'authenticated', role: 'authenticated', email: 'artist@example.com', app_metadata: {}, user_metadata: {} },
    }) });
  });
  await page.goto('./');
  await page.evaluate(async () => {
    const request = indexedDB.open('web3dstudio');
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        tx.objectStore('projects').put({
          id: '30000000-0000-4000-8000-000000000001', name: 'Safe local project', mode: 'solo',
          ownerId: 'guest', thumbnail: null, objects: [], materials: [], clips: [], assets: [],
          settings: { envIntensity: 1, shadows: true }, updatedAt: new Date().toISOString(), version: 1, cloudVersion: 0,
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto('./#/login');
  await page.locator('#a-email').fill('artist@example.com');
  await page.locator('#a-pass').fill('testing-password-123');
  await page.locator('#a-go').click();
  await expect(page.locator('#mode-banner')).toContainText('Supabase database setup is incomplete');
  await expect(page.locator('.card-title')).toHaveText('Safe local project');
  await expect(page.locator('#retry-cloud')).toBeVisible();
});

test('restores an email-link session at /3d/ and persists it after refresh', async ({ page }) => {
  const id = '00000000-0000-4000-8000-000000000001';
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = { sub: id, role: 'authenticated', aud: 'authenticated', exp: expires, iat: expires - 3600 };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
  const user = { id, aud: 'authenticated', role: 'authenticated', email: 'artist@example.com', app_metadata: {}, user_metadata: { display_name: 'Email Artist' } };
  await page.route('https://*.supabase.co/auth/v1/user**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) }));
  await page.route('https://*.supabase.co/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const hash = new URLSearchParams({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: '3600', expires_at: String(expires), type: 'signup' });
  await page.goto(`./#${hash}`);
  await expect(page.locator('#user-chip')).toHaveText('Email Artist');
  await expect(page.locator('#cloud-badge')).toHaveText('● Cloud');
  expect(new URL(page.url()).pathname).toBe('/3d/');
  expect(new URL(page.url()).hash).not.toContain('access_token');
  await page.reload();
  await expect(page.locator('#user-chip')).toHaveText('Email Artist');
});
