// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { IDBFactory } from 'fake-indexeddb';
import { makeStubSession } from '../helpers/stub-session';
import { defaultObject, type SceneObjectData } from '../../src/state/models';
import { mirrorMatrix } from '../../src/engine/transform';

// transform ops persist gizmo settings to IndexedDB
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function cube(session: ReturnType<typeof makeStubSession>['session'], name: string, pos: [number, number, number]): SceneObjectData {
  const o = defaultObject('cube', name);
  o.position = { x: pos[0], y: pos[1], z: pos[2] };
  session.doc.objects.push(o);
  session.viewport.addObject(o);
  return o;
}

describe('transform ops (multi-select, apply, mirror, reset)', () => {
  it('nudgeSelection moves every selected object in world space', () => {
    const { session: s, doc } = makeStubSession();
    const a = cube(s, 'A', [1, 2, 3]);
    const b = cube(s, 'B', [0, 0, 0]);
    s.selectIds([a.id, b.id]);

    s.nudgeSelection({ x: 0.5, y: 0, z: -1 });
    expect(a.position).toEqual({ x: 1.5, y: 2, z: 2 });
    expect(b.position).toEqual({ x: 0.5, y: 0, z: -1 });
    expect(doc.objects).toHaveLength(2);
  });

  it('applyTransforms bakes the local matrix into geometry and keeps child world placement', () => {
    const { session: s } = makeStubSession();
    const parent = cube(s, 'Parent', [2, 0, 0]);
    parent.scale = { x: 2, y: 1, z: 1 };
    const child = cube(s, 'Child', [1, 0, 0]);
    child.parentId = parent.id;
    s.viewport.addObject(child);
    s.viewport.addObject(parent);

    const before = new THREE.Vector3();
    s.viewport.objects.get(child.id)!.updateWorldMatrix(true, false);
    s.viewport.objects.get(child.id)!.getWorldPosition(before);

    s.select(parent.id);
    s.applyTransforms('all');

    // the object's own transform is emptied …
    expect(parent.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(parent.scale).toEqual({ x: 1, y: 1, z: 1 });
    // … and the pose is preserved in the bake
    expect(parent.baked).toHaveLength(16);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    new THREE.Matrix4().fromArray(parent.baked!).decompose(p, q, sc);
    expect(p.toArray().map((n) => Number(n.toFixed(4)))).toEqual([2, 0, 0]);
    expect(sc.toArray().map((n) => Number(n.toFixed(4)))).toEqual([2, 1, 1]);

    // children absorb the parent matrix so their world pose is unchanged
    expect(child.position.x).toBeCloseTo(4, 5);
    s.viewport.addObject(parent);
    s.viewport.addObject(child);
    const after = new THREE.Vector3();
    s.viewport.objects.get(child.id)!.updateWorldMatrix(true, false);
    s.viewport.objects.get(child.id)!.getWorldPosition(after);
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
  });

  it('resetTransform clears position, rotation or scale', () => {
    const { session: s } = makeStubSession();
    const o = cube(s, 'O', [3, 3, 3]);
    o.rotation = { x: 1, y: 0.5, z: -0.25 };
    o.scale = { x: 2, y: 2, z: 2 };
    s.select(o.id);

    s.resetTransform('scale');
    expect(o.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(o.position).toEqual({ x: 3, y: 3, z: 3 });
    s.resetTransform('rotation');
    expect(o.rotation).toEqual({ x: 0, y: 0, z: 0 });
    s.resetTransform('all');
    expect(o.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('mirrorSelection duplicates across the shared bounding-box centre and flips handedness', () => {
    const { session: s, doc } = makeStubSession();
    const a = cube(s, 'A', [0, 0, 0]);
    const b = cube(s, 'B', [2, 0, 0]);
    s.selectIds([a.id, b.id]);

    s.mirrorSelection('x');

    expect(doc.objects).toHaveLength(4);
    const xs = doc.objects.map((o) => Number(o.position.x.toFixed(4))).sort((x, y) => x - y);
    expect(xs).toEqual([0, 0, 2, 2]); // mirrored about the union centre x = 1
    // the duplicates carry a negative determinant (handedness flip) — the
    // reason the editor nudges you to Apply transforms afterwards
    const duplicated = doc.objects.filter((o) => !o.id.startsWith(a.id) && o.id !== b.id);
    const flipped = duplicated.filter((o) => new THREE.Matrix4()
      .compose(
        new THREE.Vector3(o.position.x, o.position.y, o.position.z),
        new THREE.Quaternion(),
        new THREE.Vector3(o.scale.x, o.scale.y, o.scale.z),
      ).determinant() < 0);
    expect(flipped.length + duplicated.filter((o) => o.scale.x < 0 || o.scale.y < 0 || o.scale.z < 0).length)
      .toBeGreaterThan(0);
  });

  it('mirrorMatrix flips about the requested plane', () => {
    const m = mirrorMatrix('y', new THREE.Vector3(0, 5, 0));
    const v = new THREE.Vector3(1, 7, 2).applyMatrix4(m);
    expect(v.toArray().map((n) => Number(n.toFixed(4)))).toEqual([1, 3, 2]);
  });

  it('dropToGround lifts the lowest point of each root onto y = 0', () => {
    const { session: s } = makeStubSession();
    const o = cube(s, 'O', [0, 3, 0]);
    s.select(o.id);
    s.dropToGround();
    expect(o.position.y).toBeCloseTo(0.5, 4); // 0.5 = half of a unit cube
  });

  it('alignSelection lines objects up on the chosen edge', () => {
    const { session: s } = makeStubSession();
    const a = cube(s, 'A', [0, 0, 0]);
    const b = cube(s, 'B', [2, 0, 0]);
    const c = cube(s, 'C', [5, 0, 0]);
    s.selectIds([a.id, b.id, c.id]);
    s.alignSelection('x', 'min');
    const xs = [a, b, c].map((o) => Number(o.position.x.toFixed(4)));
    expect(new Set(xs).size).toBe(1); // all three now share the same min-x edge
    expect(xs[0]).toBeCloseTo(0, 4);
  });

  it('snapSelectionToGrid quantises the gizmo frame to the grid step', () => {
    const { session: s } = makeStubSession();
    const o = cube(s, 'O', [0, 0, 0]);
    s.select(o.id);
    s.setSnapSettings({ grid: 0.5 });
    s.rig.frameOrigin = () => new THREE.Vector3(0.3, 0, 0.2);
    s.snapSelectionToGrid();
    // delta = snapped frame (0.5, 0, 0) − current frame (0.3, 0, 0.2)
    expect(o.position.x).toBeCloseTo(0.2, 5);
    expect(o.position.z).toBeCloseTo(-0.2, 5);
  });

  it('copyTransform / pasteTransform copy the pose onto the whole selection', () => {
    const { session: s } = makeStubSession();
    const src = cube(s, 'Src', [1, 2, 3]);
    const dstA = cube(s, 'A', [0, 0, 0]);
    const dstB = cube(s, 'B', [9, 9, 9]);
    s.select(src.id);
    s.copyTransform();
    expect(s.hasTransformClipboard()).toBe(true);
    s.selectIds([dstA.id, dstB.id]);
    s.pasteTransform();
    expect(dstA.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(dstB.position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('frameSelection forwards the selection to the viewport', () => {
    const { session: s, viewport } = makeStubSession();
    const o = cube(s, 'O', [0, 0, 0]);
    s.select(o.id);
    s.frameSelection();
    expect(viewport.focusIds).toHaveBeenCalledWith([o.id]);
    s.select(null);
    s.frameSelection();
    expect(viewport.focusIds).toHaveBeenLastCalledWith(null);
  });
});
