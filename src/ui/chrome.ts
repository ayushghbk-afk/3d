// Fullscreen + auto-hide editor chrome.
// The Fullscreen API hides the *browser* (tabs, address bar). After a short
// idle the studio chrome (topbar, rail, outliner, inspector, timeline) also
// tucks away so the viewport fills the screen. Move the mouse or tap
// "Show tools" to bring it back. If the Fullscreen API is blocked (iframe
// without allowfullscreen), cinema mode still auto-hides the studio chrome.

export const CHROME_IDLE_MS = 1600;

const CHROME_HOVER = '.topbar, .rail, .outliner, .inspector, .timeline, .mobilebar, .floatwin, .modal-overlay, .fs-exit, .dock-handle, .dock-strip';

export interface AutoHideChrome {
  setEnabled: (on: boolean) => void;
  isEnabled: () => boolean;
  isChromeHidden: () => boolean;
  showChrome: () => void;
  hideChrome: () => void;
  toggle: () => Promise<void>;
  handleEscape: () => boolean;
  dispose: () => void;
}

type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FsEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function fullscreenElement(): Element | null {
  const d = document as FsDoc;
  return document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

async function requestFs(target: HTMLElement): Promise<boolean> {
  const el = target as FsEl;
  const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  if (!req) return false;
  try {
    await req();
    return true;
  } catch {
    return false;
  }
}

async function exitFs(): Promise<void> {
  if (!fullscreenElement()) return;
  const d = document as FsDoc;
  const exit = document.exitFullscreen?.bind(document) ?? d.webkitExitFullscreen?.bind(document);
  if (!exit) return;
  try {
    await exit();
  } catch {
    /* already left, or browser blocked */
  }
}

function overChrome(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(CHROME_HOVER);
}

function overViewport(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('#vp, .viewport-canvas, .vp-wrap');
}

export function attachAutoHideChrome(
  editor: HTMLElement,
  opts?: { idleMs?: number; fsTarget?: HTMLElement },
): AutoHideChrome {
  const idleMs = opts?.idleMs ?? CHROME_IDLE_MS;
  const fsTarget = opts?.fsTarget ?? document.documentElement;
  let enabled = false;
  let hidden = false;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTarget: EventTarget | null = null;
  let disposed = false;

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'btn btn-sm fs-exit';
  exitBtn.textContent = 'Show tools';
  exitBtn.title = 'Show editor tools (Esc exits fullscreen)';
  exitBtn.setAttribute('aria-label', 'Show editor tools');
  editor.appendChild(exitBtn);

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const relayout = (): void => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };

  const applyHidden = (next: boolean): void => {
    if (hidden === next) return;
    hidden = next;
    editor.classList.toggle('editor-chrome-hidden', hidden);
    relayout();
  };

  const armIdle = (): void => {
    clearTimer();
    if (!enabled || disposed || dragging) return;
    timer = setTimeout(() => {
      timer = null;
      if (!enabled || disposed || dragging) return;
      if (overChrome(lastTarget)) {
        armIdle();
        return;
      }
      applyHidden(true);
    }, idleMs);
  };

  const showChrome = (): void => {
    applyHidden(false);
    armIdle();
  };

  const hideChrome = (): void => {
    if (!enabled) return;
    clearTimer();
    applyHidden(true);
  };

  const setEnabled = (on: boolean): void => {
    if (disposed) return;
    enabled = on;
    editor.classList.toggle('editor-cinema', enabled);
    editor.toggleAttribute('data-cinema', enabled);
    if (!enabled) {
      clearTimer();
      applyHidden(false);
      void exitFs();
    } else {
      applyHidden(false);
      armIdle();
    }
    const btn = editor.querySelector('#tb-fs') as HTMLButtonElement | null;
    if (btn) {
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.title = enabled
        ? 'Exit fullscreen — Esc, or F11'
        : 'Fullscreen — hide browser chrome; tools auto-hide when idle (F11)';
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    lastTarget = e.target;
    if (!enabled || disposed) return;
    if (dragging) return;
    if (hidden && overViewport(e.target) && e.pointerType === 'mouse' && e.movementX === 0 && e.movementY === 0) {
      return;
    }
    if (hidden) showChrome();
    else armIdle();
  };

  const onPointerDown = (e: PointerEvent): void => {
    lastTarget = e.target;
    if (!enabled || disposed) return;
    if ((e.target as HTMLElement | null)?.closest?.('.fs-exit')) return;
    if (overViewport(e.target)) {
      dragging = true;
      hideChrome();
    }
  };

  const onPointerUp = (): void => {
    if (!dragging) return;
    dragging = false;
    if (enabled && !disposed) armIdle();
  };

  const onFsChange = (): void => {
    if (disposed) return;
    if (!fullscreenElement() && enabled) setEnabled(false);
  };

  editor.addEventListener('pointermove', onPointerMove);
  editor.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  exitBtn.onclick = (e) => {
    e.stopPropagation();
    showChrome();
  };

  const api: AutoHideChrome = {
    setEnabled,
    isEnabled: () => enabled,
    isChromeHidden: () => hidden,
    showChrome,
    hideChrome,
    toggle: async () => {
      if (disposed) return;
      if (enabled) {
        setEnabled(false);
        return;
      }
      setEnabled(true);
      await requestFs(fsTarget);
    },
    handleEscape: () => {
      if (!enabled || disposed) return false;
      if (document.getElementById('modal-root')?.hasChildNodes()) return false;
      if (hidden) {
        showChrome();
        return true;
      }
      setEnabled(false);
      return true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer();
      editor.removeEventListener('pointermove', onPointerMove);
      editor.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      exitBtn.remove();
      editor.classList.remove('editor-cinema', 'editor-chrome-hidden');
      editor.removeAttribute('data-cinema');
      void exitFs();
    },
  };

  return api;
}
