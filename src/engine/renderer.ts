import * as THREE from 'three';

export interface GpuCaps {
  webgl2: boolean;
  webgpu: boolean;
  lowPower: boolean;
  maxTextureSize: number;
}

export function detectCaps(): GpuCaps {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  const webgl2 = !!gl;
  let maxTextureSize = 2048;
  if (gl) {
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 500;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 4;
  const lowPower = smallScreen || (mem !== undefined && mem <= 4) || cores <= 4;
  return { webgl2, webgpu, lowPower, maxTextureSize };
}

export function createRenderer(canvas: HTMLCanvasElement, caps: GpuCaps): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !caps.lowPower,
    powerPreference: caps.lowPower ? 'low-power' : 'high-performance',
    stencil: false,
  });
  const maxRatio = caps.lowPower ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !caps.lowPower;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

// Future WebGPU path (§3): never required. Kept out of the bundle until a
// subsystem needs it (Phase 7) — the specifier is deliberately opaque to Vite.
export async function loadWebGpuRenderer(): Promise<unknown> {
  const specifier = ['three', 'webgpu'].join('/');
  return import(/* @vite-ignore */ specifier);
}
