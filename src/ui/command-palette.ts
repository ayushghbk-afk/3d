import type { EditorSession } from '../editor/session.js';
import { allCommands, searchCommands, runCommand, type Command } from './commands.js';

/**
 * Ctrl+K command palette.
 *
 * Fuzzy search over every registered command, keyboard driven, with recent
 * commands remembered per device. The same registry backs the mobile "More"
 * sheet and the editor menus, so there is exactly one list of actions.
 */

const RECENTS_KEY = 'palette.recents';
const MAX_RECENTS = 8;

function recents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    const next = [id, ...recents().filter((x) => x !== id)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private mode — recents are a nicety */
  }
}

let open = false;

export function isPaletteOpen(): boolean {
  return open;
}

export function openCommandPalette(session: EditorSession | null, initialQuery = ''): void {
  if (open) return;
  open = true;

  const overlay = document.createElement('div');
  overlay.className = 'palette-overlay';
  overlay.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="palette-input-row">
        <span class="palette-icon" aria-hidden="true">⌘</span>
        <input id="palette-input" class="palette-input" type="text" placeholder="Search commands…  (↑↓ to move, Enter to run, Esc to close)" autocomplete="off" spellcheck="false" />
        <span class="palette-count muted small" id="palette-count"></span>
      </div>
      <div class="palette-results" id="palette-results" role="listbox"></div>
      <div class="palette-foot muted small">
        <span>↑ ↓ navigate</span><span>↵ run</span><span>esc close</span>
        <span class="spacer"></span>
        <span id="palette-hint"></span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#palette-input') as HTMLInputElement;
  const resultsEl = overlay.querySelector('#palette-results') as HTMLElement;
  const countEl = overlay.querySelector('#palette-count') as HTMLElement;
  const hintEl = overlay.querySelector('#palette-hint') as HTMLElement;
  input.value = initialQuery;

  let matches: { cmd: Command; recent: boolean }[] = [];
  let cursor = 0;

  const render = (): void => {
    const query = input.value.trim();
    const list = query ? searchCommands(query, session, 60) : [];
    const recentIds = recents();
    const fallback: { cmd: Command; recent: boolean }[] = query
      ? list.map((m) => ({ cmd: m.cmd, recent: false }))
      : [
          ...recentIds
            .map((id) => allCommands().find((c) => c.id === id))
            .filter((c): c is Command => !!c)
            .map((cmd) => ({ cmd, recent: true })),
          ...allCommands()
            .filter((c) => (c.when ? c.when(session) : true) && !recentIds.includes(c.id))
            .slice(0, 40)
            .map((cmd) => ({ cmd, recent: false })),
        ];
    matches = fallback;
    if (cursor >= matches.length) cursor = 0;
    countEl.textContent = `${matches.length}`;
    hintEl.textContent = session?.selection.count() ? `${session.selection.count()} selected` : '';

    let lastGroup = '';
    resultsEl.innerHTML = matches
      .map((m, i) => {
        const groupRow = m.cmd.group !== lastGroup ? `<div class="palette-group">${m.cmd.group}</div>` : '';
        lastGroup = m.cmd.group;
        const active = i === cursor ? ' active' : '';
        return `${groupRow}
          <button class="palette-row${active}" data-i="${i}" role="option" aria-selected="${i === cursor}">
            <span class="palette-row-icon">${m.cmd.icon ?? '•'}</span>
            <span class="palette-row-title">${m.cmd.title}${m.recent ? ' <span class="palette-recent">recent</span>' : ''}</span>
            ${m.cmd.keys ? `<span class="palette-row-keys">${m.cmd.keys}</span>` : ''}
          </button>`;
      })
      .join('');
    if (!matches.length) {
      resultsEl.innerHTML = '<div class="palette-empty muted">No commands match — try “create”, “snap”, “export”…</div>';
    }
    resultsEl.querySelectorAll('[data-i]').forEach((el) => {
      (el as HTMLButtonElement).onmouseenter = () => {
        cursor = Number((el as HTMLElement).dataset.i);
        resultsEl.querySelectorAll('.palette-row').forEach((r) => r.classList.remove('active'));
        el.classList.add('active');
      };
      (el as HTMLButtonElement).onclick = () => void run(cursor);
    });
    scrollActiveIntoView();
  };

  const scrollActiveIntoView = (): void => {
    const el = resultsEl.querySelector('.palette-row.active');
    el?.scrollIntoView({ block: 'nearest' });
  };

  const move = (delta: number): void => {
    if (!matches.length) return;
    cursor = (cursor + delta + matches.length) % matches.length;
    render();
  };

  const run = async (index: number): Promise<void> => {
    const hit = matches[index];
    if (!hit) return;
    close();
    pushRecent(hit.cmd.id);
    await runCommand(hit.cmd.id, session);
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(cursor);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      move(e.shiftKey ? -1 : 1);
    }
  };

  input.addEventListener('input', render);
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });

  render();
  setTimeout(() => input.focus(), 10);
}

export function closeCommandPalette(): void {
  document.querySelector('.palette-overlay')?.remove();
  open = false;
}
