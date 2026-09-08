import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { attachToParent } from '../../src/engine/viewport.js';

// Regression: reparenting must NEVER touch local transforms. A previous
// implementation derived placement from matrixWorld, which is still identity
// for freshly loaded objects — so every object snapped to the origin (all
// piled at the spawn point) whenever a project was reopened.

function placed(id: string, parentId: string | null, pos: [number, number, number]) {
  const obj = new THREE.Group();
  obj.position.set(...pos);
  obj.rotation.set(0.1, 0.2, 0.3);
  obj.scale.set(2, 3, 4);
  return { data: { id, parentId }, obj };
}

function snapshot(o: THREE.Object3D) {
  return {
    p: o.position.toArray(),
    r: [o.rotation.x, o.rotation.y, o.rotation.z],
    s: o.scale.toArray(),
  };
}

describe('attachToParent', () => {
  it('keeps a fresh object transform intact when adding to the scene', () => {
    const scene = new THREE.Scene();
    const objects = new Map<string, THREE.Object3D>();
    const { data, obj } = placed('a', null, [5, 6, 7]);
    objects.set('a', obj);
    attachToParent(objects, scene, data);
    expect(obj.parent).toBe(scene);
    expect(snapshot(obj)).toEqual({ p: [5, 6, 7], r: [0.1, 0.2, 0.3], s: [2, 3, 4] });
  });

  it('attaches a child under its parent without touching locals', () => {
    const scene = new THREE.Scene();
    const objects = new Map<string, THREE.Object3D>();
    const parent = placed('p', null, [10, 0, 0]);
    const child = placed('c', 'p', [1, 2, 3]);
    objects.set('p', parent.obj);
    objects.set('c', child.obj);
    attachToParent(objects, scene, parent.data);
    attachToParent(objects, scene, child.data);
    expect(child.obj.parent).toBe(parent.obj);
    expect(snapshot(child.obj)).toEqual({ p: [1, 2, 3], r: [0.1, 0.2, 0.3], s: [2, 3, 4] });
  });

  it('repairs child-before-parent load order on a second pass', () => {
    const scene = new THREE.Scene();
    const objects = new Map<string, THREE.Object3D>();
    const child = placed('c', 'p', [1, 2, 3]);
    objects.set('c', child.obj);
    attachToParent(objects, scene, child.data); // parent missing → parked at root
    expect(child.obj.parent).toBe(scene);
    const parent = placed('p', null, [10, 0, 0]);
    objects.set('p', parent.obj);
    attachToParent(objects, scene, parent.data);
    attachToParent(objects, scene, child.data); // fixParenting second pass
    expect(child.obj.parent).toBe(parent.obj);
    expect(snapshot(child.obj).p).toEqual([1, 2, 3]);
  });

  it('is idempotent and parks orphans at the root', () => {
    const scene = new THREE.Scene();
    const objects = new Map<string, THREE.Object3D>();
    const { data, obj } = placed('o', 'ghost', [4, 5, 6]);
    objects.set('o', obj);
    attachToParent(objects, scene, data);
    attachToParent(objects, scene, data);
    expect(obj.parent).toBe(scene);
    expect(snapshot(obj).p).toEqual([4, 5, 6]);
  });
});
