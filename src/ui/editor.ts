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
import { attachAutoHideChrome, type AutoHideChrome } from './chrome.js';
import {
  openGithubImport, openGithubExport, openMembersModal, openVersionsModal, openShortcutsModal,
} from './panels.js';
import { openExportModal, openShareModal, openCloudDiagnosticsModal } from './panels-extra.js';
import { setEditorSession } from '../ai/index.js';
import { openCommandPalette, isPaletteOpen, closeCommandPalette } from './command-palette.js';
import { setCommandHost, runCommand, type PanelName as CommandPanelName } from './commands.js';
import { attachLayout, type LayoutController } from './layout.js';
import { mountMobileUi, type MobileUi } from './mobile.js';
import { PlayMode } from './playmode.js';
import { buildPresence, mountPresenceOverlay, broadcastCursor } from './presence.js';
import { applyAssetPayload, type AssetDragPayload } from './asset-browser.js';

const HEARTBEAT_KEY = 'w3d.session.';

export function mountEditor(root: HTMLElement, projectId: string): () => void {
  let session: EditorSession | null = null;
  let cancelled = false;
  let chrome: AutoHideChrome | null = null;
  let layout: LayoutController | null = null;
  let mobile: MobileUi | null = null;
  let play: PlayMode | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let autosave: ReturnType<typeof setInterval> | null = null;
  const unsubs: (() => void)[] = [];

  // ---------------------------------------------------------------- keyboard
  const keyHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (isPaletteOpen()) {
        closeCommandPalette();
        e.preventDefault();
        return;
      }
      if (chrome?.handleEscape()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'F11') {
      e.preventDefault();
      void chrome?.toggle();
      return;
    }
    // Ctrl+K works everywhere, including inside inputs
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette(session);
      return;
    }
    if (!session || (e.target as HTMLElement)?.tagName === 'INPUT'
      || (e.target as HTMLElement)?.tagName === 'TEXTAREA'
      || (e.target as HTMLElement)?.tagName === 'SELECT') return;

    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const s = session;

    if (mod && k === 'z' && !e.shiftKey) {
      e.preventDefault();
      s.undo();
    } else if ((mod && k === 'y') || (mod && e.shiftKey && k === 'z')) {
      e.preventDefault();
      s.redo();
    } else if (mod && k === 's') {
      e.preventDefault();
      void s.forceSave().then(() => {
        if (!session) return;
        toast(session.syncError.get() || (session.saveState.get() === 'saved' ? 'Saved to cloud' : 'Saved on this device'), session.syncError.get() ? 'warn' : 'success');
      });
    } else if (mod && k === 'd') {
      e.preventDefault();
      s.duplicateSelection();
    } else if (mod && k === 'a') {
      e.preventDefault();
      s.selectAll();
    } else if (mod && k === 'i') {
      e.preventDefault();
      s.selectInvert();
    } else if (mod && k === 'g' && e.shiftKey) {
      e.preventDefault();
      s.ungroupObject();
    } else if (mod && k === 'g') {
      e.preventDefault();
      if (s.selection.count()) s.groupSelection();
      else s.addGroup();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      s.deleteSelection();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      s.selectCycle(e.shiftKey ? -1 : 1);
    } else if (k === 'f' && !e.shiftKey) {
      s.frameSelection();
    } else if (k === 'f' && e.shiftKey) {
      e.preventDefault();
      s.select(null);
      s.viewport.focusIds(null);
    } else if (k === 'v') {
      s.select(null);
    } else if (k === 'w') {
      s.setTransformMode('translate');
    } else if (k === 'e') {
      s.setTransformMode('rotate');
    } else if (k === 'r' && !e.altKey) {
      s.setTransformMode('scale');
    } else if (k === 'r' && e.altKey) {
      e.preventDefault();
      s.resetTransform('all');
    } else if (k === 'x') {
      s.setGizmoSpace(s.gizmoSpace.get() === 'world' ? 'local' : 'world');
      toast(`Gizmo space: ${s.gizmoSpace.get()}`, 'info');
    } else if (k === 'h' && !e.shiftKey) {
      s.hideSelection();
    } else if (k === 'h' && e.shiftKey) {
      e.preventDefault();
      s.showAllObjects();
    } else if (e.key === '/') {
      e.preventDefault();
      if (s.isSolo()) s.exitSolo();
      else s.soloSelection();
    } else if (k === 'k') {
      s.addKeyframeAll();
    } else if (e.key === ',') {
      s.gotoPrevKey();
    } else if (e.key === '.') {
      s.gotoNextKey();
    } else if (k === 'z') {
      s.shadingMode.set(s.shadingMode.get() === 'wireframe' ? 'material' : 'wireframe');
    } else if (k === 'g' && !mod) {
      s.toggleGrid();
    } else if (e.key === ' ' && !document.getElementById('modal-root')?.hasChildNodes()) {
      e.preventDefault();
      togglePlay();
    } else if (k === 'a' && !document.getElementById('modal-root')?.hasChildNodes() && !mod) {
      openAi(s);
    } else if (k === 'a' && e.shiftKey && !document.getElementById('modal-root')?.hasChildNodes()) {
      e.preventDefault();
      openCommandPalette(s, 'create ');
    } else if (k === 'j' && !document.getElementById('modal-root')?.hasChildNodes()) {
      openScripts(s);
    } else if (k === 'p' && !document.getElementById('modal-root')?.hasChildNodes()) {
      e.preventDefault();
      void togglePlayMode();
    } else if (e.key === '?') {
      openShortcutsModal();
    } else if (e.altKey && (e.key === '1' || e.key === '3' || e.key === '7')) {
      e.preventDefault();
      const map: Record<string, [number, number]> = { '1': [0, 90], '3': [90, 90], '7': [0, 1] };
      const v = map[e.key];
      s.viewport.setView(v[0], v[1]);
      s.persistCamera();
    } else if (e.altKey && e.key === '5') {
      e.preventDefault();
      s.cameraType.set(s.cameraType.get() === 'perspective' ? 'orthographic' : 'perspective');
    }
  };

  // ------------------------------------------------------------------- markup
  root.innerHTML = `
    <div class="editor">
      <header class="topbar">
        <button id="tb-back" class="btn btn-icon" aria-label="Back to projects">←</button>
        <span id="tb-name" class="proj-name" title="Rename"></span>
        <span id="tb-mode" class="badge"></span>
        <span id="tb-save" class="badge badge-dim"></span>
        <button id="tb-palette" class="btn btn-sm" title="Command palette (Ctrl+K)">⌘K</button>
        <span class="spacer"></span>
        <span id="tb-presence" class="presence"></span>
        <button id="tb-people" class="btn btn-sm" title="People & activity">👥</button>
        <button id="tb-assets" class="btn btn-sm" title="Asset library">📚</button>
        <button id="tb-dope" class="btn btn-sm" title="Dope sheet / graph editor">📈</button>
        <button id="tb-play" class="btn btn-sm" title="Play Mode (P)">▶ Play</button>
        <button id="tb-ai" class="btn btn-sm" title="AI Studio — toggle (A). Drag, resize, collapse.">AI Studio</button>
        <button id="tb-scripts" class="btn btn-sm" title="Scene scripts — control meshes, keyframes, camera (J).">Scripts</button>
        <button id="tb-github" class="btn btn-sm">GitHub</button>
        <button id="tb-fs" class="btn btn-icon" title="Fullscreen — hide browser chrome; tools auto-hide when idle (F11)" aria-label="Fullscreen" aria-pressed="false">⛶</button>
        <button id="tb-menu" class="btn btn-sm">More</button>
      </header>
      <div class="editor-main">
        <aside id="rail" class="rail" aria-label="Tools"></aside>
        <aside id="outliner" class="outliner" aria-label="Scene outliner"></aside>
        <aside id="presence" class="presence-panel" aria-label="People"></aside>
        <section id="vp-wrap" class="vp-wrap">
          <div id="vp" class="vp"></div>
          <div id="vp-overlay" class="vp-overlay"></div>
          <div id="vp-views" class="vp-views"></div>
          <div id="vp-status" class="vp-status"></div>
        </section>
        <aside id="assets" class="assets" aria-label="Asset library"></aside>
        <aside id="inspector" class="inspector" aria-label="Inspector"></aside>
      </div>
      <section id="dope" class="dope" aria-label="Dope sheet"></section>
      <footer id="timeline" class="timeline" aria-label="Timeline"></footer>
    </div>`;

  const vpEl = root.querySelector('#vp') as HTMLElement;
  const overlay = root.querySelector('#vp-overlay') as HTMLElement;

  function togglePlay(): void {
    const s = session;
    if (!s) return;
    if (s.playback.playing) s.pause();
    else s.play();
  }

  async function togglePlayMode(): Promise<void> {
    const s = session;
    if (!s) return;
    if (play?.active) {
      play.exit();
      return;
    }
    play = new PlayMode(s, () => {
      play = null;
    });
    await play.enter();
  }

  // -------------------------------------------------------------------- boot
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
    if (openPanel === 'assets') layout?.show('assets', true);
    if (openPanel === 'animation') layout?.show('animation', true);

    // crash recovery: a heartbeat key survives an unclean exit
    const hbKey = `${HEARTBEAT_KEY}${projectId}`;
    let recovered = false;
    try {
      if (localStorage.getItem(hbKey)) recovered = true;
      localStorage.setItem(hbKey, String(Date.now()));
      heartbeat = setInterval(() => localStorage.setItem(hbKey, String(Date.now())), 5000);
    } catch {
      /* private mode */
    }
    if (recovered) toast('Restored your last session from this device', 'info');

    session.onRecovery = (local, cloud) => {
      const body = document.createElement('div');
      body.innerHTML = `<p>Cloud has a newer version (v${cloud.version}) than this device (v${local.version}).</p>`;
      openModal({
        title: 'Sync conflict',
        body,
        actions: [
          {
            label: 'Keep mine',
            onClick: async () => {
              if (!session) return;
              session.pendingRecovery = null;
              session.doc.version = Math.max(session.doc.version, cloud.version) + 1;
              await session.cloudSave();
              if (!session.syncError.get()) await localDb.clearQueue((await localDb.listQueue(session.doc.id)).map((op) => op.id));
            },
          },
          {
            label: 'Use cloud',
            kind: 'primary',
            onClick: async () => {
              if (!session) return;
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

  // -------------------------------------------------------------------- wire
  function wire(s: EditorSession): void {
    const nameEl = root.querySelector('#tb-name') as HTMLElement;
    const modeEl = root.querySelector('#tb-mode') as HTMLElement;
    const saveEl = root.querySelector('#tb-save') as HTMLElement;
    const presenceEl = root.querySelector('#tb-presence') as HTMLElement;
    const statusEl = root.querySelector('#vp-status') as HTMLElement;
    const viewsEl = root.querySelector('#vp-views') as HTMLElement;

    // project name (rename on click)
    const refreshName = (): void => {
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

    // save state — the badge is also the door into the cloud report: "✕ Error"
    // on its own told nobody what was actually broken.
    unsubs.push(s.syncError.subscribe((error) => { saveEl.title = `${error ?? 'Project save status'} — click for cloud diagnostics`; }));
    saveEl.style.cursor = 'pointer';
    saveEl.onclick = () => void openCloudDiagnosticsModal(s);
    unsubs.push(
      s.saveState.subscribe((st) => {
        const map = { saved: '✓ Saved', saving: '… Saving', local: '💾 Local', offline: '⚠ Offline', error: '✕ Error' } as const;
        saveEl.textContent = map[st];
        saveEl.className = `badge ${st === 'saved' ? 'badge-ok' : st === 'offline' || st === 'error' ? 'badge-warn' : 'badge-dim'}`;
      }),
    );
    unsubs.push(s.online.subscribe((on) => { if (!on) s.saveState.set('offline'); }));

    // presence chips in the top bar
    unsubs.push(
      s.peers.subscribe((users) => {
        const me = s.user().id;
        const others = users.filter((u) => u.id !== me);
        presenceEl.innerHTML = [
          `<span class="peer" style="--c:#4ade80" title="You">●</span>`,
          ...others.map((u) => `<span class="peer" style="--c:${u.color}" title="${u.name}${u.editingObjectName ? ` — editing ${u.editingObjectName}` : ''}">●</span>`),
        ].join('');
        presenceEl.title = others.length ? `${others.map((u) => u.name).join(', ')} online` : 'Only you';
      }),
    );

    // viewport status line
    const refreshStatus = (): void => {
      const sel = s.selectedObject();
      const count = s.selection.count();
      const parts: string[] = [];
      if (count > 1) parts.push(`${count} selected`);
      else if (sel) parts.push(sel.name);
      parts.push(`${s.doc.objects.length} objects`);
      parts.push(s.gizmoSpace.get() === 'local' ? 'local' : 'world');
      if (s.snapSettings.get().enabled) parts.push(`snap ${s.snapSettings.get().grid}`);
      if (s.isSolo()) parts.push('SOLO');
      if (s.transformTarget.get() === 'pivot') parts.push('editing pivot');
      if (s.viewport.isFirstPerson()) parts.push('first-person');
      statusEl.textContent = parts.join(' · ');
    };
    unsubs.push(s.rev.subscribe(refreshStatus));
    unsubs.push(s.selection.subscribe(refreshStatus));
    unsubs.push(s.selection.subscribeIds(refreshStatus));
    unsubs.push(s.gizmoSpace.subscribe(refreshStatus));
    unsubs.push(s.snapSettings.subscribe(refreshStatus));
    refreshStatus();

    // viewport camera/view buttons
    viewsEl.innerHTML = `
      <button class="btn btn-xs" data-view="top" title="Top view (Alt+7)">Top</button>
      <button class="btn btn-xs" data-view="front" title="Front view (Alt+1)">Front</button>
      <button class="btn btn-xs" data-view="right" title="Right view (Alt+3)">Right</button>
      <button class="btn btn-xs" data-view="frame" title="Frame all (Shift+F)">⛶</button>
      <button class="btn btn-xs" data-view="bookmark" title="Save camera bookmark">🔖</button>`;
    viewsEl.querySelectorAll('[data-view]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        const v = (b as HTMLElement).dataset.view;
        const map: Record<string, [number, number]> = { top: [0, 1], front: [0, 90], right: [90, 90] };
        if (v === 'frame') {
          s.select(null);
          s.viewport.focusIds(null);
        } else if (v === 'bookmark') {
          const name = window.prompt('Bookmark name', `View ${s.doc.cameraBookmarks.length + 1}`);
          if (s.addCameraBookmark(name ?? undefined)) toast('Camera bookmark saved', 'success');
        } else if (v && map[v]) {
          s.viewport.setView(map[v][0], map[v][1]);
          s.persistCamera();
        }
      };
    });

    // ---------- viewport interaction ----------
    s.viewport.events.onSelect = (id, mods) => s.selectAt(id, mods);
    s.viewport.events.onLongPress = (x, y) => {
      const hit = s.viewport.raycastPointer([], x, y);
      if (hit?.objectId) s.toggleSelect(hit.objectId);
    };
    s.viewport.events.onDoubleTap = (x, y) => {
      const hit = s.viewport.raycastPointer([], x, y);
      if (hit?.objectId) {
        s.select(hit.objectId);
        s.frameSelection();
      }
    };
    s.viewport.events.onBoxSelect = (rect, additive) => s.boxSelect(rect, additive);
    s.viewport.events.onPointerMove = (x, y) => broadcastCursor(s, x, y);

    // drag & drop from the asset library (and files from the desktop)
    const wrapEl = root.querySelector('#vp-wrap') as HTMLElement;
    wrapEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      wrapEl.classList.add('drop-active');
    });
    wrapEl.addEventListener('dragleave', () => wrapEl.classList.remove('drop-active'));
    wrapEl.addEventListener('drop', (e) => {
      e.preventDefault();
      wrapEl.classList.remove('drop-active');
      const raw = e.dataTransfer?.getData('application/x-web3d-asset');
      const point = s.viewport.groundPointAt(e.clientX, e.clientY);
      if (raw) {
        try {
          const payload = JSON.parse(raw) as AssetDragPayload;
          void applyAssetPayload(s, payload, point ? { x: point.x, y: point.y, z: point.z } : null);
        } catch {
          toast('Could not read that asset', 'warn');
        }
        return;
      }
      const files = [...(e.dataTransfer?.files ?? [])];
      void handleDroppedFiles(s, files, point);
    });

    // ---------- panels ----------
    unsubs.push(buildRail(s, root.querySelector('#rail') as HTMLElement));
    unsubs.push(buildOutliner(s, root.querySelector('#outliner') as HTMLElement));
    unsubs.push(buildInspector(s, root.querySelector('#inspector') as HTMLElement));
    unsubs.push(buildTimeline(s, root.querySelector('#timeline') as HTMLElement, togglePlay));
    layout = attachLayout(root, s, togglePlay);
    unsubs.push(() => layout?.destroy());
    unsubs.push(mountPresenceOverlay(s, overlay));

    // ---------- mobile ----------
    if (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 860) {
      mobile = mountMobileUi(s, {
        togglePlay,
        enterPlayMode: () => void togglePlayMode(),
        exitPlayMode: () => play?.exit(),
        isPlayMode: () => !!play?.active,
      });
      unsubs.push(() => mobile?.destroy());
    }

    // ---------- top bar actions ----------
    (root.querySelector('#tb-back') as HTMLButtonElement).onclick = () => nav('#/');
    (root.querySelector('#tb-palette') as HTMLButtonElement).onclick = () => openCommandPalette(s);
    (root.querySelector('#tb-people') as HTMLButtonElement).onclick = () => layout?.toggle('presence');
    (root.querySelector('#tb-assets') as HTMLButtonElement).onclick = () => layout?.toggle('assets');
    (root.querySelector('#tb-dope') as HTMLButtonElement).onclick = () => layout?.toggle('animation');
    (root.querySelector('#tb-play') as HTMLButtonElement).onclick = () => void togglePlayMode();
    (root.querySelector('#tb-ai') as HTMLButtonElement).onclick = () => openAi(s);
    (root.querySelector('#tb-scripts') as HTMLButtonElement).onclick = () => openScripts(s);
    (root.querySelector('#tb-github') as HTMLButtonElement).onclick = () => openGithubMenu(s);
    (root.querySelector('#tb-menu') as HTMLButtonElement).onclick = () => openEditorMenu(s, chrome);

    // ---------- command host (palette → editor actions) ----------
    setCommandHost({
      session: s,
      togglePlay,
      togglePanel: (name) => {
        if (mobile && (name === 'assets' || name === 'presence' || name === 'rail')) mobile.open(name === 'assets' ? 'assets' : name === 'presence' ? 'people' : 'more');
        else layout?.toggle(name as CommandPanelName & 'rail');
      },
      resetLayout: () => layout?.reset(),
      enterPlayMode: () => void togglePlayMode(),
      exitPlayMode: () => play?.exit(),
      openImportBackup: () => void s.importProjectBackupFile(),
      isPlayMode: () => !!play?.active,
    });

    // ---------- autosave + persistence ----------
    autosave = setInterval(() => {
      if (!session || session.isDisposed) return;
      void session.localSave();
      if (navigator.onLine) void session.cloudSave();
    }, 20000);
    window.addEventListener('beforeunload', onBeforeUnload);

    chrome = attachAutoHideChrome(root, { idleMs: 1600 });
  }

  function onBeforeUnload(): void {
    if (!session) return;
    void session.localSave();
    try {
      localStorage.removeItem(`${HEARTBEAT_KEY}${projectId}`);
    } catch {
      /* ignore */
    }
  }

  // ---------- rail (desktop tool column) ----------
  function buildRail(s: EditorSession, el: HTMLElement): () => void {
    const prims: { k: PrimitiveType; icon: string; label: string }[] = [
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
        ${toolButton('data-ract="space" title="Local / world space (X)"', '🌐', 'Space', 'X')}
        ${toolButton('data-ract="snap" title="Snap to grid (Shift+S)"', '🧲', 'Snap')}
        ${toolButton('data-ract="pivot" title="Edit the transform origin"', '✥', 'Pivot')}
      </div>
      <div class="rail-section" role="group" aria-label="Add shapes">
        <div class="rail-title">Create</div>
        ${prims.map((p) => toolButton(`data-prim="${p.k}" title="Add ${p.label}"`, p.icon, p.label)).join('')}
      </div>
      <div class="rail-section" role="group" aria-label="Scene actions">
        <div class="rail-title">Scene</div>
        ${toolButton('data-ract="group" title="Wrap the selection in a Group (Ctrl+G)"', '🗂', 'Group')}
        ${toolButton('data-ract="light" title="Add a light"', '💡', 'Light')}
        ${toolButton('data-ract="import" title="Import GLB"', '📥', 'Import')}
        ${toolButton('data-ract="focus" title="Frame selected (F)"', '🎯', 'Focus', 'F')}
        ${toolButton('data-ract="solo" title="Isolate the selection (/)"', '◉', 'Solo', '/')}
      </div>
      <div class="rail-section" role="group" aria-label="History">
        <div class="rail-title">History</div>
        ${toolButton('data-ract="undo" title="Undo (Ctrl+Z)"', '↩', 'Undo')}
        ${toolButton('data-ract="undoMine" title="Undo my last change — asks first if a collaborator edited after it"', '↩', 'Mine')}
        ${toolButton('data-ract="redo" title="Redo (Ctrl+Shift+Z)"', '↪', 'Redo')}
      </div>`;

    const sync = (): void => {
      el.querySelectorAll('[data-tmode]').forEach((b) => {
        b.classList.toggle('active', s.transformMode.get() === (b as HTMLElement).dataset.tmode);
      });
      el.querySelector('[data-ract="space"]')?.classList.toggle('active', s.gizmoSpace.get() === 'local');
      el.querySelector('[data-ract="snap"]')?.classList.toggle('active', s.snapSettings.get().enabled);
      el.querySelector('[data-ract="pivot"]')?.classList.toggle('active', s.transformTarget.get() === 'pivot');
      el.querySelector('[data-ract="solo"]')?.classList.toggle('active', s.isSolo());
      // history buttons: say whose change will be reverted
      const undo = el.querySelector('[data-ract="undo"]');
      const mine = el.querySelector('[data-ract="undoMine"]');
      const redo = el.querySelector('[data-ract="redo"]');
      const info = s.undoPreview();
      const label = info ? info.label : '';
      undo?.setAttribute('title', info ? `Undo ${label} (Ctrl+Z)` : 'Undo (Ctrl+Z)');
      mine?.setAttribute('title', info ? `Undo my last change: ${label}` : 'Undo my last change');
      redo?.setAttribute('title', s.history.canRedo() ? 'Redo (Ctrl+Shift+Z)' : 'Redo (Ctrl+Shift+Z)');
      const peers = info?.peerEdits ?? 0;
      mine?.classList.toggle('warn', peers > 0);
      (mine as HTMLButtonElement | null)?.toggleAttribute('disabled', !s.history.canUndo());
      (redo as HTMLButtonElement | null)?.toggleAttribute('disabled', !s.history.canRedo());
    };

    el.querySelectorAll('[data-tmode]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.setTransformMode((b as HTMLElement).dataset.tmode as TransformMode);
    });
    el.querySelectorAll('[data-prim]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.addPrimitive((b as HTMLElement).dataset.prim as PrimitiveType);
    });
    const acts: Record<string, () => void> = {
      space: () => s.setGizmoSpace(s.gizmoSpace.get() === 'world' ? 'local' : 'world'),
      snap: () => s.setSnapSettings({ enabled: !s.snapSettings.get().enabled }),
      pivot: () => s.setTransformTarget(s.transformTarget.get() === 'pivot' ? 'object' : 'pivot'),
      group: () => (s.selection.count() ? s.groupSelection() : s.addGroup()),
      light: () => s.addLight(),
      focus: () => s.frameSelection(),
      solo: () => (s.isSolo() ? s.exitSolo() : s.soloSelection()),
      undo: () => s.undo(),
      undoMine: () => s.undoMine(),
      redo: () => s.redo(),
      import: () => void importGlb(s),
    };
    el.querySelectorAll('[data-ract]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.ract as string]?.();
    });

    const u1 = s.transformMode.subscribe(sync);
    const u2 = s.gizmoSpace.subscribe(sync);
    const u3 = s.snapSettings.subscribe(sync);
    const u4 = s.transformTarget.subscribe(sync);
    const u5 = s.rev.subscribe(sync);
    const prevOnChange = s.history.onChange;
    s.history.onChange = () => {
      prevOnChange?.();
      sync();
    };
    sync();
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      s.history.onChange = prevOnChange;
    };
  }

  // ------------------------------------------------------------- file helpers
  async function importGlb(s: EditorSession): Promise<void> {
    const files = await pickFiles('.glb,.gltf,model/gltf-binary');
    for (const f of files) {
      toast(`Importing ${f.name}…`);
      await s.importGlbFile(f);
    }
  }

  async function handleDroppedFiles(s: EditorSession, files: File[], point: { x: number; y: number; z: number } | null): Promise<void> {
    for (const f of files) {
      const name = f.name.toLowerCase();
      if (name.endsWith('.glb') || name.endsWith('.gltf')) {
        toast(`Importing ${f.name}…`);
        const created = await s.importGlbFile(f);
        if (created && point) s.setTransform(created.id, point);
      } else if (f.type.startsWith('image/')) {
        // unique-per-selection materials so the image only lands on what the
        // user selected — never on every object sharing the material
        const mats = s.makeSelectionMaterialsUnique();
        if (!mats.length) {
          toast('Select an object to texture it', 'warn');
          continue;
        }
        toast(`Applying ${f.name}…`);
        for (const m of mats) await s.uploadTexture(m.id, f, 'base');
        toast('Texture applied', 'success');
      } else if (name.endsWith('.3dproject') || f.type === 'application/json') {
        toast('Reading backup…');
        await s.importProjectBackupFile();
      }
    }
  }

  // ------------------------------------------------------------------ menus
  function openEditorMenu(s: EditorSession, chromeRef: AutoHideChrome | null): void {
    const body = document.createElement('div');
    body.className = 'menu-list';
    const items: { label: string; fn: () => void }[] = [
      { label: '⌘ Command palette (Ctrl+K)', fn: () => openCommandPalette(s) },
      { label: 'Save now', fn: () => void s.forceSave().then(() => toast('Saved', 'success')) },
      { label: chromeRef?.isEnabled() ? 'Exit fullscreen' : 'Fullscreen (auto-hide chrome)', fn: () => void chromeRef?.toggle() },
      { label: 'Open AI Studio', fn: () => openAi(s) },
      { label: 'Open Scripts', fn: () => openScripts(s) },
      { label: 'Import GLB', fn: () => void importGlb(s) },
      { label: 'Export / download…', fn: () => openExportModal(s) },
      { label: 'Share project…', fn: () => openShareModal(s) },
      { label: 'GitHub import / export', fn: () => openGithubMenu(s) },
      { label: 'Members & invites', fn: () => openMembersModal(s) },
      { label: 'Version history', fn: () => openVersionsModal(s) },
      { label: 'Reset panel layout', fn: () => layout?.reset() },
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

  window.addEventListener('keydown', keyHandler);
  void boot();
  void runCommand; // keep the registry import meaningful for tree-shaking

  return () => {
    cancelled = true;
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (heartbeat) clearInterval(heartbeat);
    if (autosave) clearInterval(autosave);
    try {
      localStorage.removeItem(`${HEARTBEAT_KEY}${projectId}`);
    } catch {
      /* ignore */
    }
    unsubs.forEach((u) => {
      try {
        u();
      } catch {
        /* noop */
      }
    });
    setCommandHost(null);
    setEditorSession(null);
    closeFloatWin('ai-studio');
    closeFloatWin('scripts');
    play?.exit();
    session?.dispose();
    session = null;
    root.innerHTML = '';
  };
}

function openAi(s: EditorSession): void {
  void import('./ai-panel.js').then(({ toggleAiPanel }) => toggleAiPanel(s));
}

function openScripts(s: EditorSession): void {
  void import('./script-panel.js').then(({ toggleScriptPanel }) => toggleScriptPanel(s));
}
