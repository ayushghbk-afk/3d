import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyOutline, applyOutlineSet } from '../../src/engine/viewport.js';
import { MaterialManager } from '../../src/engine/materials.js';
import { defaultMaterial } from '../../src/state/models.js';

// Regression (select mode): the highlight used to tint the material IN PLACE,
// so objects sharing one material (all primitives shared doc.materials[0])
// lit up together when a single object was selected. The highlight now swaps
// each selected mesh onto a highlighted CLONE — the shared material and every
// other object using it stay untouched.

const BLUE = 0x2266ff;

function objWithMat(mat: THREE.Material): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  return group;
}

function firstMesh(o: THREE.Object3D): THREE.Mesh {
  return o.children[0] as THREE.Mesh;
}

describe('selection highlight', () => {
  it('highlights via a material clone and restores the original on deselect', () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const obj = objWithMat(mat);
    const objects = new Map<string, THREE.Object3D>([['a', obj]]);
    applyOutline(objects, 'a');
    const mesh = firstMesh(obj);
    const highlighted = mesh.material as THREE.MeshStandardMaterial;
    expect(highlighted).not.toBe(mat); // override clone, not the shared material
    expect(highlighted.emissive.getHex()).toBe(BLUE);
    expect(mat.emissive.getHex()).toBe(0x000000); // source material untouched
    applyOutline(objects, null);
    expect(mesh.material).toBe(mat);
    expect(mat.emissive.getHex()).toBe(0x000000);
    expect(mat.emissiveIntensity).toBe(1);
    expect(mat.color.getHex()).toBe(0xff0000);
  });

  it('restores a custom emissive across repeated select cycles', () => {
    const mat = new THREE.MeshStandardMaterial();
    mat.emissive.setHex(0x112233);
    mat.emissiveIntensity = 2;
    const obj = objWithMat(mat);
    const objects = new Map<string, THREE.Object3D>([['a', obj]]);
    for (let i = 0; i < 3; i++) {
      applyOutline(objects, 'a');
      expect((firstMesh(obj).material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(BLUE);
      applyOutline(objects, null);
      expect(firstMesh(obj).material).toBe(mat);
      expect(mat.emissive.getHex()).toBe(0x112233);
      expect(mat.emissiveIntensity).toBe(2);
    }
  });

  it('switching selection restores the previous object', () => {
    const matA = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const matB = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const objA = objWithMat(matA);
    const objB = objWithMat(matB);
    const objects = new Map<string, THREE.Object3D>([
      ['a', objA],
      ['b', objB],
    ]);
    applyOutline(objects, 'a');
    expect(firstMesh(objA).material).not.toBe(matA);
    expect(firstMesh(objB).material).toBe(matB);
    applyOutline(objects, 'b');
    expect(firstMesh(objA).material).toBe(matA);
    expect(firstMesh(objB).material).not.toBe(matB);
    applyOutline(objects, null);
    expect(firstMesh(objA).material).toBe(matA);
    expect(firstMesh(objB).material).toBe(matB);
    expect(matA.emissive.getHex()).toBe(0x000000);
    expect(matB.emissive.getHex()).toBe(0x000000);
  });

  it('objects sharing one material do NOT light up together (select-mode fix)', () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const objA = objWithMat(shared);
    const objB = objWithMat(shared); // same material instance on purpose
    const objects = new Map<string, THREE.Object3D>([
      ['a', objA],
      ['b', objB],
    ]);
    applyOutline(objects, 'a');
    // only a is overridden; b keeps rendering the shared material
    expect(firstMesh(objA).material).not.toBe(shared);
    expect(firstMesh(objB).material).toBe(shared);
    expect((firstMesh(objA).material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(BLUE);
    expect(shared.emissive.getHex()).toBe(0x000000);
    applyOutlineSet(objects, new Set(['a', 'b']));
    expect(firstMesh(objB).material).not.toBe(shared);
    applyOutlineSet(objects, new Set());
    expect(firstMesh(objA).material).toBe(shared);
    expect(firstMesh(objB).material).toBe(shared);
    expect(shared.emissive.getHex()).toBe(0x000000);
  });

  it('material sync never leaves the highlight stuck: doc emissive shows after deselect', () => {
    const mgr = new MaterialManager();
    const data = defaultMaterial('M');
    const mat = mgr.get(data);
    const obj = objWithMat(mat);
    const objects = new Map<string, THREE.Object3D>([['a', obj]]);
    applyOutline(objects, 'a');
    expect((firstMesh(obj).material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(BLUE);
    // Doc edit while selected: the source material follows the doc immediately
    // (the highlight lives on the clone), and deselect reveals it.
    mgr.get({ ...data, emissive: '#ff0000', emissiveIntensity: 2 });
    expect(mat.emissive.getHex()).toBe(0xff0000);
    applyOutline(objects, null);
    expect(firstMesh(obj).material).toBe(mat);
    expect(mat.emissive.getHex()).toBe(0xff0000);
    expect(mat.emissiveIntensity).toBe(2);
  });

  it('material sync applies doc emissive when nothing is highlighted', () => {
    const mgr = new MaterialManager();
    const data = defaultMaterial('M');
    const mat = mgr.get(data);
    expect(mat.emissive.getHex()).toBe(0x000000);
    mgr.get({ ...data, emissive: '#00ff00', emissiveIntensity: 1.5 });
    expect(mat.emissive.getHex()).toBe(0x00ff00);
    expect(mat.emissiveIntensity).toBe(1.5);
  });
});
