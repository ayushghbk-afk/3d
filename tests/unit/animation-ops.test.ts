// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeStubSession } from '../helpers/stub-session';
import { createProjectDoc, defaultObject } from '../../src/state/models';
import {
  samplePose,
  moveKeyframe,
  pasteKeys,
  collectKeys,
  setKeyValue,
  findTrack,
  scaleTrackFrames,
} from '../../src/editor/animation';
import type { AnimClip } from '../../src/state/models';

function clipWithCube(): { clip: AnimClip; objectId: string; doc: ReturnType<typeof createProjectDoc> } {
  const doc = createProjectDoc('Anim', 'solo', 'guest');
  const o = defaultObject('cube', 'Cube');
  doc.objects.push(o);
  const clip: AnimClip = {
    id: 'clip-1',
    name: 'Clip 1',
    fps: 30,
    length: 60,
    tracks: [
      {
        objectId: o.id,
        property: 'position',
        keyframes: [
          { frame: 0, value: [0, 0, 0], interp: 'linear' },
          { frame: 30, value: [0, 5, 0], interp: 'ease' },
          { frame: 60, value: [0, 0, 0], interp: 'linear' },
        ],
      },
    ],
  };
  doc.clips = [clip];
  doc.activeClipId = clip.id;
  return { clip, objectId: o.id, doc };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', { open: () => ({}) });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('animation keyframe primitives', () => {
  it('samples with easing, step and clamping', () => {
    const { clip, objectId } = clipWithCube();
    const track = clip.tracks[0];
    expect(samplePose(clip, -10).get(objectId)!.position).toEqual([0, 0, 0]);
    expect(samplePose(clip, 999).get(objectId)!.position).toEqual([0, 0, 0]);
    // 'ease' on the first leg means the midpoint of 0→5 is not linear 2.5
    track.keyframes[0].interp = 'linear';
    expect(samplePose(clip, 15).get(objectId)!.position![1]).toBeCloseTo(2.5, 5);
    track.keyframes[0].interp = 'step';
    expect(samplePose(clip, 15).get(objectId)!.position![1]).toBe(0);
    track.keyframes[0].interp = 'easeIn';
    expect(samplePose(clip, 15).get(objectId)!.position![1]).toBeLessThan(2.5);
    track.keyframes[0].interp = 'easeOut';
    expect(samplePose(clip, 15).get(objectId)!.position![1]).toBeGreaterThan(2.5);
  });

  it('moveKeyframe swaps instead of colliding', () => {
    const { clip } = clipWithCube();
    const track = clip.tracks[0];
    expect(moveKeyframe(track, 60, 30)).toBe(true);
    expect(track.keyframes.map((k) => k.frame)).toEqual([0, 30, 60]);
    expect(track.keyframes.find((k) => k.frame === 30)!.value).toEqual([0, 0, 0]); // moved key
    expect(track.keyframes.find((k) => k.frame === 60)!.value).toEqual([0, 5, 0]); // displaced key
    expect(moveKeyframe(track, 12, 12)).toBe(false);
    expect(moveKeyframe(track, 99, 5)).toBe(false);
  });

  it('collectKeys / pasteKeys round-trip with an offset', () => {
    const { clip, objectId } = clipWithCube();
    const keys = collectKeys(clip, [
      { objectId, property: 'position', frame: 0, value: [0, 0, 0], interp: 'linear' },
      { objectId, property: 'position', frame: 30, value: [0, 0, 0], interp: 'linear' },
    ]);
    expect(keys).toHaveLength(2);
    expect(keys[1].value).toEqual([0, 5, 0]); // values come from the clip, not the selector

    const n = pasteKeys(clip, keys, 10);
    expect(n).toBe(2);
    const frames = clip.tracks[0].keyframes.map((k) => k.frame);
    expect(frames).toEqual([0, 10, 30, 40, 60]);
  });

  it('setKeyValue only edits an existing key and scaleTrackFrames retimes', () => {
    const { clip } = clipWithCube();
    const track = clip.tracks[0];
    expect(setKeyValue(track, 30, [1, 2, 3])).toBe(true);
    expect(track.keyframes[1].value).toEqual([1, 2, 3]);
    expect(setKeyValue(track, 31, [9, 9, 9])).toBe(false);
    scaleTrackFrames(track, 2);
    expect(track.keyframes.map((k) => k.frame)).toEqual([0, 60, 120]);
  });
});

describe('animation ops through the session', () => {
  function sessionWithClip() {
    const { clip, objectId, doc } = clipWithCube();
    const built = makeStubSession(doc);
    return { ...built, clip, objectId };
  }

  it('keysAtPlayhead reports every animated property of the selection', () => {
    const { session: s, clip, objectId } = sessionWithClip();
    s.playback.frame = 30;
    expect(s.keysAtPlayhead()).toHaveLength(1);
    s.playback.frame = 31;
    expect(s.keysAtPlayhead()).toHaveLength(0);
    expect(s.keysAtPlayhead(objectId)).toHaveLength(0);
    expect(clip.tracks).toHaveLength(1);
  });

  it('copy / paste keyframes uses the playhead as the paste anchor', () => {
    const { session: s, clip, objectId } = sessionWithClip();
    s.select(objectId);
    expect(s.copyKeyframes()).toBe(3);
    s.playback.frame = 40; // first copied key is frame 0 → offset +40
    expect(s.pasteKeyframes()).toBe(3);
    const frames = clip.tracks[0].keyframes.map((k) => k.frame);
    expect(frames).toEqual([0, 30, 40, 60, 70, 100]);
  });

  it('copyKeyframes accepts dope-sheet selectors', () => {
    const { session: s, objectId, clip } = sessionWithClip();
    expect(s.copyKeyframes([{ objectId, property: 'position', frame: 30 }])).toBe(1);
    s.playback.frame = 0;
    expect(s.pasteKeyframes(0)).toBe(1); // same frame → overwrites, no new key
    expect(clip.tracks[0].keyframes).toHaveLength(3);
  });

  it('deleteKeyframesAtPlayhead prunes the key (and the track when empty)', () => {
    const { session: s, clip } = sessionWithClip();
    s.playback.frame = 30;
    expect(s.deleteKeyframesAtPlayhead()).toBe(1);
    expect(clip.tracks[0].keyframes.map((k) => k.frame)).toEqual([0, 60]);
  });

  it('moveKey / cycleInterpAt / setKeyValueAt drive the dope sheet', () => {
    const { session: s, clip, objectId } = sessionWithClip();
    expect(s.moveKey(objectId, 'position', 60, 50)).toBe(true);
    expect(clip.tracks[0].keyframes.map((k) => k.frame)).toEqual([0, 30, 50]);
    expect(s.cycleInterpAt(objectId, 'position', 30)).not.toBeNull();
    expect(clip.tracks[0].keyframes[1].interp).not.toBe('ease');
    expect(s.cycleInterpAt(objectId, 'position', 999)).toBeNull();
    expect(s.setKeyValueAt(objectId, 'position', 30, [0, 7, 0])).toBe(true);
    expect(clip.tracks[0].keyframes[1].value).toEqual([0, 7, 0]);
    expect(s.setKeyValueAt(objectId, 'position', 31, [0, 7, 0])).toBe(false);
  });

  it('dopeSheet groups tracks per object and keyframeRange spans the keys', () => {
    const { session: s, objectId } = sessionWithClip();
    const sheet = s.dopeSheet();
    expect(sheet).toHaveLength(1);
    expect(sheet[0].name).toBe('Cube');
    expect(sheet[0].objectId).toBe(objectId);
    expect(s.keyframeRange()).toEqual({ first: 0, last: 60 });
  });

  it('bakeClip resamples into a new linear clip and leaves the original alone', () => {
    const { session: s, doc, clip } = sessionWithClip();
    const before = clip.tracks[0].keyframes.length;
    const baked = s.bakeClip(5);
    expect(baked).toBeTruthy();
    expect(baked!.name).toContain('baked');
    expect(doc.clips).toHaveLength(2);
    const track = findTrack(baked!, clip.tracks[0].objectId, 'position')!;
    expect(track.keyframes.length).toBeGreaterThan(5);
    expect(track.keyframes.every((k) => k.interp === 'linear')).toBe(true);
    expect(clip.tracks[0].keyframes).toHaveLength(before); // source untouched
  });

  it('clip CRUD keeps an active clip available', () => {
    const { session: s, doc } = sessionWithClip();
    const dup = s.duplicateClip();
    expect(dup).toBeTruthy();
    expect(doc.clips).toHaveLength(2);
    s.renameClip(dup!.id, 'Take 2');
    expect(doc.clips[1].name).toBe('Take 2');
    s.setClipLength(120);
    expect(doc.clips[1].length).toBe(120);
    s.deleteClip(dup!.id);
    expect(doc.clips).toHaveLength(1);
  });
});
