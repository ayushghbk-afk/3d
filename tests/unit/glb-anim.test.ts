import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { docClipsToAnimationClips, exportNodeName } from '../../src/engine/gltf';
import type { AnimClip } from '../../src/state/models';

// Locks audit §1.7: the studio AnimClip → glTF animation bridge. Before this,
// `exportGlb` hardcoded `animations: []` and every exported GLB was motionless.

function clip(over: Partial<AnimClip> = {}): AnimClip {
  return {
    id: 'c1', name: 'Spin', fps: 30, length: 90,
    tracks: [], ...over,
  };
}

describe('docClipsToAnimationClips', () => {
  it('converts position keys into a VectorKeyframeTrack with time = frame/fps', () => {
    const node = new THREE.Object3D();
    node.name = 'Cube-0';
    const root = new THREE.Group();
    root.add(node);
    const clips = docClipsToAnimationClips([
      clip({
        tracks: [{
          id: 't1', objectId: 'o1', property: 'position',
          keyframes: [
            { frame: 0, value: [0, 0, 0], interp: 'linear' },
            { frame: 30, value: [1, 2, 3], interp: 'linear' },
          ],
        }],
      }),
    ], new Map([['o1', node]]));

    expect(clips).toHaveLength(1);
    const track = clips[0].tracks[0];
    expect(track.name).toBe('Cube-0.position');
    expect(Array.from(track.times)).toEqual([0, 1]);
    expect(Array.from(track.values)).toEqual([0, 0, 0, 1, 2, 3]);
    expect(clips[0].duration).toBeCloseTo(3);
  });

  it('bakes Euler rotation keys into quaternion tracks', () => {
    const node = new THREE.Object3D();
    node.name = 'Arm-1';
    const clips = docClipsToAnimationClips([
      clip({
        tracks: [{
          id: 't1', objectId: 'o1', property: 'rotation',
          keyframes: [
            { frame: 0, value: [0, 0, 0], interp: 'linear' },
            { frame: 15, value: [0, Math.PI / 2, 0], interp: 'linear' },
          ],
        }],
      }),
    ], new Map([['o1', node]]));
    const track = clips[0].tracks[0] as THREE.QuaternionKeyframeTrack;
    expect(track).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
    expect(track.values).toHaveLength(8); // 2 keys × 4 components
    const q = new THREE.Quaternion().fromArray(track.values, 4);
    const e = new THREE.Euler().setFromQuaternion(q);
    expect(e.y).toBeCloseTo(Math.PI / 2, 3);
  });

  it('holds step keys: value repeats until the following key time', () => {
    const node = new THREE.Object3D();
    node.name = 'Box-2';
    const clips = docClipsToAnimationClips([
      clip({
        tracks: [{
          id: 't1', objectId: 'o1', property: 'scale',
          keyframes: [
            { frame: 0, value: [1, 1, 1], interp: 'step' },
            { frame: 30, value: [2, 2, 2], interp: 'linear' },
          ],
        }],
      }),
    ], new Map([['o1', node]]));
    const track = clips[0].tracks[0];
    expect(Array.from(track.times)).toEqual([0, 1, 1]);
    expect(Array.from(track.values)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2]);
  });

  it('skips tracks whose object is not exported or that have a single key', () => {
    const node = new THREE.Object3D();
    node.name = 'Solo-0';
    const clips = docClipsToAnimationClips([
      clip({
        tracks: [
          { id: 't1', objectId: 'ghost', property: 'position', keyframes: [
            { frame: 0, value: [1, 1, 1], interp: 'linear' }, { frame: 10, value: [2, 2, 2], interp: 'linear' }] },
          { id: 't2', objectId: 'o1', property: 'position', keyframes: [
            { frame: 0, value: [0, 0, 0], interp: 'linear' }] },
        ],
      }),
    ], new Map([['o1', node]]));
    expect(clips).toHaveLength(0);
  });
});

describe('exportNodeName', () => {
  it('strips dots/spaces (PropertyBinding path syntax) and stays unique via index', () => {
    expect(exportNodeName('Cube.001', 0)).toBe('Cube-001-0');
    expect(exportNodeName('My  Chair 2', 4)).toBe('My-Chair-2-4');
    expect(exportNodeName('', 7)).toBe('object-7');
    expect(exportNodeName('💡 Light', 2)).toBe('Light-2');
    expect(exportNodeName('x'.repeat(80), 3)).toHaveLength(42); // 40 + '-3'
  });
});
