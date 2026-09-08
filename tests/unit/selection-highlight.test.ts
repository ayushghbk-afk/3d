import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyOutline } from '../../src/engine/viewport.js';
import { MaterialManager } from '../../src/engine/materials.js';
import { defaultMaterial } from '../../src/state/models.js';

// Regression: deselecting must restore the object's original color. The
// default emissive is black (0x000000, falsy) — the old `if (!base)` snapshot
// check re-captured the blue highlight itself as the "base", so objects
// stayed light-blue forever after the first selection.

const BLUE = 0x2266ff;

function objWithMat(mat: THREE.Material): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
  return group;
}

describe('selection highlight', () => {
  it('tints on select and restores black emissive on deselect', () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const objects = new Map<string, THREE.Object3D>([['a', objWithMat(mat)]]);
    applyOutline(objects, 'a');
    expect(mat.emissive.getHex()).toBe(BLUE);
    applyOutline(objects, null);
    expect(mat.emissive.getHex()).toBe(0x000000);
    expect(mat.emissiveIntensity).toBe(1);
    expect(mat.color.getHex()).toBe(0xff0000);
  });

  it('restores a custom emissive across repeated select cycles', () => {
    const mat = new THREE.MeshStandardMaterial();
    mat.emissive.setHex(0x112233);
    mat.emissiveIntensity = 2;
    const objects = new Map<string, THREE.Object3D>([['a', objWithMat(mat)]]);
    for (let i = 0; i < 3; i++) {
      applyOutline(objects, 'a');
      expect(mat.emissive.getHex()).toBe(BLUE);
      applyOutline(objects, null);
      expect(mat.emissive.getHex()).toBe(0x112233);
      expect(mat.emissiveIntensity).toBe(2);
    }
  });

  it('switching selection restores the previous object', () => {
    const matA = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const matB = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    const objects = new Map<string, THREE.Object3D>([
      ['a', objWithMat(matA)],
      ['b', objWithMat(matB)],
    ]);
    applyOutline(objects, 'a');
    expect(matA.emissive.getHex()).toBe(BLUE);
    expect(matB.emissive.getHex()).toBe(0x000000);
    applyOutline(objects, 'b');
    expect(matA.emissive.getHex()).toBe(0x000000);
    expect(matB.emissive.getHex()).toBe(BLUE);
    applyOutline(objects, null);
    expect(matA.emissive.getHex()).toBe(0x000000);
    expect(matB.emissive.getHex()).toBe(0x000000);
  });

  it('material sync preserves an active highlight but refreshes its base', () => {
    const mgr = new MaterialManager();
    const data = defaultMaterial('M');
    const mat = mgr.get(data);
    const objects = new Map<string, THREE.Object3D>([['a', objWithMat(mat)]]);
    applyOutline(objects, 'a');
    expect(mat.emissive.getHex()).toBe(BLUE);
    // Doc edit while selected: highlight stays, snapshot follows the doc.
    mgr.get({ ...data, emissive: '#ff0000', emissiveIntensity: 2 });
    expect(mat.emissive.getHex()).toBe(BLUE);
    applyOutline(objects, null);
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
