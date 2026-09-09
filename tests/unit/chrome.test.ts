// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { attachAutoHideChrome, CHROME_IDLE_MS } from '../../src/ui/chrome.js';

function skeleton(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'editor';
  root.innerHTML = `
    <header class="topbar"><button id="tb-fs" aria-pressed="false">fs</button></header>
    <div class="editor-main">
      <aside class="rail"></aside>
      <section class="vp-wrap" id="vp"><canvas class="viewport-canvas"></canvas></section>
      <aside class="inspector"></aside>
    </div>
    <footer class="timeline"></footer>`;
  document.body.appendChild(root);
  return root;
}

function pointer(type: string, target: EventTarget, extra: MouseEventInit = {}): Event {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 40, clientY: 40, ...extra });
  target.dispatchEvent(ev);
  return ev;
}

describe('auto-hide chrome', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal-root"></div>';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('hides studio chrome after idle once cinema is on', () => {
    const editor = skeleton();
    const chrome = attachAutoHideChrome(editor, { idleMs: 200 });
    chrome.setEnabled(true);
    expect(editor.classList.contains('editor-cinema')).toBe(true);
    expect(chrome.isChromeHidden()).toBe(false);
    vi.advanceTimersByTime(199);
    expect(chrome.isChromeHidden()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(chrome.isChromeHidden()).toBe(true);
    expect(editor.classList.contains('editor-chrome-hidden')).toBe(true);
    chrome.dispose();
  });

  it('shows chrome again on mouse move, and Show tools unhides', () => {
    const editor = skeleton();
    const chrome = attachAutoHideChrome(editor, { idleMs: 50 });
    chrome.setEnabled(true);
    vi.advanceTimersByTime(60);
    expect(chrome.isChromeHidden()).toBe(true);
    pointer('pointermove', editor.querySelector('#vp') as HTMLElement, { movementX: 4, movementY: 0 });
    expect(chrome.isChromeHidden()).toBe(false);
    vi.advanceTimersByTime(60);
    expect(chrome.isChromeHidden()).toBe(true);
    (editor.querySelector('.fs-exit') as HTMLButtonElement).click();
    expect(chrome.isChromeHidden()).toBe(false);
    chrome.dispose();
  });

  it('keeps chrome hidden while orbiting the viewport', () => {
    const editor = skeleton();
    const chrome = attachAutoHideChrome(editor, { idleMs: 50 });
    chrome.setEnabled(true);
    vi.advanceTimersByTime(60);
    expect(chrome.isChromeHidden()).toBe(true);
    const canvas = editor.querySelector('.viewport-canvas') as HTMLElement;
    pointer('pointerdown', canvas);
    pointer('pointermove', canvas, { movementX: 12, movementY: 8 });
    expect(chrome.isChromeHidden()).toBe(true);
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(chrome.isChromeHidden()).toBe(true);
    chrome.dispose();
  });

  it('Escape shows tools first, then exits cinema', () => {
    const editor = skeleton();
    const chrome = attachAutoHideChrome(editor, { idleMs: 50 });
    chrome.setEnabled(true);
    vi.advanceTimersByTime(60);
    expect(chrome.handleEscape()).toBe(true);
    expect(chrome.isChromeHidden()).toBe(false);
    expect(chrome.isEnabled()).toBe(true);
    expect(chrome.handleEscape()).toBe(true);
    expect(chrome.isEnabled()).toBe(false);
    expect(chrome.handleEscape()).toBe(false);
    chrome.dispose();
  });

  it('toggle enables cinema even when Fullscreen API is missing', async () => {
    const editor = skeleton();
    const chrome = attachAutoHideChrome(editor);
    await chrome.toggle();
    expect(chrome.isEnabled()).toBe(true);
    expect((editor.querySelector('#tb-fs') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    await chrome.toggle();
    expect(chrome.isEnabled()).toBe(false);
    chrome.dispose();
    expect(editor.classList.contains('editor-cinema')).toBe(false);
    expect(editor.querySelector('.fs-exit')).toBeNull();
  });

  it('does not steal Escape while a modal is open', () => {
    const editor = skeleton();
    const chrome = attachAutoHideChrome(editor, { idleMs: CHROME_IDLE_MS });
    chrome.setEnabled(true);
    document.getElementById('modal-root')!.innerHTML = '<div class="modal-overlay"></div>';
    expect(chrome.handleEscape()).toBe(false);
    expect(chrome.isEnabled()).toBe(true);
    chrome.dispose();
  });
});
