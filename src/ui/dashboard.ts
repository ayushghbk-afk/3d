import { auth } from '../lib/auth.js';
import { cloudEnabled, supabase } from '../lib/supabase.js';
import { localDb } from '../lib/indexeddb.js';
import { createProjectDoc, type ProjectDoc, type ProjectMode } from '../state/models.js';
import { escapeHtml, timeAgo } from '../lib/utils.js';
import { toast } from './toast.js';
import { nav } from './router.js';
import { SyncEngine } from '../editor/sync.js';
import { openModal, closeModal } from './modals.js';

interface CardProject {
  id: string;
  name: string;
  mode: ProjectMode;
  updatedAt: string;
  thumbnail: string | null;
  members: number;
  cloud: boolean;
  pending: number;
}

export function mountDashboard(root: HTMLElement): () => void {
  let cancelled = false;
  const unsubs: (() => void)[] = [];

  root.innerHTML = `
    <div class="dash">
      <header class="dash-header">
        <div class="brand"><span class="brand-cube" aria-hidden="true"></span> Web 3D Studio</div>
        <div class="dash-header-right">
          <span id="cloud-badge" class="badge"></span>
          <span id="user-chip" class="user-chip"></span>
          <button id="auth-btn" class="btn btn-ghost"></button>
        </div>
      </header>
      <main class="dash-main">
        <div id="mode-banner"></div>
        <div class="dash-actions">
          <button id="new-project" class="btn btn-primary btn-lg">+ New Project</button>
          <button id="join-btn" class="btn">Join with code</button>
          <button id="gh-import-btn" class="btn">⬢ Import from GitHub</button>
        </div>
        <h2 class="dash-section">Recent Projects</h2>
        <div id="project-grid" class="project-grid"><p class="muted">Loading…</p></div>
      </main>
      <footer class="dash-footer muted">Lightweight 3D creation for the web · local-first · cloud-synced</footer>
    </div>`;

  const badge = root.querySelector('#cloud-badge') as HTMLElement;
  const userChip = root.querySelector('#user-chip') as HTMLElement;
  const authBtn = root.querySelector('#auth-btn') as HTMLButtonElement;

  const refreshAuth = () => {
    const u = auth.user.get();
    badge.textContent = cloudEnabled ? (u && !u.guest ? '● Cloud' : '○ Cloud (signed out)') : '○ Local mode';
    badge.className = `badge ${cloudEnabled && u && !u.guest ? 'badge-ok' : 'badge-dim'}`;
    userChip.textContent = u ? u.name : '';
    authBtn.textContent = u && !u.guest ? 'Sign out' : 'Sign in';
  };
  unsubs.push(auth.user.subscribe(refreshAuth));
  refreshAuth();

  authBtn.onclick = async () => {
    const u = auth.user.get();
    if (u && !u.guest) {
      await auth.signOut();
      toast('Signed out');
      void load();
    } else {
      nav('#/login');
    }
  };

  (root.querySelector('#new-project') as HTMLButtonElement).onclick = () => newProjectModal(() => void load());
  (root.querySelector('#join-btn') as HTMLButtonElement).onclick = () => joinModal();
  (root.querySelector('#gh-import-btn') as HTMLButtonElement).onclick = async () => {
    const u = auth.user.get();
    const doc = createProjectDoc('GitHub Import', 'solo', u?.id ?? 'guest');
    await localDb.saveProject(doc);
    nav(`#/p/${doc.id}?import=github`);
  };

  async function load(): Promise<void> {
    const grid = root.querySelector('#project-grid') as HTMLElement;
    const banner = root.querySelector('#mode-banner') as HTMLElement;
    try {
      const locals = await localDb.listProjects();
      const localById = new Map(locals.map((d) => [d.id, d]));
      const cards: CardProject[] = [];
      const u = auth.user.get();

      if (cloudEnabled && u && !u.guest) {
        const sb = supabase();
        const { data, error } = await sb.from('projects').select('id,name,mode,updated_at,thumbnail_url').order('updated_at', { ascending: false }).limit(50);
        if (error) throw error;
        const rows = (data ?? []) as { id: string; name: string; mode: ProjectMode; updated_at: string; thumbnail_url: string | null }[];
        let counts = new Map<string, number>();
        if (rows.length) {
          const { data: members } = await sb.from('project_members').select('project_id').in('project_id', rows.map((r) => r.id));
          counts = new Map<string, number>();
          for (const m of (members ?? []) as { project_id: string }[]) counts.set(m.project_id, (counts.get(m.project_id) ?? 0) + 1);
        }
        for (const r of rows) {
          const local = localById.get(r.id);
          localById.delete(r.id);
          const queue = await localDb.listQueue(r.id);
          cards.push({
            id: r.id, name: r.name, mode: r.mode,
            updatedAt: local && local.updatedAt > r.updated_at ? local.updatedAt : r.updated_at,
            thumbnail: local?.thumbnail ?? null, members: counts.get(r.id) ?? 1,
            cloud: true, pending: queue.length,
          });
        }
      }
      // local-only projects (or everything in local mode)
      for (const d of localById.values()) {
        const queue = await localDb.listQueue(d.id);
        cards.push({
          id: d.id, name: d.name, mode: d.mode, updatedAt: d.updatedAt,
          thumbnail: d.thumbnail, members: 1, cloud: false, pending: queue.length,
        });
      }
      cards.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

      const pendingTotal = cards.reduce((a, c) => a + c.pending, 0);
      banner.innerHTML =
        !cloudEnabled
          ? `<div class="banner banner-info">Local mode — projects save on this device. Add Supabase keys (see README) for cloud sync & teams.</div>`
          : pendingTotal > 0
            ? `<div class="banner banner-warn">⚠ ${pendingTotal} change(s) waiting to sync. <button class="btn btn-sm" id="sync-now">Sync now</button></div>`
            : '';
      const syncBtn = banner.querySelector('#sync-now') as HTMLButtonElement | null;
      if (syncBtn) syncBtn.onclick = () => toast('Open a project to sync its pending changes');

      if (!cards.length) {
        grid.innerHTML = `<div class="empty"><p>No projects yet.</p><p class="muted">Create one to start modeling — phone, tablet or desktop.</p></div>`;
        return;
      }
      grid.innerHTML = cards
        .map(
          (c) => `
        <article class="card" data-id="${c.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(c.name)}">
          <div class="card-thumb">${c.thumbnail ? `<img src="${c.thumbnail}" alt="" />` : '<span class="card-thumb-ph">⬢</span>'}</div>
          <div class="card-body">
            <div class="card-title">${escapeHtml(c.name)}</div>
            <div class="card-meta">
              <span class="badge ${c.mode === 'team' ? 'badge-team' : ''}">${c.mode === 'team' ? `👥 Team · ${c.members}` : '👤 Solo'}</span>
              <span class="muted">${timeAgo(c.updatedAt)}</span>
              ${c.pending ? `<span class="badge badge-warn">${c.pending} pending</span>` : ''}
              ${!c.cloud && cloudEnabled ? '<span class="badge badge-dim">local</span>' : ''}
            </div>
          </div>
          <button class="btn btn-icon card-del" data-del="${c.id}" aria-label="Delete ${escapeHtml(c.name)}">🗑</button>
        </article>`,
        )
        .join('');
      grid.querySelectorAll('.card').forEach((el) => {
        const id = (el as HTMLElement).dataset.id as string;
        el.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-del]')) return;
          nav(`#/p/${id}`);
        });
        el.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') nav(`#/p/${id}`);
        });
      });
      grid.querySelectorAll('[data-del]').forEach((el) => {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = (el as HTMLElement).dataset.del as string;
          if (!confirm('Delete this project? (Local copy is removed; cloud copy is removed if you own it.)')) return;
          await localDb.deleteProject(id);
          if (cloudEnabled && auth.user.get() && !auth.user.get()?.guest) {
            await supabase().from('projects').delete().eq('id', id);
          }
          toast('Project deleted', 'success');
          void load();
        });
      });
    } catch (e) {
      if (!cancelled) grid.innerHTML = `<p class="error">Failed to load projects: ${escapeHtml((e as Error).message)}</p>`;
    }
  }
  void load();

  return () => {
    cancelled = true;
    unsubs.forEach((u) => u());
  };
}

function newProjectModal(onDone: () => void): void {
  const u = auth.user.get();
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="field">Name
      <input id="np-name" class="input" value="Untitled Project" maxlength="80" />
    </label>
    <div class="field">Mode
      <div class="radio-row">
        <label><input type="radio" name="np-mode" value="solo" checked /> 👤 Solo</label>
        <label><input type="radio" name="np-mode" value="team" /> 👥 Team</label>
      </div>
      <p class="muted small">Team projects need a cloud account. You can invite members from the editor.</p>
    </div>`;
  openModal({
    title: 'New Project',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Create', kind: 'primary',
        onClick: async () => {
          const name = (body.querySelector('#np-name') as HTMLInputElement).value.trim() || 'Untitled Project';
          const mode = (body.querySelector('input[name=np-mode]:checked') as HTMLInputElement).value as ProjectMode;
          if (mode === 'team' && (!cloudEnabled || !u || u.guest)) {
            toast('Sign in with a cloud account to create team projects', 'warn');
            nav('#/login');
            return;
          }
          const doc: ProjectDoc = createProjectDoc(name, mode, u?.id ?? 'guest');
          await localDb.saveProject(doc);
          closeModal();
          onDone();
          nav(`#/p/${doc.id}`);
        },
      },
    ],
  });
}

function joinModal(): void {
  if (!cloudEnabled || !auth.user.get() || auth.user.get()?.guest) {
    toast('Sign in with a cloud account to join a team project', 'warn');
    nav('#/login');
    return;
  }
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="field">Invite link or code
      <input id="join-input" class="input" placeholder="Paste invite link…" />
    </label>`;
  openModal({
    title: 'Join team project',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Join', kind: 'primary',
        onClick: async () => {
          const raw = (body.querySelector('#join-input') as HTMLInputElement).value.trim();
          const m = raw.match(/join\/([0-9a-f-]{8,})[^a-zA-Z0-9]*code=([A-Za-z0-9-]+)/) || raw.match(/^([0-9a-f-]{36})[:/](.+)$/);
          if (!m) {
            toast('Paste a full invite link from the project owner', 'error');
            return;
          }
          const [, projectId, code] = m;
          const err = await SyncEngine.joinWithCode(projectId, code);
          if (err) {
            toast(`Join failed: ${err}`, 'error');
            return;
          }
          closeModal();
          toast('Joined project', 'success');
          nav(`#/p/${projectId}`);
        },
      },
    ],
  });
}

export async function handleJoinRoute(projectId: string, code: string): Promise<void> {
  if (!cloudEnabled) {
    toast('Join links need cloud mode', 'error');
    nav('#/');
    return;
  }
  if (!auth.user.get() || auth.user.get()?.guest) {
    nav('#/login');
    toast('Sign in first, then open the invite link again', 'warn');
    return;
  }
  const err = await SyncEngine.joinWithCode(projectId, code);
  if (err) toast(`Join failed: ${err}`, 'error');
  else toast('Joined project', 'success');
  nav(err ? '#/' : `#/p/${projectId}`);
}

export function mountLogin(root: HTMLElement): () => void {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand"><span class="brand-cube" aria-hidden="true"></span> Web 3D Studio</div>
        <div id="auth-forms"></div>
        <button id="back-btn" class="btn btn-ghost">← Back</button>
      </div>
    </div>`;
  (root.querySelector('#back-btn') as HTMLButtonElement).onclick = () => nav('#/');
  const forms = root.querySelector('#auth-forms') as HTMLElement;

  if (!cloudEnabled) {
    forms.innerHTML = `
      <div class="banner banner-info">Cloud is not configured — the app runs in <b>local mode</b>.
      Add <code>VITE_SUPABASE_URL</code> + <code>VITE_SUPABASE_ANON_KEY</code> (see README) to enable accounts & teams.</div>
      <button id="guest-btn" class="btn btn-primary">Continue as Guest</button>`;
    (forms.querySelector('#guest-btn') as HTMLButtonElement).onclick = () => nav('#/');
    return () => undefined;
  }

  forms.innerHTML = `
    <div class="tabs">
      <button class="tab active" data-tab="in">Sign in</button>
      <button class="tab" data-tab="up">Sign up</button>
      <button class="tab" data-tab="magic">Magic link</button>
    </div>
    <div id="tab-body"></div>
    <p id="auth-err" class="error"></p>`;
  const tabBody = forms.querySelector('#tab-body') as HTMLElement;
  const errEl = forms.querySelector('#auth-err') as HTMLElement;
  let tab = 'in';

  const render = () => {
    errEl.textContent = '';
    tabBody.innerHTML = `
      ${tab === 'up' ? '<label class="field">Display name<input id="a-name" class="input" autocomplete="nickname" /></label>' : ''}
      <label class="field">Email<input id="a-email" class="input" type="email" autocomplete="email" /></label>
      ${tab !== 'magic' ? '<label class="field">Password<input id="a-pass" class="input" type="password" autocomplete="current-password" /></label>' : ''}
      <button id="a-go" class="btn btn-primary btn-block">${tab === 'in' ? 'Sign in' : tab === 'up' ? 'Create account' : 'Send magic link'}</button>`;
    (tabBody.querySelector('#a-go') as HTMLButtonElement).onclick = async () => {
      const email = (tabBody.querySelector('#a-email') as HTMLInputElement).value.trim();
      if (!email) {
        errEl.textContent = 'Email is required';
        return;
      }
      let err: string | null = null;
      if (tab === 'in') {
        const pass = (tabBody.querySelector('#a-pass') as HTMLInputElement).value;
        err = await auth.signIn(email, pass);
      } else if (tab === 'up') {
        const pass = (tabBody.querySelector('#a-pass') as HTMLInputElement).value;
        const name = (tabBody.querySelector('#a-name') as HTMLInputElement).value.trim() || email.split('@')[0];
        if (pass.length < 6) {
          errEl.textContent = 'Password needs at least 6 characters';
          return;
        }
        err = await auth.signUp(email, pass, name);
      } else {
        err = await auth.signInMagic(email);
        if (!err) toast('Check your email for the magic link', 'success');
      }
      if (err) errEl.textContent = err;
      else if (tab !== 'magic') nav('#/');
    };
  };
  forms.querySelectorAll('.tab').forEach((t) =>
    (t as HTMLButtonElement).onclick = () => {
      forms.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      tab = (t as HTMLElement).dataset.tab as string;
      render();
    },
  );
  render();
  const unsub = auth.user.subscribe((u) => {
    if (u && !u.guest) nav('#/');
  });
  return () => unsub();
}
