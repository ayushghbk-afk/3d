import * as THREE from 'three';
import type { PrimitiveType } from '../state/models.js';

export const PRIMITIVE_DEFAULTS: Record<PrimitiveType, Record<string, number>> = {
  cube: { w: 1, h: 1, d: 1 },
  sphere: { radius: 0.5, widthSeg: 32, heightSeg: 16 },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSeg: 32 },
  cone: { radius: 0.5, height: 1, radialSeg: 32 },
  plane: { w: 1, h: 1 },
  torus: { radius: 0.5, tube: 0.2, radialSeg: 16, tubularSeg: 48 },
};

export function makePrimitiveGeometry(kind: PrimitiveType, params: Record<string, number>): THREE.BufferGeometry {
  const p = { ...PRIMITIVE_DEFAULTS[kind], ...params };
  switch (kind) {
    case 'cube':
      return new THREE.BoxGeometry(p.w, p.h, p.d);
    case 'sphere':
      return new THREE.SphereGeometry(p.radius, Math.round(p.widthSeg), Math.round(p.heightSeg));
    case 'cylinder':
      return new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, Math.round(p.radialSeg));
    case 'cone':
      return new THREE.ConeGeometry(p.radius, p.height, Math.round(p.radialSeg));
    case 'plane':
      return new THREE.PlaneGeometry(p.w, p.h);
    case 'torus':
      return new THREE.TorusGeometry(p.radius, p.tube, Math.round(p.radialSeg), Math.round(p.tubularSeg));
  }
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        const mm = m as THREE.MeshStandardMaterial;
        // shared cached materials are owned by MaterialManager; only dispose maps owned here
        Object.values(mm).forEach(() => undefined);
      });
    }
  });
}

export function disposeGeometry(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry?.dispose();
  });
}
