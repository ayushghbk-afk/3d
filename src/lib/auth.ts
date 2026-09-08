import { Store } from '../state/store.js';
import { cloudEnabled, supabase } from './supabase.js';
import { appUrl } from './app-url.js';
import { cloudErrorMessage } from './cloud-errors.js';

export interface SessionUser {
  id: string;
  email: string | null;
  name: string;
  guest: boolean;
}

export interface SignUpResult {
  error: string | null;
  needsEmailConfirmation: boolean;
}

const GUEST_KEY = 'w3ds.guest';

function guestUser(): SessionUser {
  let id = localStorage.getItem(GUEST_KEY);
  if (!id) {
    id = `guest-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(GUEST_KEY, id);
  }
  return { id, email: null, name: 'Guest', guest: true };
}

class Auth {
  user = new Store<SessionUser | null>(null);
  loading = new Store<boolean>(true);
  error = new Store<string | null>(null);
  private subscription: { unsubscribe(): void } | null = null;
  private profileTimer: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.loading.set(true);
    this.error.set(null);
    try {
      if (!cloudEnabled) {
        this.user.set(guestUser());
        return;
      }
      const sb = supabase();
      const { data } = sb.auth.onAuthStateChange((_ev, session) => {
        // Do not await or call another Supabase API inside this callback:
        // the auth client still holds its session lock.
        this.applySession(session?.user ?? null);
      });
      this.subscription = data.subscription;
      const { data: sessionData, error } = await sb.auth.getSession();
      if (error) throw error;
      this.applySession(sessionData.session?.user ?? null);

      // Expired/denied email links must not silently look like a signed-out success.
      const params = new URLSearchParams(window.location.hash.slice(1));
      if (params.has('error_description')) {
        this.error.set(params.get('error_description'));
        history.replaceState(null, '', appUrl());
      }
    } catch (e) {
      this.error.set(cloudErrorMessage(e));
      this.user.set(null);
    } finally {
      // A failed/expired session must never leave startup stuck on "Loading".
      this.loading.set(false);
    }
  }

  private applySession(u: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null): void {
    if (this.profileTimer) clearTimeout(this.profileTimer);
    this.profileTimer = null;
    if (!u) {
      this.user.set(null);
      return;
    }
    this.error.set(null);
    const meta = u.user_metadata ?? {};
    const name =
      (meta.display_name as string) || (meta.full_name as string) || (u.email ? u.email.split('@')[0] : null) || 'Artist';
    this.user.set({ id: u.id, email: u.email ?? null, name, guest: false });
    // Defer I/O until AFTER onAuthStateChange has released its lock.
    // Profile errors are non-fatal, but no longer silently discarded.
    this.profileTimer = setTimeout(() => {
      this.profileTimer = null;
      if (this.user.get()?.id !== u.id) return;
      void supabase().from('profiles')
        .upsert({ id: u.id, email: u.email ?? null, display_name: name })
        .then(({ error }) => {
          if (error) console.warn('Profile sync failed:', cloudErrorMessage(error));
        }, (error) => console.warn('Profile sync failed:', cloudErrorMessage(error)));
    }, 0);
  }

  async signUp(email: string, password: string, name: string): Promise<SignUpResult> {
    try {
      const { data, error } = await supabase().auth.signUp({
        email,
        password,
        options: { data: { display_name: name }, emailRedirectTo: appUrl() },
      });
      return { error: error?.message ?? null, needsEmailConfirmation: !error && !data.session };
    } catch (e) {
      return { error: cloudErrorMessage(e), needsEmailConfirmation: false };
    }
  }

  async signIn(email: string, password: string): Promise<string | null> {
    try {
      const { error } = await supabase().auth.signInWithPassword({ email, password });
      return error?.message ?? null;
    } catch (e) {
      return cloudErrorMessage(e);
    }
  }

  async signInMagic(email: string): Promise<string | null> {
    try {
      const { error } = await supabase().auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl() } });
      return error?.message ?? null;
    } catch (e) {
      return cloudErrorMessage(e);
    }
  }

  async signOut(): Promise<void> {
    if (cloudEnabled) {
      const { error } = await supabase().auth.signOut();
      if (error) throw error;
    }
    this.applySession(null);
    this.user.set(cloudEnabled ? null : guestUser());
  }
}

export const auth = new Auth();
