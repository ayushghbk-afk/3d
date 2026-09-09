import type { EditorSession } from '../editor/session.js';
import { cloudEnabled } from '../lib/supabase.js';
import { auth } from '../lib/auth.js';
import { localDb } from '../lib/indexeddb.js';
import type { TeamRole } from '../state/models.js';
import { timeAgo, escapeHtml } from '../lib/utils.js';
import { toast } from './toast.js';
import { nav } from './router.js';
import { openModal, closeModal } from './modals.js';
import {
  ghConnected, ghViewer, setGhToken, startDeviceFlow, pollDeviceToken,
  listRepos, listBranches, getTree, detectProject, importStudioProject, importLooseAssets,
  ensureRepo, commitExport, type GhRepo, type GhBranch, type GhTreeItem, type DetectedProject,
} from '../github/github.js';

// ---------- members & invites ----------
export function openMembersModal(s: EditorSession): void {
  if (!cloudEnabled) {
    toast('Members need cloud mode — add Supabase keys first', 'warn');
    return;
  }
  const body = document.createElement('div');
  body.innerHTML = '<p class="muted">Loading members…</p>';
  openModal({ title: 'Members & invites', body, wide: true });

  void (async () => {
    const members = await s.sync.listMembers();
    const peers = new Map(s.peers.get().map((p) => [p.id, p]));
    const me = auth.user.get();
    let code = await s.sync.getInviteCode();
    body.innerHTML = `
      <div class="member-list">
        ${members.map((m) => `
          <div class="member-row">
            <span class="peer" style="--c:${peers.get(m.userId)?.color ?? '#666'}">●</span>
            <span class="member-name">${escapeHtml(m.name ?? m.userId.slice(0, 8))}${m.userId === me?.id ? ' (you)' : ''}</span>
            <select class="input input-sm" data-role="${m.userId}">
              ${(['owner', 'admin', 'editor', 'animator', 'viewer'] as TeamRole[]).map((r) => `<option${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}
            </select>
            <button class="btn btn-sm" data-rm="${m.userId}">Remove</button>
          </div>`).join('')}
      </div>
      <div class="panel-sub">Invite link</div>
      <p class="small muted">Anyone with this link joins as <b>viewer</b> (you can promote them above). Rotate to invalidate old links.</p>
      <div class="row-between">
        <code id="invite-link" class="code small">${code ? inviteUrl(s.doc.id, code) : '(disabled)'}</code>
      </div>
      <div class="row-between" style="margin-top:8px">
        <button class="btn btn-sm" id="copy-invite" ${code ? '' : 'disabled'}>Copy link</button>
        <button class="btn btn-sm" id="rotate-invite">${code ? 'Rotate code' : 'Enable invites'}</button>
      </div>
      <div class="panel-sub">Add by user id</div>
      <div class="row-between">
        <input id="add-id" class="input input-sm" placeholder="User UUID (their Profile id)" style="flex:1" />
        <button class="btn btn-sm" id="add-btn">Add editor</button>
      </div>`;

    body.querySelectorAll('[data-role]').forEach((sel) => {
      (sel as HTMLSelectElement).onchange = async (e) => {
        const ok = await s.sync.setRole((sel as HTMLElement).dataset.role as string, (e.target as HTMLSelectElement).value as TeamRole);
        toast(ok ? 'Role updated' : 'Not allowed — admins only', ok ? 'success' : 'error');
      };
    });
    body.querySelectorAll('[data-rm]').forEach((btn) => {
      (btn as HTMLButtonElement).onclick = async () => {
        if (!confirm('Remove this member?')) return;
        const ok = await s.sync.removeMember((btn as HTMLElement).dataset.rm as string);
        toast(ok ? 'Member removed' : 'Not allowed', ok ? 'success' : 'error');
        if (ok) openMembersModal(s);
      };
    });
    (body.querySelector('#copy-invite') as HTMLButtonElement).onclick = async () => {
      if (!code) return;
      await navigator.clipboard.writeText(inviteUrl(s.doc.id, code)).catch(() => undefined);
      toast('Invite link copied', 'success');
    };
    (body.querySelector('#rotate-invite') as HTMLButtonElement).onclick = async () => {
      const c = await s.sync.rotateInviteCode();
      if (!c) {
        toast('Not allowed — admins only', 'error');
        return;
      }
      code = c;
      (body.querySelector('#invite-link') as HTMLElement).textContent = inviteUrl(s.doc.id, c);
      (body.querySelector('#copy-invite') as HTMLButtonElement).disabled = false;
      (body.querySelector('#rotate-invite') as HTMLButtonElement).textContent = 'Rotate code';
    };
    (body.querySelector('#add-btn') as HTMLButtonElement).onclick = async () => {
      const id = (body.querySelector('#add-id') as HTMLInputElement).value.trim();
      if (!id) return;
      const err = await s.sync.addMemberById(id, 'editor');
      if (err) toast(`Add failed: ${err}`, 'error');
      else {
        toast('Member added', 'success');
        openMembersModal(s);
      }
    };
  })();
}

function inviteUrl(projectId: string, code: string): string {
  return `${location.origin}${location.pathname}#/join/${projectId}?code=${code}`;
}

// ---------- versions ----------
export function openVersionsModal(s: EditorSession): void {
  if (!cloudEnabled) {
    toast('Version history needs cloud mode', 'warn');
    return;
  }
  const body = document.createElement('div');
  body.innerHTML = '<p class="muted">Loading versions…</p>';
  openModal({
    title: 'Version history', body,
    actions: [
      { label: 'Close', kind: 'ghost' },
      {
        label: '＋ Checkpoint', kind: 'primary', keepOpen: true,
        onClick: async () => {
          const label = prompt('Checkpoint label', `Checkpoint ${new Date().toLocaleString()}`);
          if (label === null) return;
          const ok = await s.sync.createCheckpoint(label);
          toast(ok ? 'Checkpoint saved' : 'Checkpoint failed', ok ? 'success' : 'error');
          openVersionsModal(s);
        },
      },
    ],
  });
  void (async () => {
    const versions = await s.sync.listVersions();
    body.innerHTML = versions.length
      ? `<div class="member-list">${versions.map((v) => `
        <div class="member-row">
          <span class="badge">v${v.version}</span>
          <span class="member-name">${escapeHtml(v.label || 'Untitled')}<br /><span class="muted small">${timeAgo(v.createdAt)}</span></span>
          <button class="btn btn-sm" data-restore="${v.id}">Restore</button>
        </div>`).join('')}</div>`
      : '<p class="muted">No checkpoints yet — create one to snapshot this project.</p>';
    body.querySelectorAll('[data-restore]').forEach((btn) => {
      (btn as HTMLButtonElement).onclick = async () => {
        if (!confirm('Restore this version? Current state stays in undo history.')) return;
        const ok = await s.sync.restoreVersion((btn as HTMLElement).dataset.restore as string);
        toast(ok ? 'Version restored' : 'Restore failed', ok ? 'success' : 'error');
        closeModal();
      };
    });
  })();
}

// ---------- shortcuts ----------
export function openShortcutsModal(): void {
  const rows: [string, string][] = [
    ['W / E / R', 'Move / Rotate / Scale gizmo'],
    ['V', 'Deselect'],
    ['F', 'Focus selected'],
    ['Delete', 'Delete selected'],
    ['Ctrl/⌘ + D', 'Duplicate'],
    ['Ctrl/⌘ + Z', 'Undo'],
    ['Ctrl/⌘ + Shift + Z', 'Redo'],
    ['Ctrl/⌘ + S', 'Save now'],
    ['Space', 'Play / pause'],
    ['A', 'Toggle ✨ AI Studio (draggable, resizable)'],
    ['J', 'Toggle Scripts (control meshes, keyframes, camera)'],
    ['F11 / ⛶', 'Fullscreen — hide browser chrome; tools auto-hide when idle'],
    ['Esc', 'Show tools, or exit fullscreen'],
    ['Drag panel edges', 'Resize outliner / inspector / timeline'],
    ['Double-click panel edge', 'Collapse / restore panel'],
    ['1-finger drag', 'Orbit (touch)'],
    ['2-finger', 'Pan + pinch zoom (touch)'],
    ['Tap', 'Select (touch)'],
  ];
  openModal({
    title: 'Keyboard & touch',
    body: `<table class="keys">${rows.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table>`,
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

// =====================================================================
// GITHUB IMPORT (§38-39)
// =====================================================================
export function openGithubImport(s: EditorSession): void {
  const body = document.createElement('div');
  body.className = 'gh-modal';
  openModal({ title: 'Import from GitHub', body, wide: true });
  renderGhImport(s, body);
}

function renderGhImport(s: EditorSession, body: HTMLElement): void {
  if (!ghConnected()) {
    renderGhConnect(body, () => renderGhImport(s, body));
    return;
  }
  body.innerHTML = `
    <div class="row-between">
      <span id="gh-user" class="muted small">…</span>
      <button class="btn btn-sm" id="gh-disconnect">Disconnect</button>
    </div>
    <label class="field">🔍 Search repositories
      <div class="row-between">
        <input id="gh-q" class="input" placeholder="Leave empty for your repos…" style="flex:1" />
        <button class="btn btn-sm" id="gh-search">Search</button>
      </div>
    </label>
    <div id="gh-repos" class="gh-repos"><p class="muted">Loading…</p></div>
    <div id="gh-detail"></div>`;
  (body.querySelector('#gh-disconnect') as HTMLButtonElement).onclick = () => {
    setGhToken(null);
    renderGhImport(s, body);
  };
  void ghViewer().then((v) => {
    (body.querySelector('#gh-user') as HTMLElement).textContent = v ? `Connected as ${v.login}` : 'Connected';
  });
  const doSearch = async () => {
    const q = (body.querySelector('#gh-q') as HTMLInputElement).value;
    const list = body.querySelector('#gh-repos') as HTMLElement;
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const repos = await listRepos(q);
      if (!repos.length) {
        list.innerHTML = '<p class="muted">No repositories found.</p>';
        return;
      }
      list.innerHTML = repos.map((r) => `
        <button class="gh-repo" data-repo="${escapeHtml(r.fullName)}">
          <span>📁 ${escapeHtml(r.fullName)}${r.private ? ' 🔒' : ''}</span>
          <span class="muted small">${timeAgo(r.updatedAt)}</span>
        </button>`).join('');
      list.querySelectorAll('[data-repo]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => {
          const repo = repos.find((r) => r.fullName === (b as HTMLElement).dataset.repo) as GhRepo;
          renderGhRepoDetail(s, body, repo);
        };
      });
    } catch (e) {
      list.innerHTML = `<p class="error">${escapeHtml((e as Error).message)}</p>`;
    }
  };
  (body.querySelector('#gh-search') as HTMLButtonElement).onclick = () => void doSearch();
  (body.querySelector('#gh-q') as HTMLInputElement).onkeydown = (e) => {
    if (e.key === 'Enter') void doSearch();
  };
  void doSearch();
}

function renderGhRepoDetail(s: EditorSession, body: HTMLElement, repo: GhRepo): void {
  const detail = body.querySelector('#gh-detail') as HTMLElement;
  detail.innerHTML = '<p class="muted">Loading branches…</p>';
  void (async () => {
    let branches: GhBranch[];
    try {
      branches = await listBranches(repo.owner, repo.name);
    } catch (e) {
      detail.innerHTML = `<p class="error">${escapeHtml((e as Error).message)}</p>`;
      return;
    }
    detail.innerHTML = `
      <div class="field">Repository <code class="code">${escapeHtml(repo.fullName)}</code></div>
      <label class="field">Branch
        <select id="gh-branch" class="input">
          ${branches.map((b) => `<option value="${escapeHtml(b.name)}" data-sha="${b.sha}"${b.name === repo.defaultBranch ? ' selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
        </select>
      </label>
      <button class="btn btn-primary" id="gh-scan">Scan repository</button>
      <div id="gh-scan-result" style="margin-top:12px"></div>`;
    (detail.querySelector('#gh-scan') as HTMLButtonElement).onclick = async () => {
      const sel = detail.querySelector('#gh-branch') as HTMLSelectElement;
      const branch = sel.value;
      const sha = (sel.selectedOptions[0] as HTMLElement).dataset.sha as string;
      const result = detail.querySelector('#gh-scan-result') as HTMLElement;
      result.innerHTML = '<p class="muted">Scanning files…</p>';
      try {
        const tree = await getTree(repo.owner, repo.name, sha);
        const det = detectProject(tree);
        renderGhDetected(s, result, repo, branch, det);
      } catch (e) {
        result.innerHTML = `<p class="error">${escapeHtml((e as Error).message)}</p>`;
      }
    };
  })();
}

function renderGhDetected(s: EditorSession, el: HTMLElement, repo: GhRepo, branch: string, det: DetectedProject): void {
  if (det.kind === 'none') {
    el.innerHTML = '<p class="muted">No Web 3D Studio project or 3D assets detected in this branch.</p>';
    return;
  }
  const modelList = det.models.slice(0, 20).map((m) => `
    <label class="gh-file"><input type="checkbox" data-model="${escapeHtml(m.path)}" checked /> 📦 ${escapeHtml(m.path)} <span class="muted small">${m.size ? `${(m.size / 1024).toFixed(0)} KB` : ''}</span></label>`).join('');
  el.innerHTML = `
    ${det.kind === 'studio' ? `<div class="banner banner-info">Studio project detected${det.basePath ? ` in <code>${escapeHtml(det.basePath)}</code>` : ''} ${det.projectJson ? '· project.json ✓' : ''} ${det.sceneJson ? '· scene.json ✓' : ''}</div>` : `<div class="banner banner-info">${det.models.length} model(s), ${det.textures.length} texture(s) detected.</div>`}
    ${det.models.length ? `<div class="panel-sub">Models</div><div class="gh-files">${modelList}</div>` : ''}
    <div class="row-between" style="margin-top:12px">
      <button class="btn btn-ghost" id="gh-cancel">Cancel</button>
      <span>
        ${det.kind === 'studio' ? '<button class="btn btn-primary" id="gh-import-new">Import as new project</button> <button class="btn" id="gh-import-merge">Merge into scene</button>' : '<button class="btn btn-primary" id="gh-import-assets">Import selected assets</button>'}
      </span>
    </div>
    <p id="gh-progress" class="muted small"></p>`;
  (el.querySelector('#gh-cancel') as HTMLButtonElement).onclick = () => closeModal();
  const progress = el.querySelector('#gh-progress') as HTMLElement;

  const selectedModels = (): GhTreeItem[] => {
    const paths = new Set([...el.querySelectorAll('[data-model]:checked')].map((c) => (c as HTMLInputElement).dataset.model as string));
    return det.models.filter((m) => paths.has(m.path));
  };

  const asNew = el.querySelector('#gh-import-new') as HTMLButtonElement | null;
  if (asNew) {
    asNew.onclick = async () => {
      progress.textContent = 'Downloading project…';
      try {
        const me = auth.user.get();
        const { doc, blobs, missing } = await importStudioProject(repo.owner, repo.name, branch, det, me?.id ?? 'guest');
        // persist asset blobs locally
        for (const [key, buf] of blobs) {
          if (!key.startsWith('asset:')) continue;
          const assetId = key.slice(6);
          await localDb.saveBlob(assetId, new Blob([buf], { type: 'model/gltf-binary' }));
        }
        await localDb.saveProject(doc);
        closeModal();
        toast(missing.length ? `Imported with ${missing.length} missing file(s)` : 'Project imported', missing.length ? 'warn' : 'success');
        if (missing.length) console.warn('missing github files', missing);
        if (s.doc.id === doc.id) location.reload();
        else nav(`#/p/${doc.id}`);
      } catch (e) {
        progress.textContent = '';
        toast(`Import failed: ${(e as Error).message}`, 'error');
      }
    };
  }
  const merge = el.querySelector('#gh-import-merge') as HTMLButtonElement | null;
  if (merge) {
    merge.onclick = async () => {
      progress.textContent = 'Downloading project…';
      try {
        const me = auth.user.get();
        const { doc, blobs, missing } = await importStudioProject(repo.owner, repo.name, branch, det, me?.id ?? 'guest');
        for (const [key, buf] of blobs) {
          if (!key.startsWith('asset:')) continue;
          await localDb.saveBlob(key.slice(6), new Blob([buf], { type: 'model/gltf-binary' }));
        }
        s.history.checkpoint(s.doc, 'GitHub merge');
        for (const m of doc.materials) if (!s.doc.materials.some((x) => x.id === m.id)) s.doc.materials.push(m);
        for (const a of doc.assets) if (!s.doc.assets.some((x) => x.id === a.id)) s.doc.assets.push(a);
        for (const o of doc.objects) {
          o.name = `${o.name}`;
          s.doc.objects.push(o);
          s.viewport.addObject(o);
        }
        s.rebuildFromDoc();
        s.markDirty('import');
        closeModal();
        toast(missing.length ? `Merged with ${missing.length} missing file(s)` : 'Project merged into scene', missing.length ? 'warn' : 'success');
      } catch (e) {
        progress.textContent = '';
        toast(`Import failed: ${(e as Error).message}`, 'error');
      }
    };
  }
  const assetsBtn = el.querySelector('#gh-import-assets') as HTMLButtonElement | null;
  if (assetsBtn) {
    assetsBtn.onclick = async () => {
      const items = selectedModels();
      if (!items.length) {
        toast('Select at least one model', 'warn');
        return;
      }
      progress.textContent = `Downloading ${items.length} file(s)…`;
      try {
        const files = await importLooseAssets(repo.owner, repo.name, branch, items);
        let n = 0;
        for (const f of files) {
          if (!f.name.toLowerCase().endsWith('.glb') && !f.name.toLowerCase().endsWith('.gltf')) continue;
          const obj = await s.importGlbBytes(f.name.replace(/\.(glb|gltf)$/i, ''), f.buf, f.name);
          if (obj) n++;
        }
        closeModal();
        toast(`Imported ${n} model(s)`, 'success');
      } catch (e) {
        progress.textContent = '';
        toast(`Import failed: ${(e as Error).message}`, 'error');
      }
    };
  }
}

function renderGhConnect(body: HTMLElement, onDone: () => void): void {
  const envClientId = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? '';
  body.innerHTML = `
    <div class="banner banner-info">Connect GitHub to browse real repositories. Tokens stay in this tab (<code>sessionStorage</code>) — never in source code.</div>
    <div class="panel-sub">Option 1 — Device code (OAuth App, no token paste)</div>
    <label class="field">OAuth client id
      <input id="gh-client" class="input" placeholder="Ov23…" value="${escapeHtml(envClientId)}" />
      <span class="small muted">Create one at github.com → Settings → Developer settings → OAuth Apps (homepage URL can be this app).</span>
    </label>
    <button class="btn" id="gh-device">Connect with device code</button>
    <p id="gh-device-status" class="small"></p>
    <div class="panel-sub">Option 2 — Personal access token</div>
    <label class="field">Token (classic or fine-grained with Contents: read/write)
      <input id="gh-pat" class="input" type="password" placeholder="ghp_… / github_pat_…" />
    </label>
    <button class="btn btn-primary" id="gh-pat-go">Connect with token</button>`;
  (body.querySelector('#gh-pat-go') as HTMLButtonElement).onclick = async () => {
    const t = (body.querySelector('#gh-pat') as HTMLInputElement).value.trim();
    if (!t) return;
    setGhToken(t);
    const v = await ghViewer();
    if (!v) {
      setGhToken(null);
      toast('Invalid token', 'error');
      return;
    }
    toast(`Connected as ${v.login}`, 'success');
    onDone();
  };
  (body.querySelector('#gh-device') as HTMLButtonElement).onclick = async () => {
    const clientId = (body.querySelector('#gh-client') as HTMLInputElement).value.trim();
    if (!clientId) {
      toast('Enter an OAuth client id, or use a token', 'warn');
      return;
    }
    const status = body.querySelector('#gh-device-status') as HTMLElement;
    try {
      const flow = await startDeviceFlow(clientId);
      status.innerHTML = `Enter code <b>${escapeHtml(flow.userCode)}</b> at <a href="${escapeHtml(flow.verificationUri)}" target="_blank" rel="noreferrer">${escapeHtml(flow.verificationUri)}</a> — waiting…`;
      const deadline = Date.now() + 5 * 60 * 1000;
      const poll = async (): Promise<void> => {
        if (!document.body.contains(status)) return;
        try {
          const token = await pollDeviceToken(clientId, flow.deviceCode);
          if (token) {
            setGhToken(token);
            toast('GitHub connected', 'success');
            onDone();
            return;
          }
        } catch (e) {
          status.textContent = (e as Error).message;
          return;
        }
        if (Date.now() > deadline) {
          status.textContent = 'Timed out — try again.';
          return;
        }
        setTimeout(() => void poll(), flow.interval * 1000);
      };
      setTimeout(() => void poll(), flow.interval * 1000);
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
}

// =====================================================================
// GITHUB EXPORT (§40)
// =====================================================================
export function openGithubExport(s: EditorSession): void {
  const body = document.createElement('div');
  openModal({ title: 'Export to GitHub', body, wide: true });
  if (!ghConnected()) {
    renderGhConnect(body, () => openGithubExport(s));
    return;
  }
  body.innerHTML = `
    <div class="banner banner-info">Generates <code>project.json</code>, <code>scene.json</code>, <code>assets.json</code>, <code>AI_PROJECT_CONTEXT.md</code>, <code>README.md</code> + <code>assets/</code> so an AI coding agent can build on this project.</div>
    <label class="field">Repository (owner/name or new name)
      <input id="gx-repo" class="input" value="${escapeHtml(s.doc.name.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase())}" />
    </label>
    <div class="row-between">
      <label class="field" style="flex:1">Branch <input id="gx-branch" class="input" value="main" /></label>
      <label class="field" style="flex:2">Commit message <input id="gx-msg" class="input" value="Export from Web 3D Studio" /></label>
    </div>
    <label class="small"><input type="checkbox" id="gx-create" checked /> Create repository if it doesn't exist</label>
    <div class="row-between" style="margin-top:12px">
      <button class="btn btn-ghost" id="gx-cancel">Cancel</button>
      <button class="btn btn-primary" id="gx-go">Export</button>
    </div>
    <p id="gx-progress" class="muted small"></p>`;
  (body.querySelector('#gx-cancel') as HTMLButtonElement).onclick = () => closeModal();
  (body.querySelector('#gx-go') as HTMLButtonElement).onclick = async () => {
    const repoName = (body.querySelector('#gx-repo') as HTMLInputElement).value.trim();
    const branch = (body.querySelector('#gx-branch') as HTMLInputElement).value.trim() || 'main';
    const message = (body.querySelector('#gx-msg') as HTMLInputElement).value.trim() || 'Export from Web 3D Studio';
    const create = (body.querySelector('#gx-create') as HTMLInputElement).checked;
    const progress = body.querySelector('#gx-progress') as HTMLElement;
    if (!repoName) {
      toast('Enter a repository name', 'warn');
      return;
    }
    if (!create && !confirm(`Export will add/update files on ${repoName}@${branch}. Continue?`)) return;
    progress.textContent = 'Preparing…';
    try {
      const { owner, repo } = await ensureRepo(repoName, create);
      const assetBytes = new Map<string, ArrayBuffer>();
      for (const a of s.doc.assets) {
        const b = s.getAssetBytes(a.id);
        if (b) assetBytes.set(a.id, b);
        else {
          const blob = await localDb.getBlob(a.id);
          if (blob) assetBytes.set(a.id, await blob.arrayBuffer());
        }
      }
      const url = await commitExport(owner, repo, { createRepo: create, repoName, branch, message }, s.doc, assetBytes, (m) => {
        progress.textContent = m;
      });
      progress.innerHTML = `Done — <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">view commit</a>`;
      toast('Exported to GitHub', 'success');
    } catch (e) {
      progress.textContent = '';
      toast(`Export failed: ${(e as Error).message}`, 'error');
    }
  };
}

export { nav };
