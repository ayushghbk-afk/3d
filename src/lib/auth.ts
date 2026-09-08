import { Store } from '../state/store.js';
import { cloudEnabled, supabase } from './supabase.js';

export interface SessionUser {
  id: string;
  email: string | null;
  name: string;
  guest: boolean;
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

  async init(): Promise<void> {
    if (!cloudEnabled) {
      this.user.set(guestUser());
      this.loading.set(false);
      return;
    }
    const sb = supabase();
    const { data } = await sb.auth.getSession();
    this.applySession(data.session?.user ?? null);
    sb.auth.onAuthStateChange((_ev, session) => {
      this.applySession(session?.user ?? null);
    });
    this.loading.set(false);
  }

  private applySession(u: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null): void {
    if (!u) {
      this.user.set(null);
      return;
    }
    const meta = u.user_metadata ?? {};
    const name =
      (meta.display_name as string) || (meta.full_name as string) || (u.email ? u.email.split('@')[0] : null) || 'Artist';
    this.user.set({ id: u.id, email: u.email ?? null, name, guest: false });
    // Best-effort profile upsert (never blocks UI)
    supabase()
      .from('profiles')
      .upsert({ id: u.id, email: u.email ?? null, display_name: name })
      .then(() => undefined, () => undefined);
  }

  async signUp(email: string, password: string, name: string): Promise<string | null> {
    const { error } = await supabase().auth.signUp({
      email,
      password,
      options: { data: { display_name: name } },
    });
    return error ? error.message : null;
  }

  async signIn(email: string, password: string): Promise<string | null> {
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }

  async signInMagic(email: string): Promise<string | null> {
    const { error } = await supabase().auth.signInWithOtp({ email });
    return error ? error.message : null;
  }

  async signOut(): Promise<void> {
    if (cloudEnabled) await supabase().auth.signOut();
    this.user.set(cloudEnabled ? null : guestUser());
  }
}

export const auth = new Auth();
