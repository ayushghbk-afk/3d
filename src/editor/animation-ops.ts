import type { EditorSession } from './session.js';
import {
  activeClip, collectKeys, deleteKeyframeAt, ensureTrack, findTrack, moveKeyframe, pasteKeys,
  pruneClip, samplePose, setKeyInterp, setKeyValue, trackValueOf, nextInterp,
  type KeyRef,
} from './animation.js';
import type { AnimClip, AnimTrack, KeyInterp } from '../state/models.js';
import { uid } from '../lib/utils.js';

/**
 * Timeline / dope-sheet commands: keyframe copy-paste, deletion, retiming,
 * easing and clip management (everything the animation UI needs beyond the
 * single-object helpers already on the session).
 */
export interface AnimationOps {
  /** Every key of the selection at the playhead (or of a specific object). */
  keysAtPlayhead(this: EditorSession, objectId?: string): KeyRef[];
  deleteKeyframesAtPlayhead(this: EditorSession): number;
  deleteSelectedKeys(this: EditorSession, refs: KeySelector[]): number;
  copyKeyframes(this: EditorSession, refs?: KeySelector[]): number;
  pasteKeyframes(this: EditorSession, offsetFrames?: number): number;
  moveKey(this: EditorSession, objectId: string, property: AnimTrack['property'], from: number, to: number): boolean;
  setKeyValueAt(this: EditorSession, objectId: string, property: AnimTrack['property'], frame: number, value: [number, number, number]): boolean;
  setKeyInterpAt(this: EditorSession, objectId: string, property: AnimTrack['property'], frame: number, interp: KeyInterp): boolean;
  cycleInterpAt(this: EditorSession, objectId: string, property: AnimTrack['property'], frame: number): KeyInterp | null;
  /** Sample the clip every N frames into a new clip with linear keys. */
  bakeClip(this: EditorSession, step?: number): AnimClip | null;
  duplicateClip(this: EditorSession, id?: string): AnimClip | null;
  renameClip(this: EditorSession, id: string, name: string): void;
  deleteClip(this: EditorSession, id: string): void;
  setClipLength(this: EditorSession, length: number): void;
  /** All tracks of the active clip, grouped by object, for the dope sheet. */
  dopeSheet(this: EditorSession): { objectId: string; name: string; tracks: AnimTrack[] }[];
  keyframeRange(this: EditorSession): { first: number; last: number };
}

/** A keyframe reference for copy/paste/delete (no value needed). */
export interface KeySelector {
  objectId: string;
  property: AnimTrack['property'];
  frame: number;
}

let clipboard: KeyRef[] = [];
let clipboardFrame = 0;

export function getKeyClipboard(): KeyRef[] {
  return clipboard;
}

function selectionRefs(session: EditorSession, refs?: KeySelector[]): KeyRef[] {
  const clip = activeClip(session.doc);
  if (!clip) return [];
  if (refs?.length) {
    // resolve selectors to full keys so copy keeps values and easing
    return collectKeys(clip, refs.map((r) => ({
      objectId: r.objectId,
      property: r.property,
      frame: r.frame,
      value: [0, 0, 0] as [number, number, number],
      interp: 'linear' as const,
    })));
  }
  const ids = new Set(session.selection.ids());
  const out: KeyRef[] = [];
  for (const t of clip.tracks) {
    if (ids.size && !ids.has(t.objectId)) continue;
    for (const k of t.keyframes) {
      out.push({ objectId: t.objectId, property: t.property, frame: k.frame, value: [...k.value] as [number, number, number], interp: k.interp });
    }
  }
  return out;
}

export const animationOps: AnimationOps = {
  keysAtPlayhead(objectId): KeyRef[] {
    const clip = activeClip(this.doc);
    if (!clip) return [];
    const frame = this.playback.frame;
    const refs: KeyRef[] = [];
    for (const t of clip.tracks) {
      if (objectId && t.objectId !== objectId) continue;
      const k = t.keyframes.find((x) => x.frame === frame);
      if (k) refs.push({ objectId: t.objectId, property: t.property, frame: k.frame, value: [...k.value] as [number, number, number], interp: k.interp });
    }
    return refs;
  },

  deleteKeyframesAtPlayhead(): number {
    const refs = this.keysAtPlayhead();
    return this.deleteSelectedKeys(refs);
  },

  deleteSelectedKeys(refs): number {
    const clip = activeClip(this.doc);
    if (!clip || !refs.length) return 0;
    this.history.checkpoint(this.doc, 'Delete keyframes', 900);
    let n = 0;
    for (const r of refs) {
      if (deleteKeyframeAt(this.doc, r.objectId, r.property, r.frame)) n++;
    }
    if (n) {
      pruneClip(clip);
      this.markDirty('animation');
    }
    return n;
  },

  copyKeyframes(refs): number {
    const list = selectionRefs(this, refs);
    if (!list.length) {
      this.notice('warn', 'No keyframes to copy');
      return 0;
    }
    clipboard = list;
    clipboardFrame = clipboard.length ? Math.min(...clipboard.map((k) => k.frame)) : 0;
    this.notice('info', `Copied ${clipboard.length} keyframe${clipboard.length === 1 ? '' : 's'}`);
    return clipboard.length;
  },

  pasteKeyframes(offsetFrames): number {
    const clip = activeClip(this.doc);
    if (!clip || !clipboard.length) {
      this.notice('warn', 'Copy keyframes first');
      return 0;
    }
    this.history.checkpoint(this.doc, 'Paste keyframes');
    // default: paste at the playhead, keeping the relative layout
    const offset = offsetFrames ?? this.playback.frame - clipboardFrame;
    const targets = this.selection.ids();
    const target = targets.length === 1 ? targets[0] : undefined;
    const n = pasteKeys(clip, clipboard, offset, target);
    if (n) this.markDirty('animation');
    this.notice('info', `Pasted ${n} keyframe${n === 1 ? '' : 's'}`);
    return n;
  },

  moveKey(objectId, property, from, to): boolean {
    const clip = activeClip(this.doc);
    const track = findTrack(clip, objectId, property);
    if (!track) return false;
    this.history.checkpoint(this.doc, 'Move keyframe', 600);
    const ok = moveKeyframe(track, from, to);
    if (ok) {
      this.markDirty('animation');
      this.playback.setFrame(to);
    }
    return ok;
  },

  setKeyValueAt(objectId, property, frame, value): boolean {
    const clip = activeClip(this.doc);
    if (!clip) return false;
    const track = ensureTrack(this.doc, clip, objectId, property);
    const ok = setKeyValue(track, frame, value);
    if (ok) {
      this.markDirty('animation');
      this.applyPose(this.playback.frame);
    }
    return ok;
  },

  setKeyInterpAt(objectId, property, frame, interp): boolean {
    const track = findTrack(activeClip(this.doc), objectId, property);
    if (!track) return false;
    this.history.checkpoint(this.doc, 'Key interpolation', 600);
    const ok = setKeyInterp(track, frame, interp);
    if (ok) this.markDirty('animation');
    return ok;
  },

  cycleInterpAt(objectId, property, frame): KeyInterp | null {
    const track = findTrack(activeClip(this.doc), objectId, property);
    if (!track) return null;
    const k = track.keyframes.find((x) => x.frame === frame);
    if (!k) return null;
    const next = nextInterp(k.interp);
    this.setKeyInterpAt(objectId, property, frame, next);
    return next;
  },

  bakeClip(step = 1): AnimClip | null {
    const clip = activeClip(this.doc);
    if (!clip || !clip.tracks.length) {
      this.notice('warn', 'Nothing to bake');
      return null;
    }
    this.history.checkpoint(this.doc, 'Bake clip');
    const baked: AnimClip = { id: uid(), name: `${clip.name} (baked)`, fps: clip.fps, length: clip.length, tracks: [] };
    const objects = new Set(clip.tracks.map((t) => t.objectId));
    for (const objectId of objects) {
      const props = new Set(clip.tracks.filter((t) => t.objectId === objectId).map((t) => t.property));
      for (const property of props) {
        const track = ensureTrack(this.doc, baked, objectId, property);
        for (let f = 0; f <= clip.length; f += Math.max(1, Math.round(step))) {
          const pose = samplePose(clip, f);
          const value = pose.get(objectId)?.[property];
          const data = this.doc.objects.find((o) => o.id === objectId);
          const fallback = data ? trackValueOf(data, property) : [0, 0, 0] as [number, number, number];
          track.keyframes.push({ frame: f, value: value ?? fallback, interp: 'linear' });
        }
      }
    }
    this.doc.clips.push(baked);
    this.doc.activeClipId = baked.id;
    this.markDirty('animation');
    this.notice('info', `Baked ${baked.tracks.length} tracks`);
    return baked;
  },

  duplicateClip(id): AnimClip | null {
    const src = this.doc.clips.find((c) => c.id === (id ?? this.doc.activeClipId));
    if (!src) return null;
    this.history.checkpoint(this.doc, 'Duplicate clip');
    const copy: AnimClip = JSON.parse(JSON.stringify(src)) as AnimClip;
    copy.id = uid();
    copy.name = `${src.name} copy`;
    this.doc.clips.push(copy);
    this.doc.activeClipId = copy.id;
    this.markDirty('animation');
    return copy;
  },

  renameClip(id, name): void {
    const clip = this.doc.clips.find((c) => c.id === id);
    if (!clip || !name.trim()) return;
    clip.name = name.trim().slice(0, 60);
    this.markDirty('animation');
  },

  deleteClip(id): void {
    if (this.doc.clips.length <= 1) {
      this.notice('warn', 'A project needs at least one clip');
      return;
    }
    this.history.checkpoint(this.doc, 'Delete clip');
    this.doc.clips = this.doc.clips.filter((c) => c.id !== id);
    if (this.doc.activeClipId === id) this.doc.activeClipId = this.doc.clips[0]?.id ?? null;
    this.markDirty('animation');
  },

  setClipLength(length): void {
    const clip = activeClip(this.doc);
    if (!clip) return;
    clip.length = Math.max(1, Math.min(2000, Math.round(length)));
    this.markDirty('animation');
  },

  dopeSheet(): { objectId: string; name: string; tracks: AnimTrack[] }[] {
    const clip = activeClip(this.doc);
    if (!clip) return [];
    const byObject = new Map<string, AnimTrack[]>();
    for (const t of clip.tracks) {
      const list = byObject.get(t.objectId) ?? [];
      list.push(t);
      byObject.set(t.objectId, list);
    }
    const order = ['position', 'rotation', 'scale'] as const;
    return [...byObject.entries()].map(([objectId, tracks]) => ({
      objectId,
      name: this.doc.objects.find((o) => o.id === objectId)?.name ?? '(deleted)',
      tracks: [...tracks].sort((a, b) => order.indexOf(a.property) - order.indexOf(b.property)),
    }));
  },

  keyframeRange(): { first: number; last: number } {
    const clip = activeClip(this.doc);
    let first = Infinity;
    let last = -Infinity;
    for (const t of clip?.tracks ?? []) {
      for (const k of t.keyframes) {
        first = Math.min(first, k.frame);
        last = Math.max(last, k.frame);
      }
    }
    return first === Infinity ? { first: 0, last: 0 } : { first, last };
  },
};
