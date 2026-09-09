import { EditorSession } from '../editor/session.js';
import type { PrimitiveType, TransformMode } from '../state/models.js';
import { cloudEnabled } from '../lib/supabase.js';
import { localDb } from '../lib/indexeddb.js';
import { pickFiles } from '../lib/utils.js';
import { toast } from './toast.js';
import { nav } from './router.js';
import { buildOutliner } from './outliner.js';
import { buildInspector } from './inspector.js';
import { buildTimeline } from './timeline.js';
import { openModal, closeModal } from './modals.js';
import { attachDocking } from './docking.js';
import { closeFloatWin } from './floatwin.js';
import { openGithubImport, openGithubExport, openMembersModal, openVersionsModal, openShortcutsModal } from './panels.js';
import { setEditorSession } from '../ai/index.js';

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
      void session.forceSave().then(() => {
        if (!session) return;
        toast(session.syncError.get() || (session.saveState.get() === 'saved' ? 'Saved to cloud' : 'Saved on this device'), session.syncError.get() ? 'warn' : 'success');
      });
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
    } else if (e.key.toLowerCase() === 'a' && !document.getElementById('modal-root')?.hasChildNodes()) {
      openAi(session);
    } else if (e.key.toLowerCase() === 'j' && !document.getElementById('modal-root')?.hasChildNodes()) {
      openScripts(session);
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
        <button id="tb-members" class="btn btn-sm">People</button>
        <button id="tb-ai" class="btn btn-sm" title="AI Studio — toggle (A). Drag, resize, collapse.">AI Studio</button>
        <button id="tb-scripts" class="btn btn-sm" title="Scene scripts — control meshes, keyframes, camera (J).">Scripts</button>
        <button id="tb-github" class="btn btn-sm">GitHub</button>
        <button id="tb-menu" class="btn btn-sm">More</button>
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
    setEditorSession(session);
    wire(session);
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const openPanel = query.get('open');
    const importSource = query.get('import');
    if (openPanel || importSource) history.replaceState(null, '', `#/p/${projectId}`);
    if (importSource === 'github') openGithubImport(session);
    if (openPanel === 'ai') openAi(session);
    // recovery conflicts
    session.onRecovery = (local, cloud) => {
      const body = document.createElement('div');
      body.innerHTML = `<p>Cloud has a newer version (v${cloud.version}) than this device (v${local.version}).</p>`;
      openModal({
        title: 'Sync conflict',
        body,
        actions: [
          { label: 'Keep mine', onClick: async () => {
            if (!session) return;
            session.pendingRecovery = null;
            session.doc.version = Math.max(session.doc.version, cloud.version) + 1;
            await session.cloudSave();
            if (!session.syncError.get()) await localDb.clearQueue((await localDb.listQueue(session.doc.id)).map((op) => op.id));
          } },
          {
            label: 'Use cloud', kind: 'primary',
            onClick: async () => {
              if (!session) return;
              // Restore the whole project, including settings and asset metadata.
              // Reload rehydrates the viewport/textures without scheduling an overwrite.
              session.dispose();
              await localDb.saveProject(cloud);
              await localDb.clearQueue((await localDb.listQueue(cloud.id)).map((op) => op.id));
              location.reload();
            },
          },
        ],
      });
    };
    if (session.pendingRecovery) session.onRecovery(session.doc, session.pendingRecovery);
    if (session.syncError.get() && !session.pendingRecovery) toast(session.syncError.get() as string, 'warn');
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
      nameEl.textContent = s.doc.name;
      modeEl.textContent = s.doc.mode === 'team' ? 'Team project' : 'Solo project';
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
    unsubs.push(s.syncError.subscribe((error) => { saveEl.title = error ?? 'Project save status'; }));
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
      statusEl.textContent = `${gpu} · ${s.doc.objects.length} object${s.doc.objects.length === 1 ? '' : 's'} · ${sel ? `Selected: ${sel.name}${lock && lock.id !== s.user().id ? ` (locked by ${lock.name})` : ''}` : 'Select an object to edit it'}`;
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
    // resizable + collapsible panels (outliner / inspector / timeline), layout persisted
    unsubs.push(attachDocking(root));

    (root.querySelector('#tb-back') as HTMLButtonElement).onclick = async () => {
      await s.forceSave();
      nav('#/');
    };
    (root.querySelector('#tb-members') as HTMLButtonElement).onclick = () => openMembersModal(s);
    (root.querySelector('#tb-ai') as HTMLButtonElement).onclick = () => openAi(s);
    (root.querySelector('#tb-scripts') as HTMLButtonElement).onclick = () => openScripts(s);
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
    setEditorSession(null);
    closeFloatWin('ai-studio');
    closeFloatWin('scripts');
    session?.dispose();
    session = null;
    root.innerHTML = '';
  };
}

// ---------- desktop tool rail ----------
function buildRail(s: EditorSession, el: HTMLElement): void {
  const prims: { k: PrimitiveType; icon: string; label: string; key?: string }[] = [
    { k: 'cube', icon: '▣', label: 'Cube' },
    { k: 'sphere', icon: '●', label: 'Sphere' },
    { k: 'cylinder', icon: '▤', label: 'Cylinder' },
    { k: 'cone', icon: '▲', label: 'Cone' },
    { k: 'plane', icon: '▱', label: 'Plane' },
    { k: 'torus', icon: '◎', label: 'Torus' },
  ];
  const toolButton = (attrs: string, icon: string, label: string, key = ''): string => `
    <button class="rail-btn" ${attrs}>
      <span class="rail-icon" aria-hidden="true">${icon}</span>
      <span class="rail-label">${label}</span>
      ${key ? `<span class="rail-key">${key}</span>` : ''}
    </button>`;
  el.innerHTML = `
    <div class="rail-section" role="group" aria-label="Transform tools">
      <div class="rail-title">Transform</div>
      ${toolButton('data-tmode="translate" title="Move (W)"', '↔', 'Move', 'W')}
      ${toolButton('data-tmode="rotate" title="Rotate (E)"', '🔄', 'Rotate', 'E')}
      ${toolButton('data-tmode="scale" title="Scale (R)"', '📐', 'Scale', 'R')}
    </div>
    <div class="rail-section" role="group" aria-label="Add shapes">
      <div class="rail-title">Create</div>
      ${prims.map((p) => toolButton(`data-prim="${p.k}" title="Add ${p.label}"`, p.icon, p.label)).join('')}
    </div>
    <div class="rail-section" role="group" aria-label="Scene actions">
      <div class="rail-title">Scene</div>
      ${toolButton('data-act="group" title="Group selected objects"', '🗂', 'Group')}
      ${toolButton('data-act="light" title="Add a light"', '💡', 'Light')}
      ${toolButton('data-act="import" title="Import GLB"', '📥', 'Import GLB')}
      ${toolButton('data-act="focus" title="Focus selected object (F)"', '🎯', 'Focus', 'F')}
    </div>
    <div class="rail-section" role="group" aria-label="History">
      <div class="rail-title">History</div>
      ${toolButton('data-act="undo" title="Undo (Ctrl+Z)"', '↩', 'Undo')}
      ${toolButton('data-act="redo" title="Redo (Ctrl+Shift+Z)"', '↪', 'Redo')}
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
    { label: 'Save now', fn: () => void s.forceSave().then(() => toast('Saved', 'success')) },
    { label: 'Open AI Studio', fn: () => openAi(s) },
    { label: 'Open Scripts', fn: () => openScripts(s) },
    { label: 'Import GLB', fn: () => void importGlb(s) },
    { label: 'Export GLB', fn: () => void s.exportGlb() },
    { label: 'GitHub import / export', fn: () => openGithubMenu(s) },
    { label: 'Members & invites', fn: () => openMembersModal(s) },
    { label: 'Version history', fn: () => openVersionsModal(s) },
    { label: 'Shortcuts', fn: () => openShortcutsModal() },
    { label: s.shadingMode.get() === 'wireframe' ? 'Shading: Solid' : 'Shading: Wireframe', fn: () => s.shadingMode.set(s.shadingMode.get() === 'wireframe' ? 'material' : 'wireframe') },
    { label: s.cameraType.get() === 'perspective' ? 'Camera: Ortho' : 'Camera: Perspective', fn: () => s.cameraType.set(s.cameraType.get() === 'perspective' ? 'orthographic' : 'perspective') },
    { label: s.playback.playing ? 'Pause' : 'Play', fn: () => togglePlay() },
    { label: 'Add keyframe (all)', fn: () => s.addKeyframeAll() },
    { label: 'Back to projects', fn: () => nav('#/') },
  ];
  if (!cloudEnabled) {
    const idx = items.findIndex((it) => it.label === 'Members & invites');
    if (idx >= 0) items.splice(idx, 1);
  }
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

function openAi(s: EditorSession): void {
  // Floating ✨ AI Studio: toggleable — pressing ✨ AI / A again hides it to
  // reveal the 3D scene; it also collapses and remembers its position/size.
  void import('./ai-panel.js').then(({ toggleAiPanel }) => toggleAiPanel(s));
}

function openScripts(s: EditorSession): void {
  void import('./script-panel.js').then(({ toggleScriptPanel }) => toggleScriptPanel(s));
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


