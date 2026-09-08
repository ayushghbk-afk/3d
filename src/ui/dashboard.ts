import { auth } from '../lib/auth.js';
import { cloudEnabled, cloudConfigError, supabase } from '../lib/supabase.js';
import { cloudErrorMessage } from '../lib/cloud-errors.js';
import { localDb } from '../lib/indexeddb.js';
import { createProjectDoc, createStarterProjectDoc, type ProjectDoc, type ProjectMode, type StarterTemplate } from '../state/models.js';
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
        <section class="dash-hero">
          <div class="dash-hero-copy">
            <span class="dash-kicker">Browser-based 3D creation</span>
            <h1>Make something visible in minutes, not after decoding 80 controls.</h1>
            <p class="muted">Start from a scene, a product mockup, or jump straight into AI. The workflow is simple: create → position → style → preview → export.</p>
            <div class="dash-actions">
              <button id="new-project" class="btn btn-primary btn-lg">Start blank</button>
              <button id="join-btn" class="btn">Join with code</button>
              <button id="gh-import-btn" class="btn">⬢ Import from GitHub</button>
            </div>
            <div class="dash-flow" aria-label="Suggested beginner workflow">
              <span>Create</span>
              <span>Position</span>
              <span>Style</span>
              <span>Preview</span>
              <span>Export</span>
            </div>
          </div>
          <div class="hero-preview" aria-hidden="true">
            <div class="hero-stage"></div>
            <div class="hero-orb hero-orb-a"></div>
            <div class="hero-orb hero-orb-b"></div>
            <div class="hero-shape hero-shape-cube"></div>
            <div class="hero-shape hero-shape-torus"></div>
            <div class="hero-shape hero-shape-pill"></div>
            <div class="hero-glow"></div>
          </div>
        </section>
        <div id="mode-banner"></div>
        <section class="starter-strip">
          <div class="starter-head row-between">
            <div>
              <span class="dash-kicker">Starter scenes</span>
              <h2 class="dash-section">Pick a first success</h2>
            </div>
            <span class="muted small">Each option opens a project you can edit right away.</span>
          </div>
          <div class="starter-grid">
            ${starterCard('product', 'Create a product mockup', 'A lit stage with a stylized product object so you can focus on positioning and materials.', 'Launch mockup')}
            ${starterCard('lowpoly', 'Make a low-poly scene', 'A tiny scene with ground, cabin, tree, and lighting to remix into your own world.', 'Open scene')}
            ${starterCard('blank', 'Generate with AI', 'Start with a clean scene and open AI Studio immediately with prompt examples ready.', 'Open AI Studio', true)}
          </div>
        </section>
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
      try {
        await auth.signOut();
        toast('Signed out');
        void load();
      } catch (e) {
        toast(cloudErrorMessage(e), 'error');
      }
    } else {
      nav('#/login');
    }
  };

  const createStarter = async (template: StarterTemplate, name: string, openAi = false, mode: ProjectMode = 'solo'): Promise<void> => {
    const u = auth.user.get();
    const doc = createStarterProjectDoc(name, mode, u?.id ?? 'guest', template);
    await localDb.saveProject(doc);
    nav(`#/p/${doc.id}${openAi ? '?open=ai' : ''}`);
  };

  (root.querySelector('#new-project') as HTMLButtonElement).onclick = () => newProjectModal(() => void load());
  (root.querySelector('#join-btn') as HTMLButtonElement).onclick = () => joinModal();
  (root.querySelector('#gh-import-btn') as HTMLButtonElement).onclick = async () => {
    const u = auth.user.get();
    const doc = createProjectDoc('GitHub Import', 'solo', u?.id ?? 'guest');
    await localDb.saveProject(doc);
    nav(`#/p/${doc.id}?import=github`);
  };
  root.querySelectorAll<HTMLElement>('[data-create-template]').forEach((btn) => {
    btn.onclick = () => {
      const template = (btn.dataset.createTemplate as StarterTemplate) || 'blank';
      const openAi = btn.dataset.openAi === 'true';
      const label = btn.dataset.projectName || 'Untitled Project';
      void createStarter(template, label, openAi);
    };
  });

  async function load(): Promise<void> {
    const grid = root.querySelector('#project-grid') as HTMLElement;
    const banner = root.querySelector('#mode-banner') as HTMLElement;
    try {
      const locals = await localDb.listProjects();
      const localById = new Map(locals.map((d) => [d.id, d]));
      const cards: CardProject[] = [];
      let cloudFailure: string | null = null;
      const u = auth.user.get();

      if (cloudEnabled && u && !u.guest) {
        try {
          const sb = supabase();
          const { data, error } = await sb.from('projects').select('id,name,mode,updated_at,thumbnail_url').order('updated_at', { ascending: false }).limit(50);
          if (error) throw error;
          const rows = (data ?? []) as { id: string; name: string; mode: ProjectMode; updated_at: string; thumbnail_url: string | null }[];
          let counts = new Map<string, number>();
          if (rows.length) {
            const { data: members, error: membersError } = await sb.from('project_members').select('project_id').in('project_id', rows.map((r) => r.id));
            if (membersError) throw membersError;
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
              thumbnail: local?.thumbnail ?? r.thumbnail_url ?? null, members: counts.get(r.id) ?? 1,
              cloud: true, pending: queue.length,
            });
          }
        } catch (e) {
          cloudFailure = cloudErrorMessage(e);
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

      if (cancelled) return;
      const pendingTotal = cards.reduce((a, c) => a + c.pending, 0);
      const warning = cloudFailure || cloudConfigError || auth.error.get();
      banner.innerHTML = warning
        ? `<div class="banner banner-warn">${escapeHtml(warning)} <button class="btn btn-sm" id="retry-cloud">Retry</button></div>`
        : !cloudEnabled
          ? `<div class="banner banner-info">Local mode — projects save on this device. Add Supabase public configuration (see README) for cloud sync & teams.</div>`
          : !u || u.guest
            ? `<div class="banner banner-info">Sign in to sync projects across devices and collaborate. Until then, projects save on this device only.</div>`
            : pendingTotal > 0
              ? `<div class="banner banner-warn">⚠ ${pendingTotal} change(s) waiting to sync. <button class="btn btn-sm" id="sync-now">Sync now</button></div>`
              : '';
      const retryBtn = banner.querySelector('#retry-cloud') as HTMLButtonElement | null;
      if (retryBtn) retryBtn.onclick = () => void load();
      if (cloudFailure) {
        badge.textContent = '⚠ Cloud unavailable';
        badge.className = 'badge badge-warn';
      } else refreshAuth();
      const syncBtn = banner.querySelector('#sync-now') as HTMLButtonElement | null;
      if (syncBtn) syncBtn.onclick = () => toast('Open a project to sync its pending changes');

      if (!cards.length) {
        grid.innerHTML = `
          <div class="empty empty-rich">
            <p class="empty-title">No projects yet — start with something you can see.</p>
            <p class="muted">Try a starter scene above, or create a blank project if you already know what you want.</p>
          </div>`;
        return;
      }
      grid.innerHTML = cards
        .map(
          (c) => `
        <article class="card" data-id="${c.id}" tabindex="0" role="button" aria-label="Open ${escapeHtml(c.name)}">
          <div class="card-thumb">${c.thumbnail ? `<img src="${escapeHtml(c.thumbnail)}" alt="" />` : '<span class="card-thumb-ph">⬢</span>'}</div>
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
          try {
            if (cloudEnabled && auth.user.get() && !auth.user.get()?.guest && cards.find((c) => c.id === id)?.cloud) {
              const { data, error } = await supabase().from('projects').delete().eq('id', id).select('id');
              if (error) throw error;
              if (!data?.length) throw new Error('Only a project owner or admin can delete this cloud project.');
            }
            await localDb.deleteProject(id);
            await localDb.clearQueue((await localDb.listQueue(id)).map((op) => op.id));
            toast('Project deleted', 'success');
            void load();
          } catch (e) {
            toast(cloudErrorMessage(e), 'error');
          }
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
  let template: StarterTemplate = 'blank';
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
    </div>
    <div class="field">
      <span class="field-label">Starter scene</span>
      <div class="starter-grid starter-grid-modal">
        ${starterChoice('blank', 'Blank canvas', 'Start from an empty scene and add objects yourself.')}
        ${starterChoice('product', 'Product mockup', 'A staged object and lighting so styling and camera work feel immediate.')}
        ${starterChoice('lowpoly', 'Low-poly scene', 'A tiny world to remix instead of staring at an empty viewport.')}
      </div>
    </div>`;
  body.querySelectorAll<HTMLElement>('[data-starter-choice]').forEach((card) => {
    card.onclick = () => {
      template = (card.dataset.starterChoice as StarterTemplate) || 'blank';
      body.querySelectorAll('[data-starter-choice]').forEach((x) => x.classList.remove('selected'));
      card.classList.add('selected');
    };
  });
  body.querySelector('[data-starter-choice="blank"]')?.classList.add('selected');
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
          const doc: ProjectDoc = createStarterProjectDoc(name, mode, u?.id ?? 'guest', template);
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

function starterCard(template: StarterTemplate, title: string, desc: string, cta: string, openAi = false): string {
  return `
    <article class="starter-card">
      <span class="badge badge-dim">${openAi ? 'AI-assisted' : template === 'blank' ? 'Blank' : 'Starter scene'}</span>
      <h3>${escapeHtml(title)}</h3>
      <p class="muted">${escapeHtml(desc)}</p>
      <button class="btn ${openAi ? 'btn-primary' : ''}" data-create-template="${template}" data-open-ai="${openAi}" data-project-name="${escapeHtml(title)}">${escapeHtml(cta)}</button>
    </article>`;
}

function starterChoice(template: StarterTemplate, title: string, desc: string): string {
  return `
    <button type="button" class="starter-choice" data-starter-choice="${template}">
      <strong>${escapeHtml(title)}</strong>
      <span class="muted small">${escapeHtml(desc)}</span>
    </button>`;
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
      <div class="banner banner-info">${cloudConfigError ? escapeHtml(cloudConfigError) : `Cloud is not configured — the app runs in <b>local mode</b>.
      Add <code>VITE_SUPABASE_URL</code> + <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> (see docs/DEPLOYMENT.md) to enable accounts & teams.`}</div>
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
    <p id="auth-err" class="error" role="alert"></p>
    <p id="auth-info" class="muted" role="status"></p>`;
  const tabBody = forms.querySelector('#tab-body') as HTMLElement;
  const errEl = forms.querySelector('#auth-err') as HTMLElement;
  const infoEl = forms.querySelector('#auth-info') as HTMLElement;
  let tab = 'in';
  let pending = false;
  let disposed = false;

  const render = () => {
    errEl.textContent = auth.error.get() ?? '';
    infoEl.textContent = '';
    tabBody.innerHTML = `
      <form id="auth-form">
        ${tab === 'up' ? '<label class="field">Display name<input id="a-name" class="input" autocomplete="nickname" maxlength="80" /></label>' : ''}
        <label class="field">Email<input id="a-email" class="input" type="email" autocomplete="email" required /></label>
        ${tab !== 'magic' ? `<label class="field">Password<input id="a-pass" class="input" type="password" autocomplete="${tab === 'up' ? 'new-password' : 'current-password'}" ${tab === 'up' ? 'minlength="6"' : ''} required /></label>` : ''}
        <button id="a-go" type="submit" class="btn btn-primary btn-block">${tab === 'in' ? 'Sign in' : tab === 'up' ? 'Create account' : 'Send magic link'}</button>
      </form>`;
    (tabBody.querySelector('#auth-form') as HTMLFormElement).onsubmit = async (event) => {
      event.preventDefault();
      if (pending) return;
      const email = (tabBody.querySelector('#a-email') as HTMLInputElement).value.trim();
      if (!email) {
        errEl.textContent = 'Email is required';
        return;
      }
      const submit = tabBody.querySelector('#a-go') as HTMLButtonElement;
      const originalLabel = submit.textContent;
      pending = true;
      submit.disabled = true;
      submit.textContent = 'Please wait…';
      forms.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => { t.disabled = true; });
      errEl.textContent = '';
      infoEl.textContent = '';
      try {
        if (tab === 'in') {
          const pass = (tabBody.querySelector('#a-pass') as HTMLInputElement).value;
          const error = await auth.signIn(email, pass);
          if (disposed) return;
          if (error) errEl.textContent = error;
          else nav('#/');
        } else if (tab === 'up') {
          const pass = (tabBody.querySelector('#a-pass') as HTMLInputElement).value;
          const name = (tabBody.querySelector('#a-name') as HTMLInputElement).value.trim() || email.split('@')[0];
          const result = await auth.signUp(email, pass, name);
          if (disposed) return;
          if (result.error) errEl.textContent = result.error;
          else if (result.needsEmailConfirmation) {
            infoEl.textContent = 'Check your email to confirm your account, then sign in. Check spam too if the email does not arrive.';
          } else nav('#/');
        } else {
          const error = await auth.signInMagic(email);
          if (disposed) return;
          if (error) errEl.textContent = error;
          else infoEl.textContent = 'Check your email for the magic link. It will bring you back to this app.';
        }
      } catch (e) {
        if (!disposed) errEl.textContent = cloudErrorMessage(e);
      } finally {
        pending = false;
        if (!disposed) {
          submit.disabled = false;
          submit.textContent = originalLabel;
          forms.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => { t.disabled = false; });
        }
      }
    };
  };
  forms.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
    t.onclick = () => {
      if (pending) return;
      forms.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      tab = t.dataset.tab as string;
      render();
    };
  });
  render();
  const unsub = auth.user.subscribe((u) => {
    if (u && !u.guest) nav('#/');
  });
  return () => {
    disposed = true;
    unsub();
  };
}
