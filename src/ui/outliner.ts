import type { EditorSession } from '../editor/session.js';
import type { SceneObjectData } from '../state/models.js';
import { escapeHtml } from '../lib/utils.js';
import { toast } from './toast.js';

const ICONS: Record<string, string> = {
  cube: '▣', sphere: '●', cylinder: '▤', cone: '▲', plane: '▱', torus: '◎',
  group: '🗂', imported: '📦', light: '💡',
};

type ViewMode = 'hierarchy' | 'collections';

/**
 * Outliner v2: search, inline rename, multi-select (shift/ctrl), hide/lock,
 * solo, drag-to-reparent, collections and keyboard navigation.
 */
export function buildOutliner(s: EditorSession, el: HTMLElement): () => void {
  const collapsed = new Set<string>();
  let query = '';
  let mode: ViewMode = 'hierarchy';
  let lastClicked: string | null = null;

  function depthOf(o: SceneObjectData, byId: Map<string, SceneObjectData>): number {
    let d = 0;
    let p = o.parentId;
    while (p && byId.has(p) && d < 12) {
      d++;
      p = byId.get(p)?.parentId ?? null;
    }
    return d;
  }

  function orderedObjects(): { list: SceneObjectData[]; children: Map<string | null, SceneObjectData[]> } {
    const objs = s.doc.objects;
    const byId = new Map(objs.map((o) => [o.id, o]));
    const children = new Map<string | null, SceneObjectData[]>();
    for (const o of objs) {
      const k = o.parentId ?? null;
      if (!children.has(k)) children.set(k, []);
      children.get(k)?.push(o);
    }
    const list: SceneObjectData[] = [];
    const walk = (parent: string | null): void => {
      for (const o of children.get(parent) ?? []) {
        list.push(o);
        if (!collapsed.has(o.id)) walk(o.id);
      }
    };
    walk(null);
    for (const o of objs) {
      if (o.parentId && !byId.has(o.parentId) && !list.includes(o)) list.push(o);
    }
    return { list, children };
  }

  function matches(o: SceneObjectData): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    return o.name.toLowerCase().includes(q) || o.type.toLowerCase().includes(q);
  }

  /** Show a row when it or any descendant matches the search. */
  function visibleRows(): SceneObjectData[] {
    const { list, children } = orderedObjects();
    if (!query) return list;
    const keep = new Set<string>();
    const markWithAncestors = (o: SceneObjectData): void => {
      keep.add(o.id);
      let p = o.parentId;
      let hops = 0;
      while (p && hops++ < 32) {
        keep.add(p);
        p = s.doc.objects.find((x) => x.id === p)?.parentId ?? null;
      }
    };
    for (const o of s.doc.objects) {
      if (matches(o)) markWithAncestors(o);
      // keep children of a matching group visible for context
      for (const c of children.get(o.id) ?? []) if (matches(c)) keep.add(c.id);
    }
    return list.filter((o) => keep.has(o.id));
  }

  function render(): void {
    if (el.contains(document.activeElement) && (document.activeElement as HTMLElement)?.tagName === 'INPUT' && (document.activeElement as HTMLElement).id === 'out-search') {
      // keep typing focus, but still refresh the list below
    }
    const sel = new Set(s.selection.ids());
    const locks = s.locks.get();
    const me = s.user().id;
    const rows = visibleRows();
    const { children } = orderedObjects();
    const byId = new Map(s.doc.objects.map((o) => [o.id, o]));

    el.innerHTML = `
      <div class="panel-title out-head">
        <span>Outliner <span class="muted">(${s.doc.objects.length})</span></span>
        <span class="spacer"></span>
        <button class="btn btn-xs" data-out="mode" title="Switch between hierarchy and collections">${mode === 'hierarchy' ? '🗂' : '🏷'}</button>
        <button class="btn btn-xs" data-out="group" title="Group selection (Ctrl+G)">＋🗂</button>
        <button class="btn btn-xs${s.isSolo() ? ' active' : ''}" data-out="solo" title="Solo selection (isolate)">◉</button>
      </div>
      <div class="out-search-row">
        <input id="out-search" class="input input-sm" type="search" placeholder="Search objects…" value="${escapeHtml(query)}" />
        ${query ? '<button class="btn btn-xs" data-out="clear">✕</button>' : ''}
      </div>
      ${
        mode === 'collections'
          ? `<div class="out-collections">
              ${s.doc.collections.length
                ? s.doc.collections
                    .map((c) => {
                      const members = s.doc.objects.filter((o) => o.collectionIds?.includes(c.id));
                      return `<div class="out-collection" data-collection="${c.id}">
                        <span class="peer" style="--c:${c.color}">●</span>
                        <strong>${escapeHtml(c.name)}</strong>
                        <span class="muted small">${members.length}</span>
                        <span class="spacer"></span>
                        <button class="btn btn-xs" data-col-assign="${c.id}" title="Add selection to this collection">＋</button>
                        <button class="btn btn-xs" data-col-del="${c.id}" title="Delete collection">🗑</button>
                      </div>`;
                    })
                    .join('')
                : '<p class="muted small" style="padding:8px">No collections yet.</p>'}
              <button class="btn btn-sm btn-block" data-out="newcol">＋ New collection</button>
            </div>`
          : ''
      }
      <div class="out-list" role="tree" aria-label="Scene objects">
        ${rows.length ? '' : '<p class="muted small" style="padding:8px">Nothing matches — add a primitive or clear the search.</p>'}
        ${rows
          .map((o) => {
            const d = depthOf(o, byId);
            const hasKids = (children.get(o.id) ?? []).length > 0;
            const lock = locks.get(o.id);
            const badge = o.locked ? '🔒' : lock && lock.id !== me ? '🔵' : '';
            const inCollections = (o.collectionIds ?? []).length;
            return `
            <div class="out-row${sel.has(o.id) ? ' sel' : ''}${o.locked ? ' locked' : ''}" data-id="${o.id}" style="--depth:${d}" tabindex="0" role="treeitem" aria-selected="${sel.has(o.id)}" draggable="true">
              <button class="btn btn-icon btn-xs out-caret" data-caret="${o.id}" aria-label="Expand">${hasKids ? (collapsed.has(o.id) ? '▸' : '▾') : ''}</button>
              <span class="out-icon">${ICONS[o.type] ?? '○'}</span>
              <span class="out-name" data-rename="${o.id}" title="${escapeHtml(o.name)}">${escapeHtml(o.name)}${badge ? ` ${badge}` : ''}${inCollections ? ' <span class="out-dot">🏷</span>' : ''}</span>
              <span class="spacer"></span>
              ${o.visible ? '' : '<span class="out-hidden">hidden</span>'}
              <button class="btn btn-icon btn-xs" data-eye="${o.id}" aria-label="Toggle visibility" title="Hide / show (H)">${o.visible ? '👁' : '🚫'}</button>
              <button class="btn btn-icon btn-xs" data-lock="${o.id}" aria-label="Lock" title="Lock / unlock">${o.locked ? '🔒' : '🔓'}</button>
            </div>`;
          })
          .join('')}
      </div>`;

    // search box
    const search = el.querySelector('#out-search') as HTMLInputElement | null;
    if (search) {
      search.oninput = () => {
        query = search.value;
        const caret = query.length;
        render();
        const next = el.querySelector('#out-search') as HTMLInputElement | null;
        next?.focus();
        next?.setSelectionRange(caret, caret);
      };
      search.onkeydown = (e) => {
        if ((e as KeyboardEvent).key === 'Escape') {
          query = '';
          render();
        }
      };
    }

    el.querySelectorAll('.out-row').forEach((row) => {
      const id = (row as HTMLElement).dataset.id as string;
      row.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-caret]')) {
          if (collapsed.has(id)) collapsed.delete(id);
          else collapsed.add(id);
          render();
          return;
        }
        if (t.closest('[data-eye]')) {
          s.toggleVisible(id);
          return;
        }
        if (t.closest('[data-lock]')) {
          s.toggleLock(id);
          return;
        }
        const ev = e as MouseEvent;
        if (ev.shiftKey && lastClicked) {
          // range select within the visible list
          const ids = rows.map((o) => o.id);
          const a = ids.indexOf(lastClicked);
          const b = ids.indexOf(id);
          if (a >= 0 && b >= 0) {
            const slice = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
            s.selectIds([...new Set([...s.selection.ids(), ...slice])], id);
            return;
          }
        }
        if (ev.ctrlKey || ev.metaKey) {
          s.toggleSelect(id);
          lastClicked = id;
          return;
        }
        s.select(id);
        lastClicked = id;
      });
      row.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        startRename(id);
      });
      row.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter') s.select(id);
        else if (k === 'F2') startRename(id);
        else if (k === 'ArrowDown' || k === 'ArrowUp') {
          e.preventDefault();
          const ids = rows.map((o) => o.id);
          const at = ids.indexOf(id);
          const nextId = ids[Math.max(0, Math.min(ids.length - 1, at + (k === 'ArrowDown' ? 1 : -1)))];
          if (nextId) {
            s.select(nextId);
            (el.querySelector(`[data-id="${nextId}"]`) as HTMLElement | null)?.focus();
          }
        }
      });
      // drag & drop reparenting
      row.addEventListener('dragstart', (e) => {
        (e as DragEvent).dataTransfer?.setData('text/plain', id);
        (e as DragEvent).dataTransfer!.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        const dragId = (e as DragEvent).dataTransfer?.getData('text/plain');
        if (!dragId || dragId === id) return;
        s.setParent(dragId, id);
        if (collapsed.has(id)) collapsed.delete(id);
      });
    });

    const acts: Record<string, () => void> = {
      mode: () => {
        mode = mode === 'hierarchy' ? 'collections' : 'hierarchy';
        render();
      },
      group: () => {
        if (!s.selection.count()) {
          const g = s.addGroup();
          s.renameObject(g.id, 'Group');
        } else {
          s.groupSelection();
        }
      },
      solo: () => (s.isSolo() ? s.exitSolo() : s.soloSelection()),
      clear: () => {
        query = '';
        render();
      },
      newcol: () => {
        const name = window.prompt('Collection name', `Collection ${s.doc.collections.length + 1}`);
        if (name) s.createCollection(name);
      },
    };
    el.querySelectorAll('[data-out]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.out as string]?.();
    });
    el.querySelectorAll('[data-col-assign]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        const id = (b as HTMLElement).dataset.colAssign as string;
        if (!s.selection.count()) {
          toast('Select objects first', 'warn');
          return;
        }
        s.assignToCollection(id);
        toast('Added to collection', 'success');
      };
    });
    el.querySelectorAll('[data-col-del]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => s.deleteCollection((b as HTMLElement).dataset.colDel as string);
    });
    el.querySelectorAll('[data-collection]').forEach((row) => {
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drop-target');
        const dragId = (e as DragEvent).dataTransfer?.getData('text/plain');
        const colId = (row as HTMLElement).dataset.collection as string;
        if (!dragId) return;
        s.assignToCollection(colId, [dragId]);
      });
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const colId = (row as HTMLElement).dataset.collection as string;
        const members = s.doc.objects.filter((o) => o.collectionIds?.includes(colId)).map((o) => o.id);
        if (members.length) s.selectIds(members);
      });
    });
  }

  /** Inline rename (no prompt() — keeps the row in place and feels native). */
  function startRename(id: string): void {
    const o = s.doc.objects.find((x) => x.id === id);
    if (!o) return;
    const span = el.querySelector(`[data-rename="${id}"]`) as HTMLElement | null;
    if (!span) return;
    const input = document.createElement('input');
    input.className = 'input input-sm out-rename';
    input.value = o.name;
    span.replaceWith(input);
    input.focus();
    input.select();
    const commit = (save: boolean): void => {
      const value = input.value.trim();
      if (save && value && value !== o.name) s.renameObject(id, value);
      else render();
    };
    input.onkeydown = (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter') commit(true);
      else if (k === 'Escape') commit(false);
      e.stopPropagation();
    };
    input.onblur = () => commit(true);
  }

  const u1 = s.rev.subscribe(render);
  const u2 = s.selection.subscribeIds(() => render());
  const u3 = s.locks.subscribe(() => render());
  render();
  return () => {
    u1();
    u2();
    u3();
  };
}
