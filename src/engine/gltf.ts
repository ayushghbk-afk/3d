import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export interface ParsedGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export async function parseGlb(data: ArrayBuffer): Promise<ParsedGltf> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(data, '');
  return { scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] };
}

export function exportGlb(root: THREE.Object3D): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('GLB export did not return binary data'));
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true, animations: [] },
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
