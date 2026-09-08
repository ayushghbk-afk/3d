import { uid } from '../lib/utils.js';
import type { AnimClip, AnimTrack, Keyframe, ProjectDoc, SceneObjectData } from '../state/models.js';

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
      if (a.interp === 'step' || b.frame === a.frame) return a.value;
      const t = (frame - a.frame) / (b.frame - a.frame);
      return [
        a.value[0] + (b.value[0] - a.value[0]) * t,
        a.value[1] + (b.value[1] - a.value[1]) * t,
        a.value[2] + (b.value[2] - a.value[2]) * t,
      ];
    }
  }
  return null;
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
  private acc = 0;

  constructor(
    private getClip: () => AnimClip | null,
    private onSample: (frame: number) => void,
  ) {}

  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  stop(): void {
    this.playing = false;
    this.setFrame(0);
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
    if (f > len) f = 0; // loop
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
