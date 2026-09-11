import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { collectSubtree } from '../state/tree.js';
import type { SceneObjectData } from '../state/models.js';

/**
 * Selection commands (click, box, multi, hierarchy, hide/show, lock, solo).
 * Mixed into `EditorSession.prototype` — see the `EditorSession extends …`
 * declaration at the bottom of session.ts.
 */
export interface SelectionOps {
  selectAll(this: EditorSession): void;
  selectNone(this: EditorSession): void;
  selectInvert(this: EditorSession): void;
  /** Children (or the whole subtree) of the current selection. */
  selectChildren(this: EditorSession, deep?: boolean): void;
  selectParent(this: EditorSession): void;
  selectSiblings(this: EditorSession): void;
  selectSameMaterial(this: EditorSession): void;
  /** Cycle through objects with Tab / Shift+Tab. */
  selectCycle(this: EditorSession, dir?: 1 | -1): void;
  /** Rectangle selection from a pointer drag (client coordinates). */
  boxSelect(this: EditorSession, rect: { x0: number; y0: number; x1: number; y1: number }, additive: boolean): void;
  hideSelection(this: EditorSession): void;
  showAllObjects(this: EditorSession): void;
  lockSelection(this: EditorSession): void;
  unlockAllObjects(this: EditorSession): void;
  /** Show only the current selection; remembers what was hidden. */
  soloSelection(this: EditorSession): void;
  exitSolo(this: EditorSession): void;
  isSolo(this: EditorSession): boolean;
  deleteSelection(this: EditorSession): void;
  selectAt(this: EditorSession, id: string | null, mods?: { shift: boolean; ctrl: boolean; alt: boolean }): void;
}

/** Solo state, per session instance (never persisted). */
const soloState = new WeakMap<EditorSession, Map<string, boolean>>();

/** Ids of an object's direct children. */
function childrenOf(objects: SceneObjectData[], id: string): string[] {
  return objects.filter((o) => o.parentId === id).map((o) => o.id);
}

export const selectionOps: SelectionOps = {
  selectAll(): void {
    const ids = this.doc.objects.filter((o) => !o.locked).map((o) => o.id);
    this.selectIds(ids);
  },

  selectNone(): void {
    this.select(null);
  },

  selectInvert(): void {
    const sel = new Set(this.selection.ids());
    const ids = this.doc.objects.filter((o) => !sel.has(o.id) && !o.locked).map((o) => o.id);
    this.selectIds(ids);
  },

  selectChildren(deep = false): void {
    const ids = this.selection.ids();
    const out = new Set<string>();
    for (const id of ids) {
      if (deep) {
        for (const node of collectSubtree(this.doc.objects, id)) {
          if (node.id !== id) out.add(node.id);
        }
      } else {
        for (const c of childrenOf(this.doc.objects, id)) out.add(c);
      }
    }
    if (out.size) this.selectIds([...out]);
  },

  selectParent(): void {
    const out = new Set<string>();
    for (const id of this.selection.ids()) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (o?.parentId) out.add(o.parentId);
    }
    if (out.size) this.selectIds([...out]);
  },

  selectSiblings(): void {
    const out = new Set<string>();
    for (const id of this.selection.ids()) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o) continue;
      for (const s of childrenOf(this.doc.objects, o.parentId ?? '')) {
        if (s !== id) out.add(s);
      }
    }
    if (out.size) this.selectIds([...out]);
  },

  selectSameMaterial(): void {
    const ids = new Set(this.selection.ids());
    const materialIds = new Set(
      this.doc.objects.filter((o) => ids.has(o.id) && o.materialId).map((o) => o.materialId as string),
    );
    if (!materialIds.size) return;
    const out = this.doc.objects.filter((o) => o.materialId && materialIds.has(o.materialId)).map((o) => o.id);
    this.selectIds(out);
  },

  selectCycle(dir = 1): void {
    const list = this.doc.objects;
    if (!list.length) return;
    const cur = this.selection.get();
    const at = cur ? list.findIndex((o) => o.id === cur) : -1;
    const next = (at + dir + list.length) % list.length;
    this.select(list[next].id);
    this.focusSelected();
  },

  boxSelect(rect, additive): void {
    const hits = this.viewport.objectsInRect(rect);
    if (!additive) {
      this.selectIds(hits);
      return;
    }
    const merged = new Set(this.selection.ids());
    for (const id of hits) {
      if (merged.has(id)) merged.delete(id);
      else merged.add(id);
    }
    this.selectIds([...merged]);
  },

  hideSelection(): void {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Hide');
    for (const id of ids) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o || !o.visible) continue;
      o.visible = false;
      o.version++;
      this.viewport.updateObject(o);
      this.sync.broadcastOp('update', o);
    }
    this.markDirty('edit');
    this.rig.sync();
  },

  showAllObjects(): void {
    this.history.checkpoint(this.doc, 'Show all');
    for (const o of this.doc.objects) {
      if (o.visible) continue;
      o.visible = true;
      o.version++;
      this.viewport.updateObject(o);
      this.sync.broadcastOp('update', o);
    }
    soloState.delete(this);
    this.markDirty('edit');
    this.rig.sync();
  },

  lockSelection(): void {
    const ids = this.selection.ids();
    if (!ids.length) return;
    this.history.checkpoint(this.doc, 'Lock');
    for (const id of ids) {
      const o = this.doc.objects.find((x) => x.id === id);
      if (!o || o.locked) continue;
      o.locked = true;
      o.version++;
      this.sync.broadcastOp('update', o);
    }
    this.markDirty('edit');
    this.rig.sync();
    this.notice('info', `Locked ${ids.length} object${ids.length === 1 ? '' : 's'}`);
  },

  unlockAllObjects(): void {
    this.history.checkpoint(this.doc, 'Unlock all');
    let n = 0;
    for (const o of this.doc.objects) {
      if (!o.locked) continue;
      o.locked = false;
      o.version++;
      n++;
      this.sync.broadcastOp('update', o);
    }
    this.markDirty('edit');
    this.rig.sync();
    if (n) this.notice('info', `Unlocked ${n} object${n === 1 ? '' : 's'}`);
  },

  soloSelection(): void {
    const ids = new Set(this.selection.ids());
    if (!ids.size) {
      this.notice('warn', 'Select something to solo it');
      return;
    }
    const prev = soloState.get(this) ?? null;
    if (prev) {
      // restore first so a second solo works from the full scene
      for (const o of this.doc.objects) {
        const was = prev.get(o.id);
        if (was !== undefined && o.visible !== was) {
          o.visible = was;
          o.version++;
          this.viewport.updateObject(o);
        }
      }
    }
    const snapshot = new Map<string, boolean>();
    for (const o of this.doc.objects) snapshot.set(o.id, o.visible);
    soloState.set(this, snapshot);
    this.history.checkpoint(this.doc, 'Solo');
    // keep ancestors of soloed objects visible, hide everything else
    const keep = new Set<string>();
    const byId = new Map(this.doc.objects.map((o) => [o.id, o]));
    for (const id of ids) {
      let cur: SceneObjectData | undefined = byId.get(id);
      let hops = 0;
      while (cur && hops++ < 64) {
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
    for (const o of this.doc.objects) {
      const want = keep.has(o.id);
      if (o.visible === want) continue;
      o.visible = want;
      o.version++;
      this.viewport.updateObject(o);
      this.sync.broadcastOp('update', o);
    }
    this.markDirty('edit');
    this.notice('info', `Solo: ${ids.size} object${ids.size === 1 ? '' : 's'}`);
  },

  exitSolo(): void {
    const prev = soloState.get(this);
    if (!prev) return;
    this.history.checkpoint(this.doc, 'Exit solo');
    for (const o of this.doc.objects) {
      const was = prev.get(o.id);
      if (was === undefined || o.visible === was) continue;
      o.visible = was;
      o.version++;
      this.viewport.updateObject(o);
      this.sync.broadcastOp('update', o);
    }
    soloState.delete(this);
    this.markDirty('edit');
  },

  isSolo(): boolean {
    return soloState.has(this);
  },

  deleteSelection(): void {
    const ids = this.selection.ids();
    if (!ids.length) return;
    for (const id of ids) this.deleteObject(id);
    this.select(null);
  },

  /**
   * Click/tap selection with Blender-ish modifiers:
   * shift = add/remove, ctrl = add/remove (mac习惯), alt = select the parent.
   */
  selectAt(id, mods): void {
    if (!id) {
      if (!mods?.shift && !mods?.ctrl) this.select(null);
      return;
    }
    if (mods?.alt) {
      const o = this.doc.objects.find((x) => x.id === id);
      const target = o?.parentId ?? id;
      this.select(target);
      return;
    }
    if (mods?.shift || mods?.ctrl) {
      this.toggleSelect(id);
      return;
    }
    this.select(id);
  },
};

/** Centre + size of the current selection (used by focus/frame and mirroring). */
export function selectionBounds(session: EditorSession): THREE.Box3 {
  const box = new THREE.Box3();
  const ids = session.selection.ids();
  for (const id of ids) {
    const obj = session.viewport.objects.get(id);
    if (!obj) continue;
    const b = new THREE.Box3().setFromObject(obj);
    if (!b.isEmpty()) box.union(b);
  }
  return box;
}
