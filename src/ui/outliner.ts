import type { EditorSession } from '../editor/session.js';
import type { SceneObjectData } from '../state/models.js';
import { escapeHtml } from '../lib/utils.js';

const ICONS: Record<string, string> = {
  cube: '▣', sphere: '●', cylinder: '▤', cone: '▲', plane: '▱', torus: '◎',
  group: '🗂', imported: '📦', light: '💡',
};

export function buildOutliner(s: EditorSession, el: HTMLElement): () => void {
  const collapsed = new Set<string>();

  function depthOf(o: SceneObjectData, byId: Map<string, SceneObjectData>): number {
    let d = 0;
    let p = o.parentId;
    while (p && byId.has(p) && d < 12) {
      d++;
      p = byId.get(p)?.parentId ?? null;
    }
    return d;
  }

  function render(): void {
    const objs = s.doc.objects;
    const byId = new Map(objs.map((o) => [o.id, o]));
    const children = new Map<string | null, SceneObjectData[]>();
    for (const o of objs) {
      const k = o.parentId ?? null;
      if (!children.has(k)) children.set(k, []);
      children.get(k)?.push(o);
    }
    const ordered: SceneObjectData[] = [];
    const walk = (parent: string | null) => {
      for (const o of children.get(parent) ?? []) {
        ordered.push(o);
        if (!collapsed.has(o.id)) walk(o.id);
      }
    };
    walk(null);
    // orphans (bad parentId)
    for (const o of objs) {
      if (o.parentId && !byId.has(o.parentId) && !ordered.includes(o)) ordered.push(o);
    }

    const sel = s.selection.get();
    const locks = s.locks.get();
    const me = s.user().id;
    el.innerHTML = `
      <div class="panel-title">Outliner <span class="muted">(${objs.length})</span></div>
      <div class="out-list">
        ${ordered.length ? '' : '<p class="muted small" style="padding:8px">Empty scene — add a primitive from the toolbar.</p>'}
        ${ordered
          .map((o) => {
            const d = depthOf(o, byId);
            const hasKids = (children.get(o.id) ?? []).length > 0;
            const lock = locks.get(o.id);
            const lockBadge = o.locked ? '🔒' : lock && lock.id !== me ? `🔵` : '';
            return `
            <div class="out-row${o.id === sel ? ' sel' : ''}" data-id="${o.id}" style="--depth:${d}" tabindex="0" role="treeitem" aria-selected="${o.id === sel}">
              <button class="btn btn-icon btn-xs out-caret" data-caret="${o.id}" aria-label="Expand">${hasKids ? (collapsed.has(o.id) ? '▸' : '▾') : ''}</button>
              <span class="out-icon">${ICONS[o.type] ?? '○'}</span>
              <span class="out-name" title="${escapeHtml(o.name)}${lock && lock.id !== me ? ` — ${escapeHtml(lock.name)} is editing` : ''}">${escapeHtml(o.name)}${lockBadge ? ` ${lockBadge}` : ''}</span>
              <button class="btn btn-icon btn-xs" data-eye="${o.id}" aria-label="Toggle visibility">${o.visible ? '👁' : '🚫'}</button>
            </div>`;
          })
          .join('')}
      </div>`;
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
        s.select(id);
      });
      row.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') s.select(id);
      });
      row.addEventListener('dblclick', () => {
        const o = s.doc.objects.find((x) => x.id === id);
        if (!o) return;
        const v = prompt('Rename object', o.name);
        if (v && v.trim()) s.renameObject(id, v.trim());
      });
    });
  }

  const u1 = s.rev.subscribe(render);
  const u2 = s.selection.subscribe(() => render());
  const u3 = s.locks.subscribe(() => render());
  render();
  return () => {
    u1();
    u2();
    u3();
  };
}
