import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { AnimClip } from '../state/models.js';

export interface ParsedGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

/**
 * Node name usable as a PropertyBinding target: no dots (track-path syntax),
 * no spaces; keep it readable but suffix the object index for uniqueness —
 * duplicate names would make GLTFExporter resolve tracks to the wrong node.
 */
export function exportNodeName(base: string, index: number): string {
  const clean = (base || 'object').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'object';
  return `${clean}-${index}`;
}

/**
 * Convert studio AnimClips into THREE.AnimationClips bound to `idToNode`
 * (objectId → exported scene node). GLTFExporter then writes real
 * glTF animations. `interp:'step'` keys hold their value until the next key,
 * which is expressed by duplicating the key at the following key's time.
 * Tracks whose object/node is missing or that have <2 keys are skipped —
 * the exporter cannot bake a meaningful channel from them.
 */
export function docClipsToAnimationClips(
  clips: AnimClip[],
  idToNode: Map<string, THREE.Object3D>,
): THREE.AnimationClip[] {
  const out: THREE.AnimationClip[] = [];
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const fpsOf = (clip: AnimClip) => Math.max(1, clip.fps);

  for (const clip of clips) {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const t of clip.tracks) {
      if (t.keyframes.length < 2) continue;
      const node = idToNode.get(t.objectId);
      if (!node) continue;
      const times: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < t.keyframes.length; i++) {
        const k = t.keyframes[i];
        times.push(k.frame / fpsOf(clip));
        if (t.property === 'rotation') {
          e.set(k.value[0], k.value[1], k.value[2]);
          q.setFromEuler(e);
          values.push(q.x, q.y, q.z, q.w);
        } else {
          values.push(k.value[0], k.value[1], k.value[2]);
        }
        if (k.interp === 'step' && i + 1 < t.keyframes.length) {
          times.push(t.keyframes[i + 1].frame / fpsOf(clip));
          if (t.property === 'rotation') {
            values.push(values[values.length - 4], values[values.length - 3], values[values.length - 2], values[values.length - 1]);
          } else {
            values.push(values[values.length - 3], values[values.length - 2], values[values.length - 1]);
          }
        }
      }
      const name = `${node.name}.${t.property === 'rotation' ? 'quaternion' : t.property}`;
      tracks.push(
        t.property === 'rotation'
          ? new THREE.QuaternionKeyframeTrack(name, times, values)
          : new THREE.VectorKeyframeTrack(name, times, values),
      );
    }
    if (tracks.length) out.push(new THREE.AnimationClip(clip.name || 'Clip', clip.length / fpsOf(clip), tracks));
  }
  return out;
}

export async function parseGlb(data: ArrayBuffer): Promise<ParsedGltf> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data, '');
  return { scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] };
}

export function exportGlb(root: THREE.Object3D, animations: THREE.AnimationClip[] = []): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('GLB export did not return binary data'));
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true, animations },
    );
  });
}

export function exportGlbJson(root: THREE.Object3D): Promise<Record<string, unknown>> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (result) => resolve(result as unknown as Record<string, unknown>),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: false },
    );
  });
}
