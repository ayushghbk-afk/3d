// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest';
import { closeFloatWin, getFloatWin, openFloatWin, toggleFloatWin } from '../../src/ui/floatwin.js';
import { attachDocking, loadDockLayout } from '../../src/ui/docking.js';
import { closeModal, openModal } from '../../src/ui/modals.js';

function pointer(type: string, x: number, y: number): Event {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toast-root"></div>';
  localStorage.clear();
  for (const id of ['w1', 'w2']) closeFloatWin(id);
});

describe('floatwin', () => {
  it('opens, focuses and closes a floating window', () => {
    const win = openFloatWin({ id: 'w1', title: 'Test Win' });
    expect(document.getElementById('float-root')).not.toBeNull();
    expect(win.el.querySelector('.floatwin-title')?.textContent).toBe('Test Win');
    expect(getFloatWin('w1')).toBe(win);
    // Opening again focuses the same window instead of duplicating it.
    expect(openFloatWin({ id: 'w1', title: 'Test Win' })).toBe(win);
    expect(document.querySelectorAll('.floatwin')).toHaveLength(1);
    win.close();
    expect(getFloatWin('w1')).toBeNull();
    expect(document.querySelector('.floatwin')).toBeNull();
  });

  it('toggles via toggleFloatWin', () => {
    expect(toggleFloatWin({ id: 'w2', title: 'T' }, () => undefined)).not.toBeNull();
    expect(toggleFloatWin({ id: 'w2', title: 'T' }, () => undefined)).toBeNull();
    expect(document.querySelector('.floatwin')).toBeNull();
  });

  it('collapses and expands from the title bar button', () => {
    const win = openFloatWin({ id: 'w1', title: 'C' });
    const btn = win.el.querySelector('.floatwin-collapse') as HTMLButtonElement;
    btn.click();
    expect(win.isCollapsed()).toBe(true);
    expect((win.body as HTMLElement).style.display).toBe('none');
    btn.click();
    expect(win.isCollapsed()).toBe(false);
    expect((win.body as HTMLElement).style.display).toBe('');
  });

  it('drags by the title bar and persists geometry', () => {
    const win = openFloatWin({ id: 'w1', title: 'D', width: 400, height: 300 });
    const header = win.el.querySelector('.floatwin-header') as HTMLElement;
    const x0 = Number.parseFloat(win.el.style.left);
    const y0 = Number.parseFloat(win.el.style.top);
    header.dispatchEvent(pointer('pointerdown', x0 + 50, y0 + 10));
    window.dispatchEvent(pointer('pointermove', x0 + 150, y0 + 60));
    window.dispatchEvent(pointer('pointerup', x0 + 150, y0 + 60));
    expect(Number.parseFloat(win.el.style.left)).toBeCloseTo(x0 + 100, 0);
    expect(Number.parseFloat(win.el.style.top)).toBeCloseTo(y0 + 50, 0);
    const saved = JSON.parse(localStorage.getItem('w3d.floatwin.v1') ?? '{}') as Record<string, { x: number }>;
    expect(saved.w1.x).toBeCloseTo(x0 + 100, 0);
    win.close();
    // Reopening restores the persisted position.
    const win2 = openFloatWin({ id: 'w1', title: 'D', width: 400, height: 300 });
    expect(Number.parseFloat(win2.el.style.left)).toBeCloseTo(x0 + 100, 0);
  });

  it('resizes by the corner handle', () => {
    const win = openFloatWin({ id: 'w1', title: 'R', width: 400, height: 300 });
    const grip = win.el.querySelector('.floatwin-resize') as HTMLElement;
    grip.dispatchEvent(pointer('pointerdown', 500, 400));
    window.dispatchEvent(pointer('pointermove', 600, 500));
    window.dispatchEvent(pointer('pointerup', 600, 500));
    expect(Number.parseFloat(win.el.style.width)).toBeCloseTo(500, 0);
    expect(Number.parseFloat(win.el.style.height)).toBeCloseTo(400, 0);
  });
});

describe('docking', () => {
  function skeleton(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="editor">
        <div class="editor-main">
          <aside id="outliner" class="outliner"></aside>
          <section id="vp-wrap"></section>
          <aside id="inspector" class="inspector"></aside>
        </div>
        <footer id="timeline" class="timeline"></footer>
      </div>`;
    document.body.appendChild(root);
    return root;
  }

  it('adds resize handles + collapse buttons and applies saved layout', () => {
    const root = skeleton();
    const detach = attachDocking(root);
    expect(root.querySelector('.dock-handle-left')).not.toBeNull();
    expect(root.querySelector('.dock-handle-right')).not.toBeNull();
    expect(root.querySelector('.dock-handle-top')).not.toBeNull();
    const outliner = root.querySelector('#outliner') as HTMLElement;
    expect(outliner.style.width).toBe('264px');
    expect(outliner.style.minWidth).toBe('264px');
    detach();
    expect(root.querySelector('.dock-handle-left')).toBeNull();
  });

  it('collapses panels and restores them from strips', () => {
    const root = skeleton();
    const detach = attachDocking(root);
    const outliner = root.querySelector('#outliner') as HTMLElement;
    const timeline = root.querySelector('#timeline') as HTMLElement;
    (root.querySelector('.dock-handle-left .dock-collapse') as HTMLButtonElement).click();
    expect(outliner.style.display).toBe('none');
    const stripL = root.querySelector('.dock-strip-l') as HTMLElement;
    expect(stripL.style.display).not.toBe('none');
    stripL.click();
    expect(outliner.style.display).toBe('');
    (root.querySelector('.dock-handle-top .dock-collapse') as HTMLButtonElement).click();
    expect(timeline.style.display).toBe('none');
    (root.querySelector('.dock-strip-b') as HTMLButtonElement).click();
    expect(timeline.style.display).toBe('');
    detach();
  });

  it('resizes panels by dragging edges and persists the layout', async () => {
    const root = skeleton();
    const detach = attachDocking(root);
    const handle = root.querySelector('.dock-handle-right') as HTMLElement;
    handle.dispatchEvent(pointer('pointerdown', 800, 300));
    window.dispatchEvent(pointer('pointermove', 700, 300)); // drag left → wider inspector
    window.dispatchEvent(pointer('pointerup', 700, 300));
    const inspector = root.querySelector('#inspector') as HTMLElement;
    expect(Number.parseFloat(inspector.style.width)).toBeGreaterThan(264);
    await new Promise((r) => setTimeout(r, 400)); // debounced save
    expect(loadDockLayout().inspectorW).toBeGreaterThan(264);
    detach();
  });

  it('is a no-op when the editor skeleton is absent', () => {
    const root = document.createElement('div');
    expect(() => attachDocking(root)()).not.toThrow();
  });
});

describe('modal dialogs', () => {
  it('are draggable by the title bar and resizable by the corner', () => {
    openModal({ title: 'Drag me', body: 'hello' });
    const modal = document.querySelector('.modal') as HTMLElement;
    const title = modal.querySelector('.modal-title') as HTMLElement;
    const grip = modal.querySelector('.modal-resize') as HTMLElement;
    expect(title.classList.contains('modal-drag')).toBe(true);
    expect(grip).not.toBeNull();
    title.dispatchEvent(pointer('pointerdown', 400, 200));
    window.dispatchEvent(pointer('pointermove', 450, 230));
    window.dispatchEvent(pointer('pointerup', 450, 230));
    expect(modal.style.position).toBe('fixed');
    expect(modal.dataset.moved).toBe('1');
    closeModal();
    expect(document.querySelector('.modal')).toBeNull();
  });
});
