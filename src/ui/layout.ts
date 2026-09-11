import type { EditorSession } from '../editor/session.js';
import { buildAssetBrowser } from './asset-browser.js';
import { buildDopeSheet } from './dopesheet.js';
import { buildPresence } from './presence.js';
import { toast } from './toast.js';

/**
 * Panel layout controller.
 *
 * Sizes/collapse state for the main panels lives in `docking.ts` (drag edges,
 * persisted in localStorage). This module owns the *optional* panels — asset
 * library, dope sheet, people — plus the tool rail, and exposes a single
 * `toggle()` used by the command palette, menus and the mobile sheets.
 */

export type PanelName = 'rail' | 'outliner' | 'inspector' | 'timeline' | 'assets' | 'animation' | 'presence';

export interface PanelState {
  rail: boolean;
  assets: boolean;
  animation: boolean;
  presence: boolean;
}

const KEY = 'w3d.panels.v1';

const DEFAULTS: PanelState = { rail: true, assets: false, animation: false, presence: false };

export function loadPanels(): PanelState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PanelState> | null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      rail: raw.rail !== false,
      assets: raw.assets === true,
      animation: raw.animation === true,
      presence: raw.presence === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePanels(state: PanelState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
}

export interface LayoutController {
  toggle(name: PanelName): void;
  show(name: PanelName, on?: boolean): void;
  isOpen(name: PanelName): boolean;
  reset(): void;
  destroy(): void;
  state: PanelState;
}

export function attachLayout(
  root: HTMLElement,
  s: EditorSession,
  togglePlay: () => void,
): LayoutController {
  const state = loadPanels();
  const editor = root.querySelector('.editor') as HTMLElement | null;
  const rail = root.querySelector('#rail') as HTMLElement | null;
  const assetsEl = root.querySelector('#assets') as HTMLElement | null;
  const dopeEl = root.querySelector('#dope') as HTMLElement | null;
  const presenceEl = root.querySelector('#presence') as HTMLElement | null;

  let disposeAssets: (() => void) | null = null;
  let disposeDope: (() => void) | null = null;
  let disposePresence: (() => void) | null = null;

  function apply(): void {
    editor?.classList.toggle('no-rail', !state.rail);
    if (rail) rail.style.display = state.rail ? '' : 'none';

    if (assetsEl) {
      assetsEl.style.display = state.assets ? '' : 'none';
      if (state.assets && !disposeAssets) disposeAssets = buildAssetBrowser(s, assetsEl, { onClose: () => show('assets', false) });
      if (!state.assets && disposeAssets) {
        disposeAssets();
        disposeAssets = null;
      }
    }
    if (dopeEl) {
      dopeEl.style.display = state.animation ? '' : 'none';
      if (state.animation && !disposeDope) disposeDope = buildDopeSheet(s, dopeEl, togglePlay);
      if (!state.animation && disposeDope) {
        disposeDope();
        disposeDope = null;
      }
    }
    if (presenceEl) {
      presenceEl.style.display = state.presence ? '' : 'none';
      if (state.presence && !disposePresence) disposePresence = buildPresence(s, presenceEl, { onClose: () => show('presence', false) });
      if (!state.presence && disposePresence) {
        disposePresence();
        disposePresence = null;
      }
    }
    savePanels(state);
  }

  function show(name: PanelName, on = true): void {
    if (name === 'assets') state.assets = on;
    else if (name === 'animation') state.animation = on;
    else if (name === 'presence') state.presence = on;
    else if (name === 'rail') state.rail = on;
    apply();
  }

  function toggle(name: PanelName): void {
    if (name === 'outliner' || name === 'inspector' || name === 'timeline') {
      // owned by docking.ts — click its collapse button so state stays in sync
      const sel = name === 'timeline' ? '.dock-handle-top .dock-collapse' : `.dock-handle-${name === 'outliner' ? 'left' : 'right'} .dock-collapse`;
      const btn = root.querySelector(sel) as HTMLButtonElement | null;
      if (btn) btn.click();
      return;
    }
    const current = name === 'assets' ? state.assets : name === 'animation' ? state.animation : name === 'presence' ? state.presence : state.rail;
    show(name, !current);
  }

  function isOpen(name: PanelName): boolean {
    if (name === 'assets') return state.assets;
    if (name === 'animation') return state.animation;
    if (name === 'presence') return state.presence;
    if (name === 'rail') return state.rail;
    return true;
  }

  function reset(): void {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem('w3d.layout.v1');
    } catch {
      /* ignore */
    }
    Object.assign(state, DEFAULTS);
    apply();
    toast('Layout reset — reload to restore default panel widths', 'info');
  }

  apply();

  return {
    toggle,
    show,
    isOpen,
    reset,
    destroy(): void {
      disposeAssets?.();
      disposeDope?.();
      disposePresence?.();
    },
    state,
  };
}
