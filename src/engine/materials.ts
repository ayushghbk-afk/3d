import * as THREE from 'three';
import type { MaterialData } from '../state/models.js';

// Owns shared MeshStandardMaterials. Geometries are owned by viewport objects.
export class MaterialManager {
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  envIntensity = 1;

  sync(all: MaterialData[]): void {
    const alive = new Set(all.map((m) => m.id));
    for (const [id, mat] of this.cache) {
      if (!alive.has(id)) {
        mat.dispose();
        this.cache.delete(id);
      }
    }
    for (const m of all) this.get(m);
  }

  get(m: MaterialData): THREE.MeshStandardMaterial {
    let mat = this.cache.get(m.id);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial();
      this.cache.set(m.id, mat);
    }
    mat.name = m.name;
    mat.color.set(m.baseColor);
    mat.metalness = m.metalness;
    mat.roughness = m.roughness;
    mat.emissive.set(m.emissive);
    mat.emissiveIntensity = m.emissiveIntensity;
    mat.opacity = m.opacity;
    mat.transparent = m.transparent || m.opacity < 1;
    mat.envMapIntensity = this.envIntensity;
    mat.needsUpdate = false;
    return mat;
  }

  getById(id: string | null): THREE.MeshStandardMaterial | null {
    if (!id) return null;
    return this.cache.get(id) ?? null;
  }

  setEnvIntensity(v: number): void {
    this.envIntensity = v;
    this.cache.forEach((m) => {
      m.envMapIntensity = v;
    });
  }

  setWireframe(wire: boolean): void {
    this.cache.forEach((m) => {
      m.wireframe = wire;
    });
  }

  dispose(): void {
    this.cache.forEach((m) => m.dispose());
    this.cache.clear();
  }
}
