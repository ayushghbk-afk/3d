import { EditorSession } from '../editor/session.js';
import type { PrimitiveType, TransformMode } from '../state/models.js';
import { cloudEnabled } from '../lib/supabase.js';
import { pickFiles } from '../lib/utils.js';
import { toast } from './toast.js';
import { nav } from './router.js';
import { buildOutliner } from './outliner.js';
import { buildInspector } from './inspector.js';
import { buildTimeline } from './timeline.js';
import { openModal, closeModal } from './modals.js';
import { openGithubImport, openGithubExport, openMembersModal, openVersionsModal, openShortcutsModal } from './panels.js';

export function mountEditor(root: HTMLElement, projectId: string): () => void {
  let session: EditorSession | null = null;
  let cancelled = false;
  const unsubs: (() => void)[] = [];
  const keyHandler = (e: KeyboardEvent) => {
    if (!session || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      session.undo();
    } else if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) {
      e.preventDefault();
      session.redo();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void session.forceSave().then(() => toast('Saved', 'success'));
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      session.duplicateObject();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      session.deleteObject();
    } else if (e.key.toLowerCase() === 'f') {
      session.focusSelected();
    } else if (e.key.toLowerCase() === 'v') {
      session.select(null);
    } else if (e.key.toLowerCase() === 'w') {
      session.setTransformMode('translate');
    } else if (e.key.toLowerCase() === 'e') {
      session.setTransformMode('rotate');
    } else if (e.key.toLowerCase() === 'r') {
      session.setTransformMode('scale');
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === '?') {
      openShortcutsModal();
    }
  };

  root.innerHTML = `
    <div class="editor">
      <header class="topbar">
        <button id="tb-back" class="btn btn-icon" aria-label="Back to projects">←</button>
        <span id="tb-name" class="proj-name" title="Rename"></span>
        <span id="tb-mode" class="badge"></span>
        <span id="tb-save" class="badge badge-dim"></span>
        <span class="spacer"></span>
        <span id="tb-presence" class="presence"></span>
        <button id="tb-members" class="btn btn-sm">👥</button>
        <button id="tb-github" class="btn btn-sm">⬢ GitHub</button>
        <button id="tb-menu" class="btn btn-sm">☰</button>
      </header>
      <div class="editor-main">
        <aside id="rail" class="rail" aria-label="Tools"></aside>
        <aside id="outliner" class="outliner" aria-label="Scene outliner"></aside>
        <section id="vp-wrap" class="vp-wrap">
          <div id="vp" class="vp"></div>
          <div id="vp-overlay" class="vp-overlay"></div>
          <div id="vp-status" class="vp-status"></div>
        </section>
        <aside id="inspector" class="inspector" aria-label="Inspector"></aside>
      </div>
      <footer id="timeline" class="timeline" aria-label="Timeline"></footer>
      <nav id="mobilebar" class="mobilebar" aria-label="Mobile tools"></nav>
    </div>`;

  const vpEl = root.querySelector('#vp') as HTMLElement;
  const overlay = root.querySelector('#vp-overlay') as HTMLElement;

  function togglePlay(): void {
    const s = session;
    if (!s) return;
    if (s.playback.playing) s.playback.pause();
    else s.playback.play();
    const clip = s.doc.clips.find((c) => c.id === s.doc.activeClipId);
    s.anim.set({ playing: s.playback.playing, frame: s.playback.frame, length: clip?.length ?? 90, fps: clip?.fps ?? 30 });
  }

  async function boot(): Promise<void> {
    overlay.innerHTML = '<div class="loading">Opening project…</div>';
    try {
      session = await EditorSession.open(projectId, vpEl);
    } catch (e) {
      overlay.innerHTML = `<div class="loading error">Failed to open project: ${(e as Error).message} <button class="btn" onclick="location.hash='#/'">← Projects</button></div>`;
      return;
    }
    if (cancelled) {
      session.dispose();
      return;
    }
    overlay.innerHTML = '';
    wire(session);
    // auto-open GitHub import when navigated from dashboard button
    if (window.location.hash.includes('import=github')) {
      history.replaceState(null, '', `#/p/${projectId}`);
      openGithubImport(session);
    }
    // recovery conflicts
    session.onRecovery = (local, cloud) => {
      const body = document.createElement('div');
      body.innerHTML = `<p>Cloud has a newer version (v${cloud.version}) than this device (v${local.version}).</p>`;
      openModal({
        title: 'Sync conflict',
        body,
        actions: [
          { label: 'Keep mine', onClick: () => { if (session) void session.cloudSave(); } },
          {
            label: 'Use cloud', kind: 'primary',
            onClick: () => {
              if (!session) return;
              session.restoreSnapshot({ objects: cloud.objects, materials: cloud.materials, clips: cloud.clips }, 'cloud');
            },
          },
        ],
      });
    };
    session.onNotice = (n) => toast(n.msg, n.kind === 'info' ? 'info' : n.kind);
  }

  function wire(s: EditorSession): void {
    const nameEl = root.querySelector('#tb-name') as HTMLElement;
    const modeEl = root.querySelector('#tb-mode') as HTMLElement;
    const saveEl = root.querySelector('#tb-save') as HTMLElement;
    const presenceEl = root.querySelector('#tb-presence') as HTMLElement;
    const statusEl = root.querySelector('#vp-status') as HTMLElement;

    // project name (rename on click)
    const refreshName = () => {
      nameEl.textContent = `🚀 ${s.doc.name}`;
      modeEl.textContent = s.doc.mode === 'team' ? '👥 Team' : '👤 Solo';
      modeEl.className = `badge ${s.doc.mode === 'team' ? 'badge-team' : ''}`;
    };
    unsubs.push(s.rev.subscribe(refreshName));
    refreshName();
    nameEl.onclick = () => {
      const v = prompt('Project name', s.doc.name);
      if (v && v.trim()) {
        s.doc.name = v.trim().slice(0, 80);
        s.markDirty('rename');
      }
    };

    // save state
    unsubs.push(
      s.saveState.subscribe((st) => {
        const map = { saved: '✓ Saved', saving: '… Saving', local: '💾 Local', offline: '⚠ Offline', error: '✕ Error' } as const;
        saveEl.textContent = map[st];
        saveEl.className = `badge ${st === 'saved' ? 'badge-ok' : st === 'offline' || st === 'error' ? 'badge-warn' : 'badge-dim'}`;
      }),
    );
    unsubs.push(
      s.online.subscribe((on) => {
        if (!on) s.saveState.set('offline');
      }),
    );

    // presence
    unsubs.push(
      s.peers.subscribe((users) => {
        const me = s.user().id;
        const others = users.filter((u) => u.id !== me);
        const dots = [
          `<span class="peer" style="--c:${'#4ade80'}" title="You">●</span>`,
          ...others.map((u) => `<span class="peer" style="--c:${u.color}" title="${u.name}${u.editingObjectName ? ` — editing ${u.editingObjectName}` : ''}">● ${u.name.split(' ')[0]}</span>`),
        ];
        presenceEl.innerHTML = `🟢 ${users.length || 1} ${dots.join(' ')}`;
      }),
    );

    // viewport status line
    const refreshStatus = () => {
      const sel = s.selectedObject();
      const lock = sel ? s.locks.get().get(sel.id) : null;
      const gpu = s.viewport.caps.webgpu ? 'WebGPU-ready' : 'WebGL2';
      statusEl.textContent = `${gpu} · ${s.doc.objects.length} objects · ${sel ? `Selected: ${sel.name}${lock && lock.id !== s.user().id ? ` (🔒 ${lock.name})` : ''}` : 'Nothing selected'}`;
    };
    unsubs.push(s.rev.subscribe(refreshStatus));
    unsubs.push(s.selection.subscribe(refreshStatus));
    unsubs.push(s.locks.subscribe(refreshStatus));
    refreshStatus();

    buildRail(s, root.querySelector('#rail') as HTMLElement);
    buildMobileBar(s, root.querySelector('#mobilebar') as HTMLElement, togglePlay);
    unsubs.push(buildOutliner(s, root.querySelector('#outliner') as HTMLElement));
    unsubs.push(buildInspector(s, root.querySelector('#inspector') as HTMLElement));
    unsubs.push(buildTimeline(s, root.querySelector('#timeline') as HTMLElement, togglePlay));

    (root.querySelector('#tb-back') as HTMLButtonElement).onclick = async () => {
      await s.forceSave();
      nav('#/');
    };
    (root.querySelector('#tb-members') as HTMLButtonElement).onclick = () => openMembersModal(s);
    (root.querySelector('#tb-github') as HTMLButtonElement).onclick = () => openGithubMenu(s);
    (root.querySelector('#tb-menu') as HTMLButtonElement).onclick = () => openEditorMenu(s, togglePlay);
    updateGizmoButtons();
  }

  function updateGizmoButtons(): void {
    root.querySelectorAll('[data-tmode]').forEach((b) => {
      const on = session?.transformMode.get() === (b as HTMLElement).dataset.tmode;
      b.classList.toggle('active', on);
    });
  }
  const modePoll = setInterval(updateGizmoButtons, 500);

  window.addEventListener('keydown', keyHandler);
  void boot();

  return () => {
    cancelled = true;
    clearInterval(modePoll);
    window.removeEventListener('keydown', keyHandler);
    unsubs.forEach((u) => {
      try {
        u();
      } catch { /* noop */ }
    });
    session?.dispose();
    session = null;
    root.innerHTML = '';
  };
}

// ---------- desktop tool rail ----------
function buildRail(s: EditorSession, el: HTMLElement): void {
  const prims: { k: PrimitiveType; icon: string; label: string }[] = [
    { k: 'cube', icon: '▣', label: 'Cube' },
    { k: 'sphere', icon: '●', label: 'Sphere' },
    { k: 'cylinder', icon: '▤', label: 'Cylinder' },
    { k: 'cone', icon: '▲', label: 'Cone' },
    { k: 'plane', icon: '▱', label: 'Plane' },
    { k: 'torus', icon: '◎', label: 'Torus' },
  ];
  el.innerHTML = `
    <div class="rail-group" role="group" aria-label="Transform">
      <button class="rail-btn" data-tmode="translate" title="Move (W)">↔</button>
      <button class="rail-btn" data-tmode="rotate" title="Rotate (E)">🔄</button>
      <button class="rail-btn" data-tmode="scale" title="Scale (R)">📐</button>
    </div>
    <div class="rail-group" role="group" aria-label="Add primitive">
      ${prims.map((p) => `<button class="rail-btn" data-prim="${p.k}" title="${p.label}">${p.icon}</button>`).join('')}
    </div>
    <div class="rail-group" role="group" aria-label="Scene">
      <button class="rail-btn" data-act="group" title="Group">🗂</button>
      <button class="rail-btn" data-act="light" title="Light">💡</button>
      <button class="rail-btn" data-act="import" title="Import GLB">📥</button>
      <button class="rail-btn" data-act="focus" title="Focus (F)">🎯</button>
    </div>
    <div class="rail-group" role="group" aria-label="History">
      <button class="rail-btn" data-act="undo" title="Undo (Ctrl+Z)">↩</button>
      <button class="rail-btn" data-act="redo" title="Redo">↪</button>
    </div>`;
  el.querySelectorAll('[data-tmode]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => {
      s.setTransformMode((b as HTMLElement).dataset.tmode as TransformMode);
      el.querySelectorAll('[data-tmode]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
  });
  el.querySelector('[data-tmode="translate"]')?.classList.add('active');
  el.querySelectorAll('[data-prim]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => s.addPrimitive((b as HTMLElement).dataset.prim as PrimitiveType);
  });
  const acts: Record<string, () => void> = {
    group: () => s.addGroup(),
    light: () => s.addLight(),
    focus: () => s.focusSelected(),
    undo: () => s.undo(),
    redo: () => s.redo(),
    import: () => void importGlb(s),
  };
  el.querySelectorAll('[data-act]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.act as string]?.();
  });
}

async function importGlb(s: EditorSession): Promise<void> {
  const files = await pickFiles('.glb,.gltf,model/gltf-binary');
  for (const f of files) {
    toast(`Importing ${f.name}…`);
    await s.importGlbFile(f);
  }
}

// ---------- mobile bottom bar ----------
function buildMobileBar(s: EditorSession, el: HTMLElement, togglePlay: () => void): void {
  el.innerHTML = `
    <button data-tmode="translate" title="Move">↔</button>
    <button data-m="add" title="Add">＋</button>
    <button data-m="key" title="Keyframe">◉</button>
    <button data-m="play" title="Play">▶</button>
    <button data-m="props" title="Properties">⋮</button>`;
  el.querySelector('[data-tmode]')?.classList.add('active');
  const cycle: TransformMode[] = ['translate', 'rotate', 'scale'];
  const icons = { translate: '↔', rotate: '🔄', scale: '📐' };
  (el.querySelector('[data-tmode]') as HTMLButtonElement).onclick = (e) => {
    const next = cycle[(cycle.indexOf(s.transformMode.get()) + 1) % 3];
    s.setTransformMode(next);
    (e.target as HTMLButtonElement).textContent = icons[next];
  };
  (el.querySelector('[data-m="add"]') as HTMLButtonElement).onclick = () => openAddSheet(s);
  (el.querySelector('[data-m="key"]') as HTMLButtonElement).onclick = () => {
    s.addKeyframeAll();
    toast('Keyframe added', 'success');
  };
  const playBtn = el.querySelector('[data-m="play"]') as HTMLButtonElement;
  playBtn.onclick = () => {
    togglePlay();
    playBtn.textContent = s.playback.playing ? '⏸' : '▶';
  };
  (el.querySelector('[data-m="props"]') as HTMLButtonElement).onclick = () => {
    document.querySelector('.inspector')?.classList.toggle('sheet-open');
    document.querySelector('.outliner')?.classList.toggle('sheet-open');
  };
}

function openAddSheet(s: EditorSession): void {
  const body = document.createElement('div');
  body.className = 'add-grid';
  const items: { label: string; fn: () => void }[] = [
    { label: '▣ Cube', fn: () => s.addPrimitive('cube') },
    { label: '● Sphere', fn: () => s.addPrimitive('sphere') },
    { label: '▤ Cylinder', fn: () => s.addPrimitive('cylinder') },
    { label: '▲ Cone', fn: () => s.addPrimitive('cone') },
    { label: '▱ Plane', fn: () => s.addPrimitive('plane') },
    { label: '◎ Torus', fn: () => s.addPrimitive('torus') },
    { label: '🗂 Group', fn: () => s.addGroup() },
    { label: '💡 Light', fn: () => s.addLight() },
    { label: '📥 Import GLB', fn: () => void importGlb(s) },
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'btn add-cell';
    b.textContent = it.label;
    b.onclick = () => {
      it.fn();
      closeModal();
    };
    body.appendChild(b);
  }
  openModal({ title: 'Add to scene', body, actions: [{ label: 'Close', kind: 'ghost' }] });
}

// ---------- menus ----------
function openEditorMenu(s: EditorSession, togglePlay: () => void): void {
  const body = document.createElement('div');
  body.className = 'menu-list';
  const items: { label: string; fn: () => void }[] = [
    { label: '💾 Save now', fn: () => void s.forceSave().then(() => toast('Saved', 'success')) },
    { label: '📥 Import GLB', fn: () => void importGlb(s) },
    { label: '📤 Export GLB', fn: () => void s.exportGlb() },
    { label: '⬢ GitHub import / export', fn: () => openGithubMenu(s) },
    { label: '👥 Members & invites', fn: () => openMembersModal(s) },
    { label: '🕘 Version history', fn: () => openVersionsModal(s) },
    { label: '⌨ Shortcuts', fn: () => openShortcutsModal() },
    { label: s.shadingMode.get() === 'wireframe' ? '▣ Shading: Solid' : '🕸 Shading: Wireframe', fn: () => s.shadingMode.set(s.shadingMode.get() === 'wireframe' ? 'material' : 'wireframe') },
    { label: s.cameraType.get() === 'perspective' ? '📷 Camera: Ortho' : '📷 Camera: Perspective', fn: () => s.cameraType.set(s.cameraType.get() === 'perspective' ? 'orthographic' : 'perspective') },
    { label: s.playback.playing ? '⏸ Pause' : '▶ Play', fn: () => togglePlay() },
    { label: '◉ Add keyframe (all)', fn: () => s.addKeyframeAll() },
    { label: '← Back to projects', fn: () => nav('#/') },
  ];
  if (!cloudEnabled) items.splice(4, 2);
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'btn btn-block menu-item';
    b.textContent = it.label;
    b.onclick = () => {
      closeModal();
      it.fn();
    };
    body.appendChild(b);
  }
  openModal({ title: s.doc.name, body });
}

function openGithubMenu(s: EditorSession): void {
  const body = document.createElement('div');
  body.className = 'menu-list';
  const items = [
    { label: '📥 Import from GitHub…', fn: () => openGithubImport(s) },
    { label: '📤 Export to GitHub…', fn: () => openGithubExport(s) },
  ];
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'btn btn-block menu-item';
    b.textContent = it.label;
    b.onclick = () => {
      closeModal();
      it.fn();
    };
    body.appendChild(b);
  }
  openModal({ title: 'GitHub — AI/code layer', body });
}


