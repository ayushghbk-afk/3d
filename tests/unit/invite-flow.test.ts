// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../../src/lib/auth';

const mocks = vi.hoisted(() => ({
  joinWithCode: vi.fn(),
  signIn: vi.fn(),
  user: null as import('../../src/lib/auth').SessionUser | null,
  listeners: new Set<(u: import('../../src/lib/auth').SessionUser | null) => void>(),
  setUser(u: import('../../src/lib/auth').SessionUser | null): void {
    mocks.user = u;
    for (const fn of [...mocks.listeners]) fn(u);
  },
}));
vi.mock('../../src/lib/supabase.js', () => ({ cloudEnabled: true, cloudConfigError: null, supabase: () => { throw new Error('not used'); }, trySupabase: () => null }));
vi.mock('../../src/lib/auth.js', () => ({
  auth: {
    user: {
      get: () => mocks.user,
      subscribe(fn: (u: import('../../src/lib/auth').SessionUser | null) => void) {
        mocks.listeners.add(fn);
        fn(mocks.user);
        return () => mocks.listeners.delete(fn);
      },
    },
    error: { get: () => null },
    signIn: mocks.signIn,
  },
}));
vi.mock('../../src/lib/indexeddb.js', () => ({ localDb: {} }));
vi.mock('../../src/editor/sync.js', () => ({ SyncEngine: { joinWithCode: mocks.joinWithCode } }));
import { handleJoinRoute, mountLogin, resumePendingInviteIfSignedIn } from '../../src/ui/dashboard';

const signedIn: SessionUser = { id: '00000000-0000-4000-8000-000000000009', email: 'invitee@example.com', name: 'Invitee', guest: false };

beforeEach(() => {
  mocks.joinWithCode.mockReset();
  mocks.user = null;
  window.location.hash = '#/';
  sessionStorage.clear();
  document.body.innerHTML = '<div id="toast-root"></div><div id="modal-root"></div><div id="app"></div>';
});

describe('invite join route', () => {
  it('sends the link id and code to the join RPC and opens the project', async () => {
    mocks.user = signedIn;
    mocks.joinWithCode.mockResolvedValue(null);
    await handleJoinRoute('40000000-0000-4000-8000-000000000001', 'abc12345');
    expect(mocks.joinWithCode).toHaveBeenCalledWith('40000000-0000-4000-8000-000000000001', 'abc12345');
    expect(window.location.hash).toBe('#/p/40000000-0000-4000-8000-000000000001');
  });

  it('returns to the dashboard and keeps the error readable when joining fails', async () => {
    mocks.user = signedIn;
    mocks.joinWithCode.mockResolvedValue('Invalid invite code');
    await handleJoinRoute('40000000-0000-4000-8000-000000000001', 'wrong');
    expect(window.location.hash).toBe('#/');
    expect(document.querySelector('.toast-error')?.textContent).toContain('Join failed: Invalid invite code');
  });

  it('sends unsigned visitors to login and remembers the invite', async () => {
    await handleJoinRoute('40000000-0000-4000-8000-000000000001', 'abc12345');
    expect(mocks.joinWithCode).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/login');
    expect(JSON.parse(sessionStorage.getItem('w3ds.pendingInvite') ?? 'null')).toEqual({
      projectId: '40000000-0000-4000-8000-000000000001',
      code: 'abc12345',
    });
  });

  it('resumes the remembered invite once the user is signed in', () => {
    sessionStorage.setItem('w3ds.pendingInvite', JSON.stringify({ projectId: '40000000-0000-4000-8000-000000000001', code: 'abc12345' }));
    // Signed out: nothing happens yet.
    expect(resumePendingInviteIfSignedIn()).toBe(false);
    expect(window.location.hash).toBe('#/');
    mocks.user = signedIn;
    expect(resumePendingInviteIfSignedIn()).toBe(true);
    expect(window.location.hash).toBe('#/join/40000000-0000-4000-8000-000000000001?code=abc12345');
    // Consumed: a later visit must not bounce the user back.
    expect(sessionStorage.getItem('w3ds.pendingInvite')).toBeNull();
    expect(resumePendingInviteIfSignedIn()).toBe(false);
  });

  it('ignores a corrupted remembered invite instead of navigating somewhere broken', () => {
    sessionStorage.setItem('w3ds.pendingInvite', '{not json');
    mocks.user = signedIn;
    expect(resumePendingInviteIfSignedIn()).toBe(false);
    expect(window.location.hash).toBe('#/');
  });

  it('resumes the remembered invite on the login page after a successful sign-in', async () => {
    sessionStorage.setItem('w3ds.pendingInvite', JSON.stringify({ projectId: '40000000-0000-4000-8000-000000000001', code: 'abc12345' }));
    window.location.hash = '#/login';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const dispose = mountLogin(root);
    // Signing in fires the auth subscriber (as onAuthStateChange does live).
    mocks.signIn.mockImplementation(async () => {
      mocks.setUser(signedIn);
      return null;
    });
    (root.querySelector('#a-email') as HTMLInputElement).value = 'invitee@example.com';
    (root.querySelector('#a-pass') as HTMLInputElement).value = 'testing-password-123';
    (root.querySelector('#auth-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(window.location.hash).toBe('#/join/40000000-0000-4000-8000-000000000001?code=abc12345');
    });
    expect(sessionStorage.getItem('w3ds.pendingInvite')).toBeNull();
    dispose();
  });

  it('sends a signed-in login visitor to the dashboard when no invite is pending', () => {
    window.location.hash = '#/login';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const dispose = mountLogin(root);
    mocks.setUser(signedIn);
    expect(window.location.hash).toBe('#/');
    dispose();
  });
});
