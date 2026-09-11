import {
  defaultLight, type EnvironmentPreset, type FogSettings, type MaterialData, type PostFxSettings,
  type ProjectDoc, type SceneObjectData,
} from '../state/models.js';

/**
 * Scene styling — “make this scene look like a cyberpunk game”.
 *
 * A style is a deterministic remap of materials, lighting, environment, fog
 * and post-processing. It is intentionally data-driven so the same code serves
 * the command palette, the AI panel and the Agent API.
 */

export type SceneStyleId =
  | 'cyberpunk' | 'sunset' | 'night' | 'studio' | 'forest' | 'minimal'
  | 'clay' | 'golden' | 'blueprint' | 'candy' | 'horror' | 'scifi';

export interface SceneStyle {
  id: SceneStyleId;
  label: string;
  description: string;
  keywords: string[];
  environment: EnvironmentPreset;
  envIntensity: number;
  fog: FogSettings | null;
  postfx: PostFxSettings;
  /** Palette used to recolour existing materials (cycled by material index). */
  palette: string[];
  metalness: number;
  roughness: number;
  /** Emissive treatment: null keeps materials unlit. */
  emissive: { colors: string[]; intensity: number; share: number } | null;
  background: boolean;
  lights: { kind: 'point' | 'directional' | 'spot' | 'hemisphere'; color: string; intensity: number; position: [number, number, number] }[];
  /** Force every material double-sided (helps glass/clay looks). */
  doubleSided?: boolean;
  transmission?: number;
}

export const SCENE_STYLES: SceneStyle[] = [
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    description: 'Neon magenta and cyan, wet asphalt, heavy bloom',
    keywords: ['cyberpunk', 'neon', 'synthwave', 'blade runner', 'futuristic', 'sci-fi', 'scifi', 'tron'],
    environment: 'cyberpunk',
    envIntensity: 1.15,
    fog: { enabled: true, color: '#1a0b2e', near: 6, far: 40 },
    postfx: { enabled: true, bloom: 0.85, vignette: 0.45, grain: 0.08, dof: 0.15 },
    palette: ['#12121f', '#2a1245', '#ff2fb3', '#22e0ff', '#7a5cff', '#0f2a3d'],
    metalness: 0.65,
    roughness: 0.28,
    emissive: { colors: ['#ff2fb3', '#22e0ff', '#7a5cff'], intensity: 1.1, share: 0.55 },
    background: true,
    lights: [
      { kind: 'directional', color: '#8f7dff', intensity: 1.1, position: [4, 6, 3] },
      { kind: 'point', color: '#ff2fb3', intensity: 18, position: [-4, 2, 3] },
      { kind: 'point', color: '#22e0ff', intensity: 16, position: [4, 1.5, -3] },
    ],
  },
  {
    id: 'sunset',
    label: 'Golden hour',
    description: 'Warm low sun, long shadows, hazy distance',
    keywords: ['sunset', 'golden hour', 'dusk', 'warm', 'evening'],
    environment: 'sunset',
    envIntensity: 1.2,
    fog: { enabled: true, color: '#d99a6c', near: 14, far: 70 },
    postfx: { enabled: true, bloom: 0.4, vignette: 0.3, grain: 0.05, dof: 0 },
    palette: ['#f7e2c8', '#e0a76b', '#b9713f', '#6d4b34', '#3f3128'],
    metalness: 0.08,
    roughness: 0.68,
    emissive: null,
    background: true,
    lights: [
      { kind: 'directional', color: '#ffb877', intensity: 2.6, position: [8, 2.5, 3] },
      { kind: 'hemisphere', color: '#ffd9b0', intensity: 0.8, position: [0, 4, 0] },
    ],
  },
  {
    id: 'night',
    label: 'Night',
    description: 'Moonlit blues, high contrast, subtle bloom',
    keywords: ['night', 'midnight', 'moonlit', 'dark', 'noir'],
    environment: 'night',
    envIntensity: 0.85,
    fog: { enabled: true, color: '#080d1a', near: 8, far: 55 },
    postfx: { enabled: true, bloom: 0.5, vignette: 0.5, grain: 0.1, dof: 0 },
    palette: ['#1b2233', '#2c3a56', '#4a6fa5', '#91b4e0', '#d7e5ff'],
    metalness: 0.25,
    roughness: 0.55,
    emissive: { colors: ['#7fb2ff', '#cfe3ff'], intensity: 0.5, share: 0.25 },
    background: true,
    lights: [
      { kind: 'directional', color: '#9fc0ff', intensity: 0.85, position: [-5, 7, -3] },
      { kind: 'point', color: '#5b8cff', intensity: 14, position: [3, 2, 4] },
    ],
  },
  {
    id: 'studio',
    label: 'Studio',
    description: 'Clean product lighting on a bright backdrop',
    keywords: ['studio', 'product', 'clean', 'showcase', 'ecommerce', 'white'],
    environment: 'studio',
    envIntensity: 1.35,
    fog: null,
    postfx: { enabled: false, bloom: 0.2, vignette: 0.2, grain: 0, dof: 0 },
    palette: ['#f4f7fc', '#dbe3ef', '#b9c4d6', '#8f9bb0', '#5b6a80'],
    metalness: 0.15,
    roughness: 0.35,
    emissive: null,
    background: true,
    lights: [
      { kind: 'directional', color: '#ffffff', intensity: 2.4, position: [4, 6, 4] },
      { kind: 'point', color: '#e8f0ff', intensity: 16, position: [-4, 2, 3] },
    ],
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Dappled green light, soft haze',
    keywords: ['forest', 'jungle', 'woods', 'nature', 'garden'],
    environment: 'forest',
    envIntensity: 1.1,
    fog: { enabled: true, color: '#8fae86', near: 10, far: 60 },
    postfx: { enabled: true, bloom: 0.3, vignette: 0.35, grain: 0.06, dof: 0 },
    palette: ['#3c7a4b', '#5c8f4f', '#8fae86', '#6b5a34', '#2f4a2c'],
    metalness: 0.03,
    roughness: 0.82,
    emissive: null,
    background: true,
    lights: [
      { kind: 'directional', color: '#d8f0c0', intensity: 2.1, position: [5, 9, 3] },
      { kind: 'hemisphere', color: '#a8d5a2', intensity: 0.9, position: [0, 4, 0] },
    ],
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Neutral greys, matte finishes, no frills',
    keywords: ['minimal', 'minimalist', 'neutral', 'grey', 'gray', 'muted', 'scandinavian'],
    environment: 'overcast',
    envIntensity: 1.05,
    fog: null,
    postfx: { enabled: false, bloom: 0, vignette: 0.15, grain: 0, dof: 0 },
    palette: ['#f2f3f5', '#d8dbe0', '#aeb4bd', '#7c838d', '#4b5158'],
    metalness: 0.05,
    roughness: 0.85,
    emissive: null,
    background: false,
    lights: [
      { kind: 'directional', color: '#ffffff', intensity: 1.6, position: [3, 6, 4] },
      { kind: 'hemisphere', color: '#dfe6f2', intensity: 0.9, position: [0, 4, 0] },
    ],
  },
  {
    id: 'clay',
    label: 'Clay render',
    description: 'Uniform matte clay — the classic modelling preview',
    keywords: ['clay', 'matte', 'sculpt', 'grey clay', 'untextured'],
    environment: 'studio',
    envIntensity: 1.1,
    fog: null,
    postfx: { enabled: false, bloom: 0, vignette: 0.25, grain: 0, dof: 0 },
    palette: ['#c9b3a3', '#b39b8b', '#d6c3b3'],
    metalness: 0,
    roughness: 0.95,
    emissive: null,
    background: false,
    lights: [
      { kind: 'directional', color: '#fff3e6', intensity: 2, position: [4, 6, 3] },
      { kind: 'hemisphere', color: '#ffe9d6', intensity: 0.85, position: [0, 4, 0] },
    ],
  },
  {
    id: 'golden',
    label: 'Gold luxe',
    description: 'Polished gold and deep charcoal',
    keywords: ['gold', 'luxury', 'luxe', 'brass', 'premium', 'jewel'],
    environment: 'studio',
    envIntensity: 1.25,
    fog: null,
    postfx: { enabled: true, bloom: 0.45, vignette: 0.4, grain: 0.04, dof: 0.1 },
    palette: ['#ffd76a', '#e0a53c', '#8a6a2f', '#22242a', '#0f1014'],
    metalness: 0.9,
    roughness: 0.18,
    emissive: null,
    background: true,
    lights: [
      { kind: 'directional', color: '#fff0c8', intensity: 2.2, position: [4, 5, 4] },
      { kind: 'point', color: '#ffcf7a', intensity: 14, position: [-3, 2, 3] },
    ],
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    description: 'Technical blue-on-navy schematic look',
    keywords: ['blueprint', 'technical', 'schematic', 'wireframe', 'cad', 'engineering'],
    environment: 'night',
    envIntensity: 0.7,
    fog: { enabled: true, color: '#0b1e3a', near: 10, far: 60 },
    postfx: { enabled: true, bloom: 0.3, vignette: 0.4, grain: 0.06, dof: 0 },
    palette: ['#8ec6ff', '#4b8fe0', '#2a5f9e', '#123a63', '#0a1c30'],
    metalness: 0.1,
    roughness: 0.5,
    emissive: { colors: ['#8ec6ff', '#4b8fe0'], intensity: 0.35, share: 0.7 },
    background: true,
    lights: [
      { kind: 'hemisphere', color: '#9cc9ff', intensity: 1.2, position: [0, 4, 0] },
      { kind: 'directional', color: '#cfe6ff', intensity: 0.9, position: [3, 6, 3] },
    ],
  },
  {
    id: 'candy',
    label: 'Candy',
    description: 'Saturated pastel toy-world colours',
    keywords: ['candy', 'pastel', 'toy', 'playful', 'kids', 'cute', 'low poly'],
    environment: 'studio',
    envIntensity: 1.15,
    fog: null,
    postfx: { enabled: true, bloom: 0.25, vignette: 0.2, grain: 0.03, dof: 0 },
    palette: ['#ff9ec4', '#ffd76a', '#8ef0c8', '#8fc4ff', '#c8a2ff'],
    metalness: 0.05,
    roughness: 0.42,
    emissive: null,
    background: false,
    lights: [
      { kind: 'directional', color: '#ffffff', intensity: 1.9, position: [3, 6, 4] },
      { kind: 'hemisphere', color: '#ffe6f2', intensity: 1, position: [0, 4, 0] },
    ],
  },
  {
    id: 'horror',
    label: 'Horror',
    description: 'Desaturated cold light, deep fog, heavy vignette',
    keywords: ['horror', 'scary', 'creepy', 'abandoned', 'eerie', 'haunted'],
    environment: 'night',
    envIntensity: 0.6,
    fog: { enabled: true, color: '#14161a', near: 4, far: 26 },
    postfx: { enabled: true, bloom: 0.2, vignette: 0.7, grain: 0.16, dof: 0.2 },
    palette: ['#2b2f34', '#3d4348', '#5a5f63', '#7d7a72', '#1a1c1f'],
    metalness: 0.12,
    roughness: 0.88,
    emissive: { colors: ['#5c7f6a', '#7d5a4a'], intensity: 0.22, share: 0.18 },
    background: true,
    lights: [
      { kind: 'spot', color: '#cfe0ff', intensity: 22, position: [0, 5, 2] },
      { kind: 'point', color: '#7fa0c0', intensity: 6, position: [-3, 1.5, -2] },
    ],
  },
  {
    id: 'scifi',
    label: 'Clean sci-fi',
    description: 'White panels, cyan accents, bright interior lighting',
    keywords: ['sci-fi', 'scifi', 'space station', 'futuristic interior', 'starship', 'clean sci'],
    environment: 'studio',
    envIntensity: 1.1,
    fog: { enabled: true, color: '#c9d8e8', near: 16, far: 70 },
    postfx: { enabled: true, bloom: 0.4, vignette: 0.3, grain: 0.04, dof: 0 },
    palette: ['#eef3f8', '#c7d2e0', '#8fa2b8', '#3c4a5c', '#22e0ff'],
    metalness: 0.55,
    roughness: 0.32,
    emissive: { colors: ['#22e0ff', '#9fe8ff'], intensity: 0.85, share: 0.3 },
    background: true,
    lights: [
      { kind: 'directional', color: '#eaf4ff', intensity: 2, position: [4, 7, 4] },
      { kind: 'point', color: '#22e0ff', intensity: 12, position: [-3, 2.5, 2] },
      { kind: 'hemisphere', color: '#dbe9ff', intensity: 0.9, position: [0, 4, 0] },
    ],
  },
];

export function findStyle(text: string): SceneStyle | null {
  const p = text.toLowerCase();
  let best: { style: SceneStyle; score: number } | null = null;
  for (const style of SCENE_STYLES) {
    let score = 0;
    for (const k of style.keywords) {
      if (p.includes(k)) score += k.length;
    }
    if (score && (!best || score > best.score)) best = { style, score };
  }
  return best?.style ?? null;
}

export function styleById(id: SceneStyleId): SceneStyle {
  return SCENE_STYLES.find((s) => s.id === id) ?? SCENE_STYLES[0];
}

export interface StyleOutcome {
  materials: number;
  lights: number;
  style: SceneStyle;
}

/**
 * Apply a style to the document: remaps materials, replaces the style lights,
 * sets environment/fog/postfx. Existing scene lights are replaced so the mood
 * is consistent (their transforms are untouched if the count matches).
 */
export function applyStyle(doc: ProjectDoc, style: SceneStyle, opts: { relight?: boolean } = {}): StyleOutcome {
  const relight = opts.relight !== false;
  // 1. materials
  doc.materials.forEach((m: MaterialData, i: number) => {
    const color = style.palette[i % style.palette.length];
    m.baseColor = color;
    m.metalness = style.metalness;
    m.roughness = style.roughness;
    if (style.doubleSided) m.side = 'double';
    if (style.transmission !== undefined) m.transmission = style.transmission;
    if (style.emissive && (i / Math.max(1, doc.materials.length)) < style.emissive.share) {
      m.emissive = style.emissive.colors[i % style.emissive.colors.length];
      m.emissiveIntensity = style.emissive.intensity;
    } else {
      m.emissive = '#000000';
      m.emissiveIntensity = 0;
    }
    m.updatedAt = new Date().toISOString();
  });

  // 2. lights
  let lights = 0;
  if (relight) {
    const existing = doc.objects.filter((o) => o.type === 'light');
    for (let i = 0; i < style.lights.length; i++) {
      const spec = style.lights[i];
      const target: SceneObjectData | undefined = existing[i];
      if (target) {
        target.light = {
          ...(target.light ?? defaultLight(spec.kind)),
          kind: spec.kind,
          color: spec.color,
          intensity: spec.intensity,
          distance: target.light?.distance ?? 20,
          angle: target.light?.angle ?? 0.6,
          penumbra: target.light?.penumbra ?? 0.4,
          castShadow: target.light?.castShadow ?? i === 0,
        };
        if (i >= style.lights.length - existing.length && target.position.x === 0 && target.position.y === 0) {
          target.position = { x: spec.position[0], y: spec.position[1], z: spec.position[2] };
        }
      } else {
        doc.objects.push({
          id: `style-light-${i}-${Date.now()}`,
          name: `${style.label} light ${i + 1}`,
          type: 'light',
          position: { x: spec.position[0], y: spec.position[1], z: spec.position[2] },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          visible: true,
          locked: false,
          parentId: null,
          materialId: null,
          pivot: { x: 0, y: 0, z: 0 },
          baked: null,
          collectionIds: [],
          physics: null,
          light: {
            kind: spec.kind,
            color: spec.color,
            intensity: spec.intensity,
            distance: 20,
            angle: 0.6,
            penumbra: 0.4,
            castShadow: i === 0,
          },
          updatedAt: new Date().toISOString(),
          version: 1,
        });
      }
      lights++;
    }
    for (let i = style.lights.length; i < existing.length; i++) {
      const extra = existing[i];
      doc.objects = doc.objects.filter((o) => o.id !== extra.id);
    }
  }

  // 3. presentation
  doc.settings.environment = {
    preset: style.environment,
    intensity: style.envIntensity,
    rotation: doc.settings.environment?.rotation ?? 0,
    background: style.background,
  };
  doc.settings.envIntensity = style.envIntensity;
  doc.settings.fog = style.fog;
  doc.settings.postfx = style.postfx;
  return { materials: doc.materials.length, lights, style };
}
