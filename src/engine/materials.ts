import * as THREE from 'three';
import type { MaterialData } from '../state/models.js';

// Owns shared MeshStandardMaterials. Geometries are owned by viewport objects,
// textures are owned by the session (see MaterialManager.setMap).
export type MapSlot = 'base' | 'normal' | 'ao';

export class MaterialManager {
  private cache = new Map<string, THREE.MeshPhysicalMaterial>();
  private maps = new Map<string, THREE.Texture | null>();
  private slotMaps = new Map<string, Partial<Record<MapSlot, THREE.Texture | null>>>();
  envIntensity = 1;

  sync(all: MaterialData[]): void {
    const alive = new Set(all.map((m) => m.id));
    for (const [id, mat] of this.cache) {
      if (!alive.has(id)) {
        mat.dispose();
        this.cache.delete(id);
        this.maps.delete(id);
      }
    }
    for (const m of all) this.get(m);
  }

  get(m: MaterialData): THREE.MeshPhysicalMaterial {
    let mat = this.cache.get(m.id);
    if (!mat) {
      // MeshPhysicalMaterial: superset of Standard (adds transmission/clearcoat)
      mat = new THREE.MeshPhysicalMaterial();
      this.cache.set(m.id, mat);
    }
    mat.name = m.name;
    mat.color.set(m.baseColor);
    mat.metalness = m.metalness;
    mat.roughness = m.roughness;
    // Keep the selection-highlight snapshot fresh, but never paint over an
    // active highlight (e.g. editing materials while an object is selected).
    mat.userData.baseEmissive = new THREE.Color(m.emissive).getHex();
    mat.userData.baseEmissiveIntensity = m.emissiveIntensity;
    if (!mat.userData.highlighted) {
      mat.emissive.set(m.emissive);
      mat.emissiveIntensity = m.emissiveIntensity;
    }
    mat.opacity = m.opacity;
    mat.transparent = m.transparent || m.opacity < 1;
    mat.envMapIntensity = this.envIntensity;
    // --- PBR extension ---
    mat.transmission = m.transmission;
    mat.ior = m.ior;
    mat.thickness = m.thickness;
    mat.clearcoat = m.clearcoat;
    mat.clearcoatRoughness = m.clearcoatRoughness;
    mat.transparent = m.transparent || m.opacity < 1 || m.transmission > 0;

    const slots = this.slotMaps.get(m.id) ?? {};
    const normalMap = slots.normal ?? null;
    const aoMap = slots.ao ?? null;
    if (normalMap && !mat.normalMap) mat.needsUpdate = true;
    if (aoMap && !mat.aoMap) mat.needsUpdate = true;
    mat.normalMap = normalMap;
    mat.normalScale.set(m.normalScale, m.normalScale);
    mat.aoMap = aoMap;
    mat.aoMapIntensity = m.aoIntensity;

    const side = m.side === 'double' ? THREE.DoubleSide : THREE.FrontSide;
    const map = this.maps.get(m.id) ?? null;
    // side / flatShading / map changes require a program rebuild
    const sig = `${side}|${m.flatShading ? 1 : 0}|${map?.uuid ?? 'none'}|${normalMap?.uuid ?? 'none'}|${aoMap?.uuid ?? 'none'}|${m.transmission > 0 ? 1 : 0}|${m.clearcoat > 0 ? 1 : 0}`;
    if (mat.userData.sig !== sig) {
      mat.side = side;
      mat.flatShading = m.flatShading;
      mat.map = map;
      mat.userData.sig = sig;
      mat.needsUpdate = true;
    }
    return mat;
  }

  /** Assign a normal / AO map (base colour goes through `setMap`). */
  setSlotMap(materialId: string, slot: MapSlot, tex: THREE.Texture | null): void {
    const slots = this.slotMaps.get(materialId) ?? {};
    slots[slot] = tex;
    this.slotMaps.set(materialId, slots);
    const mat = this.cache.get(materialId);
    if (!mat) return;
    if (slot === 'normal') {
      mat.normalMap = tex;
      mat.normalScale.set(1, 1);
    } else if (slot === 'ao') {
      mat.aoMap = tex;
      mat.aoMapIntensity = 1;
    }
    mat.needsUpdate = true;
  }

  /** Assign a texture map (owned/cached by the session, not disposed here). */
  setMap(materialId: string, tex: THREE.Texture | null, data?: MaterialData): void {
    this.maps.set(materialId, tex);
    const mat = this.cache.get(materialId);
    if (mat) {
      mat.map = tex;
      mat.userData.sig = `${mat.side}|${mat.flatShading ? 1 : 0}|${tex?.uuid ?? 'none'}`;
      mat.needsUpdate = true;
      if (data) {
        // keep color meaningful when textured (three multiplies map × color)
        mat.color.set(data.baseColor);
      }
    }
  }

  getById(id: string | null): THREE.MeshPhysicalMaterial | null {
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

  /** Force program rebuild on all materials (e.g. after toggling shadows). */
  touchAll(): void {
    this.cache.forEach((m) => {
      m.needsUpdate = true;
    });
  }

  dispose(): void {
    this.cache.forEach((m) => m.dispose());
    this.cache.clear();
    this.maps.clear();
    this.slotMaps.clear();
  }
}
