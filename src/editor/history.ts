import { deepClone } from '../lib/utils.js';
import type { ProjectDoc } from '../state/models.js';

// Snapshot-ring undo/redo. Snapshots cover objects/materials/clips/scripts/
// assets. Assets must be part of the snapshot: undoing a GLB import used to
// leave the AssetMeta behind (orphaned rows that then shipped in every GitHub
// export), and undoing a delete could restore an object whose asset metadata
// was gone — the classic "missing asset bytes" warning.
interface Snap {
  label: string;
  objects: ProjectDoc['objects'];
  materials: ProjectDoc['materials'];
  clips: ProjectDoc['clips'];
  scripts: ProjectDoc['scripts'];
  assets: ProjectDoc['assets'];
}

export class History {
  private past: Snap[] = [];
  private future: Snap[] = [];
  private lastPush = 0;
  cap = 60;

  onChange: (() => void) | null = null;

  private take(doc: ProjectDoc, label: string): Snap {
    return {
      label,
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
    this.past.push(this.take(doc, label));
    if (this.past.length > this.cap) this.past.shift();
    this.future.length = 0;
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

  undo(doc: ProjectDoc): boolean {
    const s = this.past.pop();
    if (!s) return false;
    this.future.push(this.take(doc, s.label));
    doc.objects = s.objects;
    doc.materials = s.materials;
    doc.clips = s.clips;
    doc.scripts = s.scripts ?? [];
    doc.assets = s.assets ?? [];
    this.onChange?.();
    return true;
  }

  redo(doc: ProjectDoc): boolean {
    const s = this.future.pop();
    if (!s) return false;
    this.past.push(this.take(doc, s.label));
    doc.objects = s.objects;
    doc.materials = s.materials;
    doc.clips = s.clips;
    doc.scripts = s.scripts ?? [];
    doc.assets = s.assets ?? [];
    this.onChange?.();
    return true;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
    this.onChange?.();
  }
}
