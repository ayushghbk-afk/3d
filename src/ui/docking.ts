// Editor docking: the outliner / inspector / timeline can be resized by
// dragging their edges and collapsed (double-click an edge or use the arrow).
// Layout persists per browser in localStorage. Pointer Events unify mouse +
// touch; handles hide on narrow screens where panels become sheets.
export interface DockLayout {
  outlinerW: number;
  inspectorW: number;
  timelineH: number;
  outlinerHidden: boolean;
  inspectorHidden: boolean;
  timelineHidden: boolean;
}

const STORE_KEY = 'w3d.layout.v1';
const MIN_SIDE = 180;
const MAX_SIDE = 520;
const MIN_TL = 46;
const MAX_TL = 420;

export function defaultDockLayout(): DockLayout {
  return {
    outlinerW: 264,
    inspectorW: 264,
    timelineH: 168,
    outlinerHidden: false,
    inspectorHidden: false,
    timelineHidden: false,
  };
}

export function loadDockLayout(): DockLayout {
  const d = defaultDockLayout();
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<DockLayout> | null;
    if (!raw || typeof raw !== 'object') return d;
    return {
      outlinerW: clampNum(raw.outlinerW, MIN_SIDE, MAX_SIDE, d.outlinerW),
      inspectorW: clampNum(raw.inspectorW, MIN_SIDE, MAX_SIDE, d.inspectorW),
      timelineH: clampNum(raw.timelineH, MIN_TL, MAX_TL, d.timelineH),
      outlinerHidden: raw.outlinerHidden === true,
      inspectorHidden: raw.inspectorHidden === true,
      timelineHidden: raw.timelineHidden === true,
    };
  } catch {
    return d;
  }
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

export function clampSide(px: number): number {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, px));
}

export function clampTimeline(px: number): number {
  return Math.max(MIN_TL, Math.min(MAX_TL, px));
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function saveDockLayout(layout: DockLayout): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(layout));
    } catch {
      /* private mode */
    }
  }, 300);
}

interface DockTargets {
  outliner: HTMLElement;
  inspector: HTMLElement;
  timeline: HTMLElement;
  mainEl: HTMLElement;
  editor: HTMLElement;
}

export function attachDocking(root: HTMLElement): () => void {
  const q = (sel: string): HTMLElement | null => root.querySelector(sel) as HTMLElement | null;
  const outliner = q('#outliner');
  const inspector = q('#inspector');
  const timeline = q('#timeline');
  const main = q('.editor-main');
  const editor = q('.editor');
  if (!outliner || !inspector || !timeline || !main || !editor) return () => undefined;
  const t: DockTargets = { outliner, inspector, timeline, mainEl: main, editor };
  const layout = loadDockLayout();
  const cleanups: (() => void)[] = [];

  // Side panels: edge handles inside .editor-main.
  cleanups.push(
    edgeHandle(main, 'left', () => layout.outlinerW, (w) => { layout.outlinerW = w; relayout(); saveDockLayout(layout); },
      () => { layout.outlinerHidden = !layout.outlinerHidden; relayout(); saveDockLayout(layout); },
      'Outliner'),
    edgeHandle(main, 'right', () => layout.inspectorW, (w) => { layout.inspectorW = w; relayout(); saveDockLayout(layout); },
      () => { layout.inspectorHidden = !layout.inspectorHidden; relayout(); saveDockLayout(layout); },
      'Inspector'),
  );

  // Timeline: top-edge handle inside .editor (footer sits below .editor-main).
  const tlHandle = document.createElement('div');
  tlHandle.className = 'dock-handle dock-handle-top';
  tlHandle.title = 'Drag to resize timeline · double-click to hide';
  tlHandle.setAttribute('role', 'separator');
  tlHandle.setAttribute('aria-label', 'Resize timeline');
  const tlBtn = document.createElement('button');
  tlBtn.className = 'btn btn-xs dock-collapse';
  tlBtn.textContent = '⌄';
  tlBtn.title = 'Hide / show timeline';
  tlBtn.setAttribute('aria-label', 'Toggle timeline');
  tlHandle.appendChild(tlBtn);
  editor.appendChild(tlHandle);
  tlHandle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = layout.timelineH;
    const move = (m: PointerEvent): void => {
      layout.timelineH = clampTimeline(startH + (startY - m.clientY));
      layout.timelineHidden = false;
      relayout();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      saveDockLayout(layout);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  tlHandle.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    layout.timelineHidden = !layout.timelineHidden;
    relayout();
    saveDockLayout(layout);
  });
  tlBtn.onclick = () => {
    layout.timelineHidden = !layout.timelineHidden;
    relayout();
    saveDockLayout(layout);
  };
  cleanups.push(() => tlHandle.remove());

  // Restore strips for hidden side panels.
  const mkStrip = (cls: string, label: string, show: () => void): HTMLElement => {
    const b = document.createElement('button');
    b.className = `btn btn-sm dock-strip ${cls}`;
    b.textContent = label;
    b.onclick = show;
    main.appendChild(b);
    cleanups.push(() => b.remove());
    return b;
  };
  const stripL = mkStrip('dock-strip-l', '›', () => {
    layout.outlinerHidden = false;
    relayout();
    saveDockLayout(layout);
  });
  stripL.title = 'Show outliner';
  stripL.setAttribute('aria-label', 'Show outliner');
  const stripR = mkStrip('dock-strip-r', '‹', () => {
    layout.inspectorHidden = false;
    relayout();
    saveDockLayout(layout);
  });
  stripR.title = 'Show inspector';
  stripR.setAttribute('aria-label', 'Show inspector');
  const stripB = document.createElement('button');
  stripB.className = 'btn btn-sm dock-strip dock-strip-b';
  stripB.textContent = 'Timeline ˄';
  stripB.title = 'Show timeline';
  stripB.setAttribute('aria-label', 'Show timeline');
  stripB.onclick = () => {
    layout.timelineHidden = false;
    relayout();
    saveDockLayout(layout);
  };
  editor.appendChild(stripB);
  cleanups.push(() => stripB.remove());

  function relayout(): void {
    apply(t, layout);
    positionHandles();
    stripL.style.display = layout.outlinerHidden ? '' : 'none';
    stripR.style.display = layout.inspectorHidden ? '' : 'none';
    // Timeline handle sits on the panel's top edge; hide it with the panel.
    tlHandle.style.display = layout.timelineHidden ? 'none' : '';
    stripB.style.display = layout.timelineHidden ? '' : 'none';
    const hL = t.mainEl.querySelector('.dock-handle-left') as HTMLElement | null;
    const hR = t.mainEl.querySelector('.dock-handle-right') as HTMLElement | null;
    if (hL) hL.style.display = layout.outlinerHidden ? 'none' : '';
    if (hR) hR.style.display = layout.inspectorHidden ? 'none' : '';
  }

  function positionHandles(): void {
    const hL = t.mainEl.querySelector('.dock-handle-left') as HTMLElement | null;
    const hR = t.mainEl.querySelector('.dock-handle-right') as HTMLElement | null;
    if (hL && !layout.outlinerHidden) {
      hL.style.left = `${t.outliner.offsetLeft + t.outliner.offsetWidth - 5}px`;
    }
    if (hR && !layout.inspectorHidden) {
      const mainRect = t.mainEl.getBoundingClientRect();
      const inspRect = t.inspector.getBoundingClientRect();
      hR.style.right = `${mainRect.right - inspRect.left - 5}px`;
    }
    if (!layout.timelineHidden) tlHandle.style.bottom = `${t.timeline.offsetHeight - 4}px`;
  }

  // Re-apply after fonts/layout settle + on window resize (clamps).
  relayout();
  const onResize = (): void => {
    layout.outlinerW = Math.min(layout.outlinerW, Math.max(MIN_SIDE, window.innerWidth - 320));
    layout.inspectorW = Math.min(layout.inspectorW, Math.max(MIN_SIDE, window.innerWidth - 320));
    relayout();
  };
  window.addEventListener('resize', onResize);
  cleanups.push(() => window.removeEventListener('resize', onResize));

  return () => cleanups.forEach((fn) => {
    try {
      fn();
    } catch {
      /* noop */
    }
  });
}

/** Shared left/right edge handle with drag-resize + collapse toggle. */
function edgeHandle(
  main: HTMLElement,
  side: 'left' | 'right',
  getW: () => number,
  setW: (w: number) => void,
  toggle: () => void,
  label: string,
): () => void {
  const h = document.createElement('div');
  h.className = `dock-handle dock-handle-${side}`;
  h.title = `Drag to resize ${label.toLowerCase()} · double-click to hide`;
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-label', `Resize ${label.toLowerCase()}`);
  const btn = document.createElement('button');
  btn.className = 'btn btn-xs dock-collapse';
  btn.textContent = side === 'left' ? '⟨' : '⟩';
  btn.title = `Hide ${label.toLowerCase()}`;
  btn.setAttribute('aria-label', `Hide ${label.toLowerCase()}`);
  btn.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  h.appendChild(btn);
  main.appendChild(h);
  h.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = getW();
    const dir = side === 'left' ? 1 : -1;
    const move = (m: PointerEvent): void => setW(clampSide(startW + (m.clientX - startX) * dir));
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  h.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    toggle();
  });
  return () => h.remove();
}

function apply(t: DockTargets, layout: DockLayout): void {
  // On narrow screens the CSS bottom-sheets own the side panels — docking must
  // not fight them with inline geometry (inline styles beat .sheet-open).
  const outSheet = window.innerWidth <= 860;
  const inspSheet = window.innerWidth <= 760;
  const tlSheet = window.innerWidth <= 760;
  if (outSheet) {
    t.outliner.style.display = '';
    t.outliner.style.width = '';
    t.outliner.style.minWidth = '';
  } else {
    t.outliner.style.display = layout.outlinerHidden ? 'none' : '';
    if (!layout.outlinerHidden) {
      t.outliner.style.width = `${layout.outlinerW}px`;
      t.outliner.style.minWidth = `${layout.outlinerW}px`;
    }
  }
  if (inspSheet) {
    t.inspector.style.display = '';
    t.inspector.style.width = '';
    t.inspector.style.minWidth = '';
  } else {
    t.inspector.style.display = layout.inspectorHidden ? 'none' : '';
    if (!layout.inspectorHidden) {
      t.inspector.style.width = `${layout.inspectorW}px`;
      t.inspector.style.minWidth = `${layout.inspectorW}px`;
    }
  }
  if (tlSheet) {
    t.timeline.style.display = layout.timelineHidden ? 'none' : '';
    t.timeline.style.height = '';
  } else {
    t.timeline.style.display = layout.timelineHidden ? 'none' : '';
    if (!layout.timelineHidden) t.timeline.style.height = `${layout.timelineH}px`;
  }
}
