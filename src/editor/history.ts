import { deepClone } from '../lib/utils.js';
import type { ProjectDoc } from '../state/models.js';

// Snapshot-ring undo/redo. Snapshots cover objects/materials/clips/scripts/
// assets. Assets must be part of the snapshot: undoing a GLB import used to
// leave the AssetMeta behind (orphaned rows that then shipped in every GitHub
// export), and undoing a delete could restore an object whose asset metadata
// was gone — the classic "missing asset bytes" warning.

export interface HistoryAuthor {
  id: string;
  name: string;
}

export interface HistoryEntry {
  label: string;
  author: HistoryAuthor | null;
  at: number;
}

interface Snap extends HistoryEntry {
  objects: ProjectDoc['objects'];
  materials: ProjectDoc['materials'];
  clips: ProjectDoc['clips'];
  scripts: ProjectDoc['scripts'];
  assets: ProjectDoc['assets'];
  /** How many snapshots were folded into one redo step (multi-step undo). */
  bundled?: number;
}

export class History {
  private past: Snap[] = [];
  private future: Snap[] = [];
  private lastPush = 0;
  /** Supplies the author for new checkpoints (the local user). */
  private author: (() => HistoryAuthor | null) | null = null;
  /** Fired after every checkpoint — used to clear the "peer edits since" counter. */
  onCheckpoint: (() => void) | null = null;
  cap = 60;

  onChange: (() => void) | null = null;

  /** Who is editing: every checkpoint is attributed to them. */
  setAuthor(fn: (() => HistoryAuthor | null) | null): void {
    this.author = fn;
  }

  private take(doc: ProjectDoc, label: string, at = Date.now()): Snap {
    return {
      label,
      author: this.author?.() ?? null,
      at,
      objects: deepClone(doc.objects),
      materials: deepClone(doc.materials),
      clips: deepClone(doc.clips),
      scripts: deepClone(doc.scripts ?? []),
      assets: deepClone(doc.assets ?? []),
    };
  }

  /** Capture pre-mutation state. Coalesces rapid pushes (drags) into one entry. */
  checkpoint(doc: ProjectDoc, label: string, coalesceMs = 0): void {
    const n = Date.now();
    if (coalesceMs > 0 && n - this.lastPush < coalesceMs && this.past.length) return;
    this.lastPush = n;
    this.past.push(this.take(doc, label, n));
    if (this.past.length > this.cap) this.past.shift();
    this.future.length = 0;
    this.onCheckpoint?.();
    this.onChange?.();
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }
  undoLabel(): string | null {
    return this.past.length ? this.past[this.past.length - 1].label : null;
  }

  /** Newest-first view of the undo stack (for panels and tooltips). */
  entries(limit = 20): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (let i = this.past.length - 1; i >= 0 && out.length < limit; i--) {
      const s = this.past[i];
      out.push({ label: s.label, author: s.author, at: s.at });
    }
    return out;
  }

  /** The change `undo()` would revert, with its author. */
  undoInfo(): HistoryEntry | null {
    return this.entries(1)[0] ?? null;
  }

  /** Human label for menus: "Add Cube · Ayush". */
  describe(entry: HistoryEntry | null): string {
    if (!entry) return '';
    return entry.author?.name ? `${entry.label} · ${entry.author.name}` : entry.label;
  }

  private apply(doc: ProjectDoc, s: Snap): void {
    doc.objects = s.objects;
    doc.materials = s.materials;
    doc.clips = s.clips;
    doc.scripts = s.scripts ?? [];
    doc.assets = s.assets ?? [];
  }

  /**
   * Undo `depth + 1` steps in one go: restores the state captured by the
   * entry `depth` places back and pushes a single redo step, so reverting past
   * someone else's edit (or a batch of your own) is one Ctrl+Z / Ctrl+Shift+Z.
   */
  undoThrough(doc: ProjectDoc, depth = 0): boolean {
    const steps = Math.max(0, Math.floor(depth)) + 1;
    if (this.past.length < steps) return false;
    const before = this.take(doc, 'redo');
    let deepest: Snap | null = null;
    let newest: Snap | null = null;
    for (let i = 0; i < steps; i++) {
      const s = this.past.pop();
      if (!s) break;
      if (!newest) newest = s;
      deepest = s;
    }
    if (!deepest || !newest) return false;
    this.future.push({ ...before, label: newest.label, author: newest.author, bundled: steps });
    this.apply(doc, deepest);
    this.onChange?.();
    return true;
  }

  redoThrough(doc: ProjectDoc, depth = 0): boolean {
    const steps = Math.max(0, Math.floor(depth)) + 1;
    if (this.future.length < steps) return false;
    const before = this.take(doc, 'undo');
    let deepest: Snap | null = null;
    let newest: Snap | null = null;
    for (let i = 0; i < steps; i++) {
      const s = this.future.pop();
      if (!s) break;
      if (!newest) newest = s;
      deepest = s;
    }
    if (!deepest || !newest) return false;
    this.past.push({ ...before, label: newest.label, author: newest.author, bundled: steps });
    this.apply(doc, deepest);
    this.onChange?.();
    return true;
  }

  undo(doc: ProjectDoc): boolean {
    return this.undoThrough(doc, 0);
  }

  redo(doc: ProjectDoc): boolean {
    return this.redoThrough(doc, 0);
  }

  /**
   * How many steps back the newest entry authored by `userId` sits.
   * `0` means it is on top (a plain undo is safe); `null` means there is
   * nothing of theirs to undo.
   */
  depthOfMine(userId: string): number | null {
    for (let i = this.past.length - 1, depth = 0; i >= 0; i--, depth++) {
      if (this.past[i].author?.id === userId) return depth;
    }
    return null;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.onChange?.();
  }
}
