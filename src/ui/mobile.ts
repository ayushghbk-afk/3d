import type { EditorSession } from '../editor/session.js';
import type { PrimitiveType } from '../state/models.js';
import { buildOutliner } from './outliner.js';
import { buildInspector } from './inspector.js';
import { buildAssetBrowser } from './asset-browser.js';
import { buildPresence } from './presence.js';
import { openCommandPalette } from './command-palette.js';
import { openExportModal, openShareModal } from './panels-extra.js';
import { openVersionsModal, openShortcutsModal } from './panels.js';
import { toast } from './toast.js';

/**
 * Mobile editing mode.
 *
 * The desktop layout is a three-column editor; on phones that becomes a
 * bottom-sheet workflow (Add · Object · AI · More) with a transform bar and a
 * transport row, so the 3D view keeps most of the screen.
 */

export type MobileSheet = 'none' | 'add' | 'object' | 'ai' | 'more' | 'assets' | 'people';

export interface MobileActions {
  togglePlay: () => void;
  enterPlayMode: () => void;
  isPlayMode: () => boolean;
  exitPlayMode: () => void;
}

export interface MobileUi {
  open(sheet: MobileSheet): void;
  close(): void;
  current(): MobileSheet;
  destroy(): void;
}

const SHEETS: { id: MobileSheet; icon: string; label: string }[] = [
  { id: 'add', icon: '＋', label: 'Add' },
  { id: 'object', icon: '🎛', label: 'Object' },
  { id: 'ai', icon: '✨', label: 'AI' },
  { id: 'more', icon: '⋮', label: 'More' },
];

export function mountMobileUi(s: EditorSession, actions: MobileActions): MobileUi {
  let current: MobileSheet = 'none';
  let disposeContent: (() => void) | null = null;

  const bar = document.createElement('div');
  bar.className = 'mobile-bar';
  bar.innerHTML = `
    <div class="mobile-transform" role="group" aria-label="Transform tool">
      <button class="btn btn-sm" data-mt="translate" title="Move">↔ Move</button>
      <button class="btn btn-sm" data-mt="rotate" title="Rotate">🔄 Rotate</button>
      <button class="btn btn-sm" data-mt="scale" title="Scale">📐 Scale</button>
      <button class="btn btn-sm" data-mt="space" title="Local / world space">🌐</button>
      <button class="btn btn-sm" data-mt="snap" title="Snapping">🧲</button>
    </div>
    <div class="mobile-transport" role="group" aria-label="Playback">
      <button class="btn btn-icon btn-sm" data-mp="prev" title="Previous keyframe">⏮</button>
      <button class="btn btn-icon btn-sm" data-mp="play" title="Play / pause">▶</button>
      <button class="btn btn-icon btn-sm" data-mp="next" title="Next keyframe">⏭</button>
      <button class="btn btn-sm" data-mp="key" title="Add keyframe">◉ Key</button>
      <button class="btn btn-sm ${s.autoKey.get() ? 'rec-on' : ''}" data-mp="rec" title="Auto-key">⏺</button>
      <span class="mobile-frame muted small" data-mp="frame">0</span>
    </div>`;

  const nav = document.createElement('nav');
  nav.className = 'mobile-nav';
  nav.setAttribute('aria-label', 'Mobile tools');
  nav.innerHTML = SHEETS.map(
    (t) => `<button class="mobile-nav-btn" data-sheet="${t.id}"><span class="mobile-nav-icon">${t.icon}</span><span class="mobile-nav-label">${t.label}</span></button>`,
  ).join('');

  const sheet = document.createElement('div');
  sheet.className = 'mobile-sheet';
  sheet.innerHTML = `
    <div class="mobile-sheet-handle" data-sheet-handle><span></span></div>
    <div class="mobile-sheet-body"></div>`;

  document.body.appendChild(bar);
  document.body.appendChild(nav);
  document.body.appendChild(sheet);

  const bodyEl = sheet.querySelector('.mobile-sheet-body') as HTMLElement;

  function renderSheet(): void {
    disposeContent?.();
    disposeContent = null;
    bodyEl.innerHTML = '';
    if (current === 'none') {
      sheet.classList.remove('open');
      nav.querySelectorAll('.mobile-nav-btn').forEach((b) => b.classList.remove('active'));
      return;
    }
    sheet.classList.add('open');
    nav.querySelectorAll('[data-sheet]').forEach((b) => {
      b.classList.toggle('active', (b as HTMLElement).dataset.sheet === current);
    });

    if (current === 'add') {
      const prims: { kind: PrimitiveType; label: string; icon: string }[] = [
        { kind: 'cube', label: 'Cube', icon: '▣' },
        { kind: 'sphere', label: 'Sphere', icon: '●' },
        { kind: 'cylinder', label: 'Cylinder', icon: '▤' },
        { kind: 'cone', label: 'Cone', icon: '▲' },
        { kind: 'plane', label: 'Plane', icon: '▱' },
        { kind: 'torus', label: 'Torus', icon: '◎' },
      ];
      bodyEl.innerHTML = `
        <div class="sheet-title">Add to scene</div>
        <div class="add-grid">
          ${prims.map((p) => `<button class="btn add-cell" data-add="${p.kind}">${p.icon} ${p.label}</button>`).join('')}
          <button class="btn add-cell" data-mact="group">🗂 Group</button>
          <button class="btn add-cell" data-mact="light">💡 Light</button>
          <button class="btn add-cell" data-mact="import">📥 Import GLB</button>
          <button class="btn add-cell" data-mact="assets">📚 Assets</button>
        </div>
        <div class="sheet-title">Edit</div>
        <div class="add-grid">
          <button class="btn add-cell" data-mact="duplicate">⧉ Duplicate</button>
          <button class="btn add-cell" data-mact="delete">🗑 Delete</button>
          <button class="btn add-cell" data-mact="frame">🎯 Frame</button>
          <button class="btn add-cell" data-mact="drop">⬇ Drop to ground</button>
        </div>`;
      bodyEl.querySelectorAll('[data-add]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => {
          s.addPrimitive((b as HTMLElement).dataset.add as PrimitiveType);
          toast('Added', 'success');
        };
      });
      const acts: Record<string, () => void> = {
        group: () => (s.selection.count() ? s.groupSelection() : s.addGroup()),
        light: () => s.addLight('point'),
        import: () => void importModel(s),
        assets: () => open('assets'),
        duplicate: () => s.duplicateSelection(),
        delete: () => s.deleteSelection(),
        frame: () => s.frameSelection(),
        drop: () => s.dropToGround(),
      };
      bodyEl.querySelectorAll('[data-mact]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.mact as string]?.();
      });
      return;
    }

    if (current === 'object') {
      bodyEl.innerHTML = `
        <div class="sheet-title">Scene</div>
        <div class="mobile-outliner"></div>
        <div class="sheet-title">Properties</div>
        <div class="mobile-inspector"></div>`;
      const outEl = bodyEl.querySelector('.mobile-outliner') as HTMLElement;
      const inspEl = bodyEl.querySelector('.mobile-inspector') as HTMLElement;
      const d1 = buildOutliner(s, outEl);
      const d2 = buildInspector(s, inspEl);
      disposeContent = () => {
        d1();
        d2();
      };
      return;
    }

    if (current === 'ai') {
      bodyEl.innerHTML = `
        <div class="sheet-title">AI</div>
        <div class="menu-list">
          <button class="btn btn-block menu-item" data-mai="studio">✨ AI Studio</button>
          <button class="btn btn-block menu-item" data-mai="scene">🏗 Build a scene from text</button>
          <button class="btn btn-block menu-item" data-mai="style">🎭 Restyle the scene</button>
          <button class="btn btn-block menu-item" data-mai="texture">🖌 Generate texture…</button>
          <button class="btn btn-block menu-item" data-mai="optimize">⚡ Optimize scene</button>
          <button class="btn btn-block menu-item" data-mai="scripts">{ } Scripts</button>
        </div>`;
      const acts: Record<string, () => void | Promise<void>> = {
        studio: () => void import('./ai-panel.js').then(({ openAiPanel }) => openAiPanel(s)),
        scene: () => void import('./ai-scene-ui.js').then(({ promptSceneDescription }) => promptSceneDescription(s)),
        style: () => void import('./ai-scene-ui.js').then(({ promptSceneStyle }) => promptSceneStyle(s)),
        texture: () => {
          const p = window.prompt('Describe the texture', 'brushed metal, seamless');
          if (!p) return;
          toast('Generating texture…');
          void s.generateTexture(p).then(
            () => toast('Texture ready', 'success'),
            (e: Error) => toast(`Failed: ${e.message}`, 'warn'),
          );
        },
        optimize: () => void s.optimizeScene(),
        scripts: () => void import('./script-panel.js').then(({ openScriptPanel }) => openScriptPanel(s)),
      };
      bodyEl.querySelectorAll('[data-mai]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => void acts[(b as HTMLElement).dataset.mai as string]?.();
      });
      return;
    }

    if (current === 'more') {
      bodyEl.innerHTML = `
        <div class="sheet-title">More</div>
        <div class="menu-list">
          <button class="btn btn-block menu-item" data-mmore="palette">⌘ Command palette</button>
          <button class="btn btn-block menu-item" data-mmore="save">💾 Save now</button>
          <button class="btn btn-block menu-item" data-mmore="export">📦 Export / download</button>
          <button class="btn btn-block menu-item" data-mmore="share">🔗 Share</button>
          <button class="btn btn-block menu-item" data-mmore="play">${actions.isPlayMode() ? '■ Exit Play Mode' : '▶ Play Mode'}</button>
          <button class="btn btn-block menu-item" data-mmore="people">👥 People & activity</button>
          <button class="btn btn-block menu-item" data-mmore="versions">🕘 Version history</button>
          <button class="btn btn-block menu-item" data-mmore="undo">↩ Undo</button>
          <button class="btn btn-block menu-item" data-mmore="redo">↪ Redo</button>
          <button class="btn btn-block menu-item" data-mmore="shortcuts">⌨ Shortcuts</button>
        </div>`;
      const acts: Record<string, () => void> = {
        palette: () => openCommandPalette(s),
        save: () => void s.forceSave().then(() => toast('Saved', 'success')),
        export: () => openExportModal(s),
        share: () => openShareModal(s),
        play: () => (actions.isPlayMode() ? actions.exitPlayMode() : actions.enterPlayMode()),
        people: () => open('people'),
        versions: () => openVersionsModal(s),
        undo: () => s.undo(),
        redo: () => s.redo(),
        shortcuts: () => openShortcutsModal(),
      };
      bodyEl.querySelectorAll('[data-mmore]').forEach((b) => {
        (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.mmore as string]?.();
      });
      return;
    }

    if (current === 'assets') {
      bodyEl.innerHTML = '<div class="mobile-assets"></div>';
      const el = bodyEl.querySelector('.mobile-assets') as HTMLElement;
      disposeContent = buildAssetBrowser(s, el, { onClose: () => open('add') });
      return;
    }

    if (current === 'people') {
      bodyEl.innerHTML = '<div class="mobile-people"></div>';
      const el = bodyEl.querySelector('.mobile-people') as HTMLElement;
      disposeContent = buildPresence(s, el, { onClose: () => open('more') });
      return;
    }
  }

  function open(next: MobileSheet): void {
    current = current === next ? 'none' : next;
    renderSheet();
  }

  function close(): void {
    if (current === 'none') return;
    current = 'none';
    renderSheet();
  }

  nav.querySelectorAll('[data-sheet]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => open((b as HTMLElement).dataset.sheet as MobileSheet);
  });
  (sheet.querySelector('[data-sheet-handle]') as HTMLElement).onclick = () => close();
  // swipe the sheet down to dismiss
  let sheetStart: number | null = null;
  sheet.addEventListener('pointerdown', (e) => {
    sheetStart = e.clientY;
  });
  sheet.addEventListener('pointerup', (e) => {
    if (sheetStart !== null && e.clientY - sheetStart > 90) close();
    sheetStart = null;
  });

  // transform bar
  bar.querySelectorAll('[data-mt]').forEach((b) => {
    const act = (b as HTMLElement).dataset.mt;
    (b as HTMLButtonElement).onclick = () => {
      if (act === 'translate' || act === 'rotate' || act === 'scale') s.setTransformMode(act);
      else if (act === 'space') {
        s.setGizmoSpace(s.gizmoSpace.get() === 'world' ? 'local' : 'world');
        toast(`Space: ${s.gizmoSpace.get()}`, 'info');
      } else if (act === 'snap') {
        s.setSnapSettings({ enabled: !s.snapSettings.get().enabled });
        toast(`Snap ${s.snapSettings.get().enabled ? 'on' : 'off'}`, 'info');
      }
      syncTransformBar();
    };
  });
  bar.querySelectorAll('[data-mp]').forEach((b) => {
    const act = (b as HTMLElement).dataset.mp;
    (b as HTMLButtonElement).onclick = () => {
      if (act === 'play') actions.togglePlay();
      else if (act === 'prev') s.gotoPrevKey();
      else if (act === 'next') s.gotoNextKey();
      else if (act === 'key') s.addKeyframeAll();
      else if (act === 'rec') s.autoKey.set(!s.autoKey.get());
      syncTransport();
    };
  });

  function syncTransformBar(): void {
    bar.querySelectorAll('[data-mt]').forEach((b) => {
      const act = (b as HTMLElement).dataset.mt;
      const on =
        (act === 'translate' || act === 'rotate' || act === 'scale') ? s.transformMode.get() === act
          : act === 'space' ? s.gizmoSpace.get() === 'local'
            : s.snapSettings.get().enabled;
      b.classList.toggle('active', on);
    });
  }
  function syncTransport(): void {
    const play = bar.querySelector('[data-mp="play"]') as HTMLButtonElement | null;
    if (play) play.textContent = s.playback.playing ? '⏸' : '▶';
    const frame = bar.querySelector('[data-mp="frame"]') as HTMLElement | null;
    const clip = s.doc.clips.find((c) => c.id === s.doc.activeClipId);
    if (frame && clip) frame.textContent = `${s.playback.frame}/${clip.length}`;
    const rec = bar.querySelector('[data-mp="rec"]') as HTMLButtonElement | null;
    rec?.classList.toggle('rec-on', s.autoKey.get());
  }

  const u1 = s.transformMode.subscribe(syncTransformBar);
  const u2 = s.gizmoSpace.subscribe(syncTransformBar);
  const u3 = s.snapSettings.subscribe(syncTransformBar);
  const u4 = s.anim.subscribe(syncTransport);
  const u5 = s.autoKey.subscribe(syncTransport);
  syncTransformBar();
  syncTransport();

  return {
    open,
    close,
    current: () => current,
    destroy(): void {
      u1();
      u2();
      u3();
      u4();
      u5();
      disposeContent?.();
      bar.remove();
      nav.remove();
      sheet.remove();
    },
  };
}

async function importModel(s: EditorSession): Promise<void> {
  const { pickFiles } = await import('../lib/utils.js');
  const files = await pickFiles('.glb,.gltf,model/gltf-binary');
  for (const f of files) {
    toast(`Importing ${f.name}…`);
    await s.importGlbFile(f);
  }
}
