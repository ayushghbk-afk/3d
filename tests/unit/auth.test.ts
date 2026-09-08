// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  enabled: true,
  getSession: vi.fn(), onAuthStateChange: vi.fn(), signUp: vi.fn(),
  signInWithPassword: vi.fn(), signInWithOtp: vi.fn(), signOut: vi.fn(),
  from: vi.fn(), upsert: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('../../src/lib/supabase.js', () => ({
  get cloudEnabled() { return mock.enabled; },
  supabase: () => ({ auth: mock, from: mock.from }),
}));
let auth: typeof import('../../src/lib/auth.js')['auth'];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  localStorage.clear();
  history.replaceState(null, '', '/3d/#/login');
  mock.enabled = true;
  mock.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mock.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: mock.unsubscribe } } });
  mock.signUp.mockResolvedValue({ data: { session: null }, error: null });
  mock.signInWithOtp.mockResolvedValue({ data: {}, error: null });
  mock.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  mock.signOut.mockResolvedValue({ error: null });
  mock.upsert.mockResolvedValue({ error: null });
  mock.from.mockReturnValue({ upsert: mock.upsert });
  ({ auth } = await import('../../src/lib/auth.js'));
});
afterEach(async () => {
  mock.signOut.mockResolvedValue({ error: null });
  await auth.signOut();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('returns signup confirmation state and the /3d/ callback URL', async () => {
  expect(await auth.signUp('artist@example.com', 'password123', 'Artist'))
    .toEqual({ error: null, needsEmailConfirmation: true });
  expect(mock.signUp).toHaveBeenCalledWith({
    email: 'artist@example.com', password: 'password123',
    options: { data: { display_name: 'Artist' }, emailRedirectTo: 'https://ayushghbk-afk.github.io/3d/' },
  });
});

it('does not ask for confirmation when Supabase returns an active signup session', async () => {
  mock.signUp.mockResolvedValue({ data: { session: { user: { id: 'id' } } }, error: null });
  expect((await auth.signUp('artist@example.com', 'password123', 'Artist')).needsEmailConfirmation).toBe(false);
});

it('sends magic links back to Pages, not the Supabase default localhost URL', async () => {
  await auth.signInMagic('artist@example.com');
  expect(mock.signInWithOtp).toHaveBeenCalledWith({ email: 'artist@example.com', options: { emailRedirectTo: 'https://ayushghbk-afk.github.io/3d/' } });
});

it('ends loading and surfaces session restoration errors', async () => {
  mock.getSession.mockResolvedValue({ data: { session: null }, error: new Error('Session expired') });
  await auth.init();
  expect(auth.loading.get()).toBe(false);
  expect(auth.user.get()).toBe(null);
  expect(auth.error.get()).toBe('Session expired');
});

it('defers profile API calls outside the synchronous auth callback', async () => {
  await auth.init();
  const callback = mock.onAuthStateChange.mock.calls[0][0];
  callback('SIGNED_IN', { user: { id: 'user-id', email: 'artist@example.com', user_metadata: { display_name: 'Artist' } } });
  expect(auth.user.get()?.name).toBe('Artist');
  expect(mock.from).not.toHaveBeenCalled();
  await vi.runOnlyPendingTimersAsync();
  expect(mock.upsert).toHaveBeenCalledWith({ id: 'user-id', email: 'artist@example.com', display_name: 'Artist' });
});

it('keeps a guest identity when cloud is not configured', async () => {
  mock.enabled = false;
  await auth.init();
  expect(auth.user.get()?.guest).toBe(true);
  expect(auth.loading.get()).toBe(false);
  expect(mock.getSession).not.toHaveBeenCalled();
});

it('turns thrown network errors into an inline login error', async () => {
  mock.signInWithPassword.mockRejectedValue(new Error('Network unavailable'));
  expect(await auth.signIn('artist@example.com', 'password123')).toBe('Network unavailable');
});

it('shows expired email-link errors and removes the auth hash', async () => {
  history.replaceState(null, '', '/3d/#error=access_denied&error_description=Email+link+expired');
  await auth.init();
  expect(auth.error.get()).toBe('Email link expired');
  expect(location.hash).toBe('');
});
