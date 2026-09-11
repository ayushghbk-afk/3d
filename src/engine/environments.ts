import * as THREE from 'three';
import type { EnvironmentPreset } from '../state/models.js';

/**
 * Procedural environments ("HDRIs" without the download).
 *
 * Each preset is a tiny three scene (gradient dome + a few area-ish emitters)
 * run through PMREMGenerator, so the editor gets image-based lighting — and a
 * matching backdrop — with zero network cost and no binary assets in the repo.
 */

export interface EnvironmentPresetInfo {
  id: EnvironmentPreset;
  label: string;
  sky: [string, string];
  ground: string;
  sun?: { color: string; intensity: number; position: [number, number, number] };
  rim?: { color: string; intensity: number; position: [number, number, number] };
  fog: string | null;
}

export const ENVIRONMENT_PRESETS: EnvironmentPresetInfo[] = [
  { id: 'room', label: 'Room (default)', sky: ['#4a5468', '#191d26'], ground: '#20242e', sun: { color: '#ffffff', intensity: 1.6, position: [4, 6, 3] }, rim: { color: '#8fb7ff', intensity: 0.7, position: [-4, 2, -3] }, fog: null },
  { id: 'studio', label: 'Studio', sky: ['#e9eef8', '#8d97ab'], ground: '#c9cfda', sun: { color: '#ffffff', intensity: 2.6, position: [3, 5, 4] }, rim: { color: '#ffffff', intensity: 1.4, position: [-4, 3, 2] }, fog: null },
  { id: 'sunset', label: 'Sunset', sky: ['#ffb27a', '#3a2a55'], ground: '#4a2c2a', sun: { color: '#ffb066', intensity: 3.2, position: [6, 1.4, 2] }, rim: { color: '#5c6bff', intensity: 0.8, position: [-5, 2, -3] }, fog: '#c98a63' },
  { id: 'night', label: 'Night', sky: ['#0b1224', '#02040a'], ground: '#05070d', sun: { color: '#9fc0ff', intensity: 0.5, position: [-3, 6, -2] }, rim: { color: '#2b3a7a', intensity: 0.5, position: [4, 1, 3] }, fog: '#070b16' },
  { id: 'overcast', label: 'Overcast', sky: ['#c8d2de', '#7d8794'], ground: '#6d757f', sun: { color: '#dfe7f2', intensity: 1.1, position: [2, 6, 1] }, rim: { color: '#b9c3d1', intensity: 0.6, position: [-3, 2, -4] }, fog: '#b7c0cc' },
  { id: 'cyberpunk', label: 'Cyberpunk', sky: ['#2a0f4a', '#04030c'], ground: '#0a0714', sun: { color: '#ff3fb4', intensity: 2.2, position: [4, 2, 3] }, rim: { color: '#22e0ff', intensity: 2.4, position: [-4, 1.6, -2] }, fog: '#150a2a' },
  { id: 'forest', label: 'Forest', sky: ['#a8d5a2', '#26381f'], ground: '#2b3a22', sun: { color: '#d8f0c0', intensity: 2, position: [3, 7, 2] }, rim: { color: '#4f7a3a', intensity: 0.7, position: [-4, 2, -3] }, fog: '#6f8f63' },
  { id: 'void', label: 'Void (dark)', sky: ['#101018', '#000000'], ground: '#000000', sun: { color: '#ffffff', intensity: 0.35, position: [0, 6, 0] }, rim: { color: '#223', intensity: 0.15, position: [0, -4, 0] }, fog: null },
];

export function environmentPreset(id: EnvironmentPreset): EnvironmentPresetInfo {
  return ENVIRONMENT_PRESETS.find((p) => p.id === id) ?? ENVIRONMENT_PRESETS[0];
}

/** Build the (tiny) scene that PMREM will convolute into an environment map. */
function buildEnvScene(info: EnvironmentPresetInfo): THREE.Scene {
  const scene = new THREE.Scene();

  // gradient dome
  const geo = new THREE.SphereGeometry(50, 24, 16);
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, info.sky[0]);
    grad.addColorStop(0.55, info.sky[1]);
    grad.addColorStop(1, info.ground);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 8, 64);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }));
  scene.add(dome);

  // floor bounce
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(info.ground) }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -6;
  scene.add(floor);

  // key + rim emitters
  const emitters: [EnvironmentPresetInfo['sun'], EnvironmentPresetInfo['rim']] = [info.sun, info.rim];
  for (const e of emitters) {
    if (!e) continue;
    const light = new THREE.DirectionalLight(new THREE.Color(e.color), e.intensity);
    light.position.set(...e.position);
    scene.add(light);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(e.color) }),
    );
    panel.position.set(e.position[0] * 2, e.position[1] * 2, e.position[2] * 2);
    panel.lookAt(0, 0, 0);
    scene.add(panel);
  }
  return scene;
}

export class EnvironmentManager {
  private pmrem: THREE.PMREMGenerator;
  private cache = new Map<string, THREE.Texture>();
  private current: { key: string; texture: THREE.Texture } | null = null;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /** Environment map for a preset (cached; rotation is baked into the key). */
  get(id: EnvironmentPreset, rotation = 0): THREE.Texture {
    const key = `${id}|${Math.round(rotation * 100) / 100}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const scene = buildEnvScene(environmentPreset(id));
    if (rotation) scene.rotation.y = rotation;
    const rt = this.pmrem.fromScene(scene, 0.04);
    const tex: THREE.Texture = rt.texture;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((m) => {
        (m as THREE.Material).dispose();
        if ('map' in m && (m as THREE.MeshBasicMaterial).map) ((m as THREE.MeshBasicMaterial).map as THREE.Texture).dispose();
      });
    });
    this.cache.set(key, tex);
    return tex;
  }

  apply(scene: THREE.Scene, id: EnvironmentPreset, intensity: number, rotation: number, background: boolean): void {
    const tex = this.get(id, rotation);
    this.current = { key: `${id}|${rotation}`, texture: tex };
    scene.environment = tex;
    scene.background = background ? tex : new THREE.Color('#11141b');
    void intensity;
  }

  dispose(): void {
    this.pmrem.dispose();
    this.cache.forEach((t) => t.dispose());
    this.cache.clear();
    this.current = null;
  }
}
