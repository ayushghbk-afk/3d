import { uid } from '../lib/utils.js';
import type { AnimClip, AnimTrack, Keyframe, KeyInterp, ProjectDoc, SceneObjectData } from '../state/models.js';

export type { KeyInterp };

/** Cycle order used by the timeline's interpolation button. */
export const INTERP_CYCLE: KeyInterp[] = ['linear', 'ease', 'easeIn', 'easeOut', 'step'];

export function nextInterp(i: KeyInterp): KeyInterp {
  const at = INTERP_CYCLE.indexOf(i);
  return INTERP_CYCLE[(at + 1) % INTERP_CYCLE.length];
}

/** Normalised easing curves. `t` is the 0..1 progress between two keys. */
export function ease(t: number, interp: KeyInterp): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (interp) {
    case 'step':
      return 0;
    case 'easeIn':
      return x * x * x;
    case 'easeOut':
      return 1 - Math.pow(1 - x, 3);
    case 'ease':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'linear':
    default:
      return x;
  }
}

export function activeClip(doc: ProjectDoc): AnimClip | null {
  return doc.clips.find((c) => c.id === doc.activeClipId) ?? doc.clips[0] ?? null;
}

export function ensureTrack(doc: ProjectDoc, clip: AnimClip, objectId: string, property: AnimTrack['property']): AnimTrack {
  let t = clip.tracks.find((x) => x.objectId === objectId && x.property === property);
  if (!t) {
    t = { id: uid(), objectId, property, keyframes: [] };
    clip.tracks.push(t);
  }
  return t;
}

export function setKeyframe(doc: ProjectDoc, objectId: string, property: AnimTrack['property'], frame: number, value: [number, number, number]): void {
  const clip = activeClip(doc);
  if (!clip) return;
  const track = ensureTrack(doc, clip, objectId, property);
  const k = track.keyframes.find((x) => x.frame === frame);
  if (k) {
    k.value = value;
  } else {
    track.keyframes.push({ frame, value, interp: 'linear' });
    track.keyframes.sort((a, b) => a.frame - b.frame);
  }
}

export function deleteKeyframeAt(doc: ProjectDoc, objectId: string, property: AnimTrack['property'], frame: number): boolean {
  const clip = activeClip(doc);
  if (!clip) return false;
  const track = clip.tracks.find((x) => x.objectId === objectId && x.property === property);
  if (!track) return false;
  const i = track.keyframes.findIndex((x) => x.frame === frame);
  if (i < 0) return false;
  track.keyframes.splice(i, 1);
  return true;
}

export function keyframesAt(doc: ProjectDoc, objectId: string, frame: number): AnimTrack['property'][] {
  const clip = activeClip(doc);
  if (!clip) return [];
  return clip.tracks
    .filter((t) => t.objectId === objectId && t.keyframes.some((k) => k.frame === frame))
    .map((t) => t.property);
}

function sampleTrack(track: AnimTrack, frame: number): [number, number, number] | null {
  const ks = track.keyframes;
  if (!ks.length) return null;
  if (frame <= ks[0].frame) return ks[0].value;
  if (frame >= ks[ks.length - 1].frame) return ks[ks.length - 1].value;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      if (b.frame === a.frame) return a.value;
      if (a.interp === 'step') return a.value;
      const t = ease((frame - a.frame) / (b.frame - a.frame), a.interp);
      return [
        a.value[0] + (b.value[0] - a.value[0]) * t,
        a.value[1] + (b.value[1] - a.value[1]) * t,
        a.value[2] + (b.value[2] - a.value[2]) * t,
      ];
    }
  }
  return null;
}

// ---------- keyframe editing primitives (timeline / dope sheet / agent API) ----------

export function findTrack(clip: AnimClip | null, objectId: string, property: AnimTrack['property']): AnimTrack | null {
  if (!clip) return null;
  return clip.tracks.find((t) => t.objectId === objectId && t.property === property) ?? null;
}

export function findKey(track: AnimTrack | null, frame: number): Keyframe | null {
  if (!track) return null;
  return track.keyframes.find((k) => k.frame === frame) ?? null;
}

/** Move a key to another frame, swapping rather than colliding. */
export function moveKeyframe(track: AnimTrack, from: number, to: number): boolean {
  if (from === to) return false;
  const key = track.keyframes.find((k) => k.frame === from);
  if (!key) return false;
  const blocked = track.keyframes.find((k) => k.frame === to);
  track.keyframes = track.keyframes.filter((k) => k.frame !== from && k.frame !== to);
  key.frame = to;
  if (blocked) {
    blocked.frame = from;
    track.keyframes.push(blocked);
  }
  track.keyframes.push(key);
  track.keyframes.sort((a, b) => a.frame - b.frame);
  return true;
}

export function setKeyInterp(track: AnimTrack, frame: number, interp: KeyInterp): boolean {
  const k = findKey(track, frame);
  if (!k) return false;
  k.interp = interp;
  return true;
}

export function setKeyValue(track: AnimTrack, frame: number, value: [number, number, number]): boolean {
  const k = findKey(track, frame);
  if (!k) return false;
  k.value = value;
  return true;
}

/** Remove empty tracks so the dope sheet stays tidy. */
export function pruneClip(clip: AnimClip): void {
  clip.tracks = clip.tracks.filter((t) => t.keyframes.length > 0);
}

export interface KeyRef {
  objectId: string;
  property: AnimTrack['property'];
  frame: number;
  value: [number, number, number];
  interp: KeyInterp;
}

/** Snapshot the given keys (used by copy/paste). Defaults: every key of `objectId`. */
export function collectKeys(clip: AnimClip | null, refs: KeyRef[]): KeyRef[] {
  if (!clip) return [];
  const wanted = new Set(refs.map((r) => `${r.objectId}|${r.property}|${r.frame}`));
  const out: KeyRef[] = [];
  for (const t of clip.tracks) {
    for (const k of t.keyframes) {
      if (!wanted.has(`${t.objectId}|${t.property}|${k.frame}`)) continue;
      out.push({ objectId: t.objectId, property: t.property, frame: k.frame, value: [...k.value] as [number, number, number], interp: k.interp });
    }
  }
  return out;
}

/** Paste collected keys at `offset` frames (optionally onto another object). */
export function pasteKeys(clip: AnimClip | null, keys: KeyRef[], offset = 0, targetObjectId?: string): number {
  if (!clip) return 0;
  let n = 0;
  for (const k of keys) {
    const objectId = targetObjectId ?? k.objectId;
    const track = ensureTrack({ clips: [clip], activeClipId: clip.id } as unknown as ProjectDoc, clip, objectId, k.property);
    const frame = Math.max(0, k.frame + offset);
    const existing = track.keyframes.find((x) => x.frame === frame);
    if (existing) {
      existing.value = [...k.value] as [number, number, number];
      existing.interp = k.interp;
    } else {
      track.keyframes.push({ frame, value: [...k.value] as [number, number, number], interp: k.interp });
      track.keyframes.sort((a, b) => a.frame - b.frame);
    }
    n++;
  }
  return n;
}

/** Scale every key of a track around frame 0 (retiming). */
export function scaleTrackFrames(track: AnimTrack, factor: number): void {
  if (factor <= 0) return;
  const frames = new Set<number>();
  for (const k of track.keyframes) {
    k.frame = Math.max(0, Math.round(k.frame * factor));
    frames.add(k.frame);
  }
  if (frames.size !== track.keyframes.length) {
    frame_collisions: for (const k of track.keyframes) {
      while (track.keyframes.filter((x) => x.frame === k.frame).length > 1) {
        k.frame += 1;
        continue frame_collisions;
      }
    }
  }
  track.keyframes.sort((a, b) => a.frame - b.frame);
}

/** Sampled pose for every animated object at `frame`. */
export function samplePose(clip: AnimClip, frame: number): Map<string, Partial<Record<AnimTrack['property'], [number, number, number]>>> {
  const out = new Map<string, Partial<Record<AnimTrack['property'], [number, number, number]>>>();
  for (const track of clip.tracks) {
    const v = sampleTrack(track, frame);
    if (!v) continue;
    let pose = out.get(track.objectId);
    if (!pose) {
      pose = {};
      out.set(track.objectId, pose);
    }
    pose[track.property] = v;
  }
  return out;
}

export function trackValueOf(obj: SceneObjectData, property: AnimTrack['property']): [number, number, number] {
  const v = obj[property];
  return [v.x, v.y, v.z];
}

export class Playback {
  playing = false;
  frame = 0;
  /** Notified whenever play/pause/stop flips the transport. */
  onPlayingChange: ((playing: boolean) => void) | null = null;
  /** When false, playback halts on the last frame instead of wrapping. */
  loop = true;
  private acc = 0;

  constructor(
    private getClip: () => AnimClip | null,
    private onSample: (frame: number) => void,
  ) {}

  play(): void {
    const was = this.playing;
    this.playing = true;
    if (!was) this.onPlayingChange?.(true);
  }
  pause(): void {
    const was = this.playing;
    this.playing = false;
    if (was) this.onPlayingChange?.(false);
  }
  stop(): void {
    const was = this.playing;
    this.playing = false;
    this.setFrame(0);
    if (was) this.onPlayingChange?.(false);
  }

  setFrame(f: number): void {
    const clip = this.getClip();
    const len = clip?.length ?? 90;
    this.frame = Math.max(0, Math.min(len, Math.round(f)));
    this.acc = 0;
    this.onSample(this.frame);
  }

  tick(dt: number): void {
    if (!this.playing) return;
    const clip = this.getClip();
    const fps = clip?.fps ?? 30;
    const len = clip?.length ?? 90;
    this.acc += dt * fps;
    let f = this.frame + Math.floor(this.acc);
    this.acc -= Math.floor(this.acc);
    if (f > len) {
      if (this.loop) {
        f = 0;
      } else {
        this.playing = false;
        f = len;
        this.onPlayingChange?.(false);
      }
    }
    if (f !== this.frame) {
      this.frame = f;
      this.onSample(this.frame);
    }
  }
}

export function describeClip(clip: AnimClip): string {
  const n = clip.tracks.reduce((a, t) => a + t.keyframes.length, 0);
  return `${clip.tracks.length} tracks · ${n} keys`;
}

export function keyframeToJson(k: Keyframe): Keyframe {
  return { frame: k.frame, value: [...k.value] as [number, number, number], interp: k.interp };
}
