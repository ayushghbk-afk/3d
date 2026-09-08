// Floating windows: draggable, resizable, collapsible panels that hover above
// the viewport (z-index below modal dialogs) so you can work with the AI
// while still seeing and orbiting the scene behind it. Position/size persist
// per window id in localStorage. Pointer Events unify mouse + touch.
import { toast } from './toast.js';

export interface FloatWinOpts {
  id: string;
  title: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  onClose?: () => void;
}

export interface FloatWin {
  id: string;
  el: HTMLElement;
  body: HTMLElement;
  close: () => void;
  focus: () => void;
  setCollapsed: (collapsed: boolean) => void;
  isCollapsed: () => boolean;
}

interface WinGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
}

const wins = new Map<string, FloatWin>();
let zTop = 90;
let cascade = 0;

const STORE_KEY = 'w3d.floatwin.v1';

function loadGeom(): Record<string, WinGeom> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, WinGeom>;
  } catch {
    return {};
  }
}

function saveGeom(id: string, geom: WinGeom): void {
  try {
    const all = loadGeom();
    all[id] = geom;
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* private mode — layout just won't persist */
  }
}

function root(): HTMLElement {
  let el = document.getElementById('float-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'float-root';
    document.body.appendChild(el);
  }
  return el;
}

function clampGeom(g: WinGeom, minW: number, minH: number): WinGeom {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(minW, Math.min(vw - 16, g.w));
  const h = Math.max(minH, Math.min(vh - 16, g.h));
  // Keep at least the title bar reachable.
  const x = Math.max(8 - w + 120, Math.min(vw - 60, g.x));
  const y = Math.max(8, Math.min(vh - 60, g.y));
  return { ...g, x, y, w, h };
}

export function getFloatWin(id: string): FloatWin | null {
  return wins.get(id) ?? null;
}

export function closeFloatWin(id: string): void {
  wins.get(id)?.close();
}

export function openFloatWin(opts: FloatWinOpts): FloatWin {
  pruneDetached(opts.id);
  const existing = wins.get(opts.id);
  if (existing) {
    existing.focus();
    return existing;
  }
  const minW = opts.minWidth ?? 300;
  const minH = opts.minHeight ?? 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const narrow = vw <= 760;
  const saved = loadGeom()[opts.id];
  const cascadeOff = (cascade++ % 6) * 32;
  let geom = clampGeom(
    saved ?? {
      x: narrow ? 8 : Math.max(8, vw - (opts.width ?? 560) - 40 - cascadeOff),
      y: narrow ? vh - Math.min(vh - 140, opts.height ?? 480) - 76 : 70 + cascadeOff,
      w: narrow ? vw - 16 : (opts.width ?? 560),
      h: narrow ? Math.min(vh - 160, opts.height ?? 480) : (opts.height ?? 480),
      collapsed: false,
    },
    minW,
    minH,
  );

  const el = document.createElement('section');
  el.className = 'floatwin';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', opts.title);
  el.innerHTML = `
    <header class="floatwin-header">
      <span class="floatwin-title"></span>
      <span class="floatwin-btns">
        <button class="btn btn-xs floatwin-collapse" title="Collapse / expand" aria-label="Collapse">—</button>
        <button class="btn btn-xs floatwin-close" title="Close" aria-label="Close">✕</button>
      </span>
    </header>
    <div class="floatwin-body"></div>
    <div class="floatwin-resize" title="Resize"></div>`;
  (el.querySelector('.floatwin-title') as HTMLElement).textContent = opts.title;
  const body = el.querySelector('.floatwin-body') as HTMLElement;
  const header = el.querySelector('.floatwin-header') as HTMLElement;
  const collapseBtn = el.querySelector('.floatwin-collapse') as HTMLButtonElement;
  const closeBtn = el.querySelector('.floatwin-close') as HTMLButtonElement;
  const resizeHandle = el.querySelector('.floatwin-resize') as HTMLElement;

  const applyGeom = (): void => {
    el.style.left = `${geom.x}px`;
    el.style.top = `${geom.y}px`;
    el.style.width = `${geom.w}px`;
    if (!geom.collapsed) el.style.height = `${geom.h}px`;
    else el.style.height = 'auto';
    body.style.display = geom.collapsed ? 'none' : '';
    resizeHandle.style.display = geom.collapsed ? 'none' : '';
    collapseBtn.textContent = geom.collapsed ? '+' : '—';
  };

  const win: FloatWin = {
    id: opts.id,
    el,
    body,
    close: () => {
      if (!wins.has(opts.id)) return;
      wins.delete(opts.id);
      el.remove();
      try {
        opts.onClose?.();
      } catch (e) {
        console.warn('floatwin onClose failed', e);
      }
    },
    focus: () => {
      zTop += 1;
      el.style.zIndex = String(zTop);
    },
    setCollapsed: (collapsed: boolean) => {
      geom.collapsed = collapsed;
      applyGeom();
      saveGeom(opts.id, geom);
    },
    isCollapsed: () => geom.collapsed,
  };

  collapseBtn.onclick = () => win.setCollapsed(!geom.collapsed);
  closeBtn.onclick = () => win.close();
  el.addEventListener('pointerdown', () => win.focus(), { capture: true });

  // --- drag by the title bar ---
  header.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    win.focus();
    const startX = e.clientX - geom.x;
    const startY = e.clientY - geom.y;
    const move = (m: PointerEvent): void => {
      geom = clampGeom({ ...geom, x: m.clientX - startX, y: m.clientY - startY }, minW, minH);
      applyGeom();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      saveGeom(opts.id, geom);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // --- resize by the corner handle ---
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    win.focus();
    const startW = geom.w;
    const startH = geom.h;
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (m: PointerEvent): void => {
      geom = clampGeom({ ...geom, w: startW + (m.clientX - startX), h: startH + (m.clientY - startY) }, minW, minH);
      applyGeom();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      saveGeom(opts.id, geom);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // Keep inside the viewport on browser resize/rotation.
  const onViewResize = (): void => {
    if (!wins.has(opts.id)) {
      window.removeEventListener('resize', onViewResize);
      return;
    }
    const fixed = clampGeom(geom, minW, minH);
    if (fixed.x !== geom.x || fixed.y !== geom.y || fixed.w !== geom.w || fixed.h !== geom.h) {
      geom = fixed;
      applyGeom();
    }
  };
  window.addEventListener('resize', onViewResize);

  applyGeom();
  root().appendChild(el);
  wins.set(opts.id, win);
  win.focus();
  if (geom.collapsed) applyGeom();
  return win;
}

/** Drop map entries whose element was removed without close() (page/route teardown). */
function pruneDetached(id: string): void {
  const win = wins.get(id);
  if (win && !document.contains(win.el)) wins.delete(id);
}

/** Convenience: toast-safe toggle used by toolbar buttons. */
export function toggleFloatWin(opts: FloatWinOpts, render: (win: FloatWin) => void): FloatWin | null {
  pruneDetached(opts.id);
  const existing = wins.get(opts.id);
  if (existing) {
    existing.close();
    return null;
  }
  try {
    const win = openFloatWin(opts);
    render(win);
    return win;
  } catch (e) {
    toast(`Could not open panel: ${(e as Error).message}`, 'error');
    return null;
  }
}
