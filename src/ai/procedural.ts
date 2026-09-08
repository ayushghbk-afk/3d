// Offline fallbacks — always available, zero network:
// - Procedural textures: seeded canvas gradients/noise (clearly labeled).
// - Procedural 3D: keyword-matched primitive compositions applied through the
//   normal object API, so they undo/redo, save and sync like anything else.
import type { ImageGenOptions, ImageGenResult, MeshGenOptions, MeshGenResult } from './types.js';
import type { PrimitiveType } from '../state/models.js';
import type { ImageProvider, MeshProvider } from './providers.js';
import { randomSeed } from './providers.js';

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTES: [string, string][] = [
  ['#8b9bb4', '#3a4356'], ['#c9a06a', '#5a3d22'], ['#7fb069', '#2d4a22'],
  ['#e15554', '#5c1f1f'], ['#5b8cff', '#1c2a52'], ['#c084fc', '#4a1d6b'],
  ['#9ad1d4', '#2a5a5e'], ['#e8c547', '#6b5310'],
];

export class ProceduralImageProvider implements ImageProvider {
  id = 'procedural';
  label = 'Offline pattern (no AI)';
  free = true;

  async generateImage(prompt: string, opts: ImageGenOptions = {}): Promise<ImageGenResult> {
    const seed = opts.seed ?? hashStr(prompt.toLowerCase()) % 1000000;
    const rand = mulberry32(seed || 1);
    const width = opts.width ?? 512;
    const height = opts.height ?? 512;
    const [c1, c2] = PALETTES[seed % PALETTES.length];
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(64, Math.min(1024, width));
    canvas.height = Math.max(64, Math.min(1024, height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available for the offline texture.');
    // Layered gradient + soft blobs + grain => plausible stylized surface.
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 26; i++) {
      const x = rand() * canvas.width;
      const y = rand() * canvas.height;
      const r = (0.04 + rand() * 0.16) * Math.max(canvas.width, canvas.height);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const light = rand() > 0.5;
      g.addColorStop(0, light ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Grain
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() - 0.5) * 36;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not encode the offline texture.');
    return { blob, mime: 'image/png', width: canvas.width, height: canvas.height, seed, provider: this.id, prompt };
  }
}

// ---------- procedural 3D plans ----------

export interface ProcPart {
  kind: PrimitiveType | 'group';
  name: string;
  position: [number, number, number];
  scale?: [number, number, number];
  color?: string;
}

function abstraction(seed: number): ProcPart[] {
  const rand = mulberry32(seed || 7);
  const kinds: PrimitiveType[] = ['cube', 'sphere', 'cylinder', 'cone', 'torus'];
  const parts: ProcPart[] = [];
  const n = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) {
    parts.push({
      kind: kinds[Math.floor(rand() * kinds.length)],
      name: `Part ${i + 1}`,
      position: [(rand() - 0.5) * 3, 0.4 + rand() * 1.4, (rand() - 0.5) * 3],
      scale: [0.4 + rand() * 0.9, 0.4 + rand() * 0.9, 0.4 + rand() * 0.9],
    });
  }
  return parts;
}

const TEMPLATES: { match: RegExp; build: () => ProcPart[] }[] = [
  {
    match: /chair|seat|stool|throne/i,
    build: () => [
      { kind: 'cube', name: 'Seat', position: [0, 0.55, 0], scale: [1, 0.12, 1], color: '#8b5e3c' },
      { kind: 'cube', name: 'Back', position: [0, 1.1, -0.46], scale: [1, 1, 0.1], color: '#8b5e3c' },
      { kind: 'cylinder', name: 'Leg FL', position: [-0.4, 0.25, 0.4], scale: [0.08, 0.5, 0.08], color: '#5a3d22' },
      { kind: 'cylinder', name: 'Leg FR', position: [0.4, 0.25, 0.4], scale: [0.08, 0.5, 0.08], color: '#5a3d22' },
      { kind: 'cylinder', name: 'Leg BL', position: [-0.4, 0.25, -0.4], scale: [0.08, 0.5, 0.08], color: '#5a3d22' },
      { kind: 'cylinder', name: 'Leg BR', position: [0.4, 0.25, -0.4], scale: [0.08, 0.5, 0.08], color: '#5a3d22' },
    ],
  },
  {
    match: /table|desk/i,
    build: () => [
      { kind: 'cube', name: 'Top', position: [0, 0.95, 0], scale: [2.4, 0.12, 1.4], color: '#9c6b3f' },
      { kind: 'cube', name: 'Leg L', position: [-1, 0.45, 0], scale: [0.14, 0.9, 1.1], color: '#6b4a2a' },
      { kind: 'cube', name: 'Leg R', position: [1, 0.45, 0], scale: [0.14, 0.9, 1.1], color: '#6b4a2a' },
    ],
  },
  {
    match: /lamp|light|lantern/i,
    build: () => [
      { kind: 'cylinder', name: 'Base', position: [0, 0.06, 0], scale: [0.5, 0.12, 0.5], color: '#3a4356' },
      { kind: 'cylinder', name: 'Pole', position: [0, 0.8, 0], scale: [0.07, 1.5, 0.07], color: '#3a4356' },
      { kind: 'cone', name: 'Shade', position: [0, 1.7, 0], scale: [0.7, 0.6, 0.7], color: '#f5e6b8' },
      { kind: 'sphere', name: 'Bulb', position: [0, 1.55, 0], scale: [0.22, 0.22, 0.22], color: '#fff3c4' },
    ],
  },
  {
    match: /tree|pine|plant/i,
    build: () => [
      { kind: 'cylinder', name: 'Trunk', position: [0, 0.6, 0], scale: [0.25, 1.2, 0.25], color: '#6b4a2a' },
      { kind: 'cone', name: 'Leaves 1', position: [0, 1.7, 0], scale: [1.6, 1.4, 1.6], color: '#2d6a4f' },
      { kind: 'cone', name: 'Leaves 2', position: [0, 2.5, 0], scale: [1.1, 1.1, 1.1], color: '#40916c' },
    ],
  },
  {
    match: /house|home|cabin|hut/i,
    build: () => [
      { kind: 'cube', name: 'Walls', position: [0, 0.8, 0], scale: [2.4, 1.6, 2], color: '#d9c8a9' },
      { kind: 'cone', name: 'Roof', position: [0, 2.2, 0], scale: [2, 1.2, 2], color: '#a44a3f' },
      { kind: 'cube', name: 'Door', position: [0, 0.5, 1.01], scale: [0.6, 1, 0.06], color: '#5a3d22' },
    ],
  },
  {
    match: /car|truck|van|vehicle/i,
    build: () => [
      { kind: 'cube', name: 'Body', position: [0, 0.55, 0], scale: [2.4, 0.6, 1.2], color: '#c0392b' },
      { kind: 'cube', name: 'Cabin', position: [-0.2, 1.05, 0], scale: [1.2, 0.5, 1.05], color: '#7fb3d5' },
      { kind: 'cylinder', name: 'Wheel FL', position: [0.75, 0.3, 0.62], scale: [0.32, 0.15, 0.32], color: '#222222' },
      { kind: 'cylinder', name: 'Wheel FR', position: [0.75, 0.3, -0.62], scale: [0.32, 0.15, 0.32], color: '#222222' },
      { kind: 'cylinder', name: 'Wheel BL', position: [-0.75, 0.3, 0.62], scale: [0.32, 0.15, 0.32], color: '#222222' },
      { kind: 'cylinder', name: 'Wheel BR', position: [-0.75, 0.3, -0.62], scale: [0.32, 0.15, 0.32], color: '#222222' },
    ],
  },
  {
    match: /rocket|missile|spaceship/i,
    build: () => [
      { kind: 'cylinder', name: 'Body', position: [0, 1, 0], scale: [0.5, 1.8, 0.5], color: '#dfe3ea' },
      { kind: 'cone', name: 'Nose', position: [0, 2.2, 0], scale: [0.5, 0.9, 0.5], color: '#c0392b' },
      { kind: 'cone', name: 'Fin 1', position: [0.45, 0.25, 0], scale: [0.18, 0.7, 0.5], color: '#c0392b' },
      { kind: 'cone', name: 'Fin 2', position: [-0.45, 0.25, 0], scale: [0.18, 0.7, 0.5], color: '#c0392b' },
    ],
  },
  {
    match: /sword|knife|blade/i,
    build: () => [
      { kind: 'cube', name: 'Blade', position: [0, 1, 0], scale: [0.16, 1.8, 0.05], color: '#cfd6e4' },
      { kind: 'cube', name: 'Guard', position: [0, 0.05, 0], scale: [0.6, 0.1, 0.12], color: '#8a6d3b' },
      { kind: 'cylinder', name: 'Grip', position: [0, -0.3, 0], scale: [0.09, 0.6, 0.09], color: '#4a3222' },
    ],
  },
  {
    match: /robot|droid|golem/i,
    build: () => [
      { kind: 'cube', name: 'Torso', position: [0, 1.15, 0], scale: [0.9, 1, 0.55], color: '#8b9bb4' },
      { kind: 'cube', name: 'Head', position: [0, 1.95, 0], scale: [0.55, 0.5, 0.5], color: '#aeb9cf' },
      { kind: 'cube', name: 'Arm L', position: [-0.62, 1.15, 0], scale: [0.28, 0.9, 0.3], color: '#6e7b93' },
      { kind: 'cube', name: 'Arm R', position: [0.62, 1.15, 0], scale: [0.28, 0.9, 0.3], color: '#6e7b93' },
      { kind: 'cube', name: 'Leg L', position: [-0.24, 0.3, 0], scale: [0.32, 0.6, 0.35], color: '#6e7b93' },
      { kind: 'cube', name: 'Leg R', position: [0.24, 0.3, 0], scale: [0.32, 0.6, 0.35], color: '#6e7b93' },
    ],
  },
  {
    match: /cup|mug|glass|bottle/i,
    build: () => [
      { kind: 'cylinder', name: 'Cup', position: [0, 0.45, 0], scale: [0.6, 0.9, 0.6], color: '#e8e4da' },
      { kind: 'torus', name: 'Handle', position: [0.62, 0.45, 0], scale: [0.35, 0.45, 0.2], color: '#d5cfc0' },
    ],
  },
];

/** Pick a primitive-composition plan for a prompt (pure, unit-tested). */
export function planProcedural(prompt: string): { template: string; parts: ProcPart[] } {
  const text = prompt.trim() || 'object';
  for (const t of TEMPLATES) {
    if (t.match.test(text)) return { template: t.match.source.slice(0, 32), parts: t.build() };
  }
  return { template: 'abstract', parts: abstraction(hashStr(text.toLowerCase())) };
}

/** MeshProvider adapter: procedural plans carry no GLB, so textTo3D throws a
 *  catchable marker — the agent/UI apply the plan via object ops instead. */
export class ProceduralMeshProvider implements MeshProvider {
  id = 'procedural-mesh';
  label = 'Offline primitives (no AI)';
  free = true;

  async textTo3D(prompt: string, _opts: MeshGenOptions = {}): Promise<MeshGenResult> {
    const { template, parts } = planProcedural(prompt);
    throw proceduralPlanError(prompt, template, parts);
  }
}

export interface ProceduralPlanMarker {
  proceduralPlan: true;
  prompt: string;
  template: string;
  parts: ProcPart[];
}

export function proceduralPlanError(prompt: string, template: string, parts: ProcPart[]): Error & { plan: ProceduralPlanMarker } {
  const err = new Error('PROCEDURAL_PLAN') as Error & { plan: ProceduralPlanMarker };
  err.plan = { proceduralPlan: true, prompt, template, parts };
  return err;
}

export function isProceduralPlanError(e: unknown): e is Error & { plan: ProceduralPlanMarker } {
  return e instanceof Error && e.message === 'PROCEDURAL_PLAN' && !!(e as { plan?: unknown }).plan;
}

export function proceduralSeed(): number {
  return randomSeed();
}
