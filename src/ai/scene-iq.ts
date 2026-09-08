// Scene IQ: the AI looks at groups to figure out what a model IS (chair,
// car, lamp…), then takes full control of coordinates, colors and textures:
// coherent palettes per part role, AI textures per role, and tidy layouts.
// Pure functions over ProjectDoc — used by the Agent API (scene.*) and UI.
import type { ProjectDoc, SceneObjectData } from '../state/models.js';

export interface RoleStyle {
  role: string;
  color: string;
  metalness?: number;
  roughness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /** Base phrase for AI texture generation (seamless suffix added later). */
  texture?: string;
}

export interface ModelProfile {
  id: string;
  label: string;
  /** Tested against "group name + part names" for identification. */
  match: RegExp;
  /** Role rules, first match wins. Tested against the part name. */
  roles: { match: RegExp; style: RoleStyle }[];
}

const WOOD = { roughness: 0.75, metalness: 0.05 };
const DARK_WOOD = { roughness: 0.8, metalness: 0.05 };
const METAL = { roughness: 0.4, metalness: 0.7 };
const FABRIC = { roughness: 0.9, metalness: 0 };

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'chair', label: 'chair', match: /chair|seat|stool|throne|bench|sofa/i,
    roles: [
      { match: /leg|base|foot/i, style: { role: 'legs', color: '#5a3d22', ...DARK_WOOD, texture: 'dark walnut wood grain' } },
      { match: /.*/i, style: { role: 'seat', color: '#8b5e3c', ...WOOD, texture: 'oak wood grain' } },
    ],
  },
  {
    id: 'table', label: 'table', match: /table|desk|counter/i,
    roles: [
      { match: /leg/i, style: { role: 'legs', color: '#6b4a2a', ...DARK_WOOD, texture: 'dark walnut wood grain' } },
      { match: /.*/i, style: { role: 'top', color: '#9c6b3f', ...WOOD, texture: 'oak wood grain' } },
    ],
  },
  {
    id: 'lamp', label: 'lamp', match: /lamp|light|lantern|chandelier/i,
    roles: [
      { match: /bulb|glow/i, style: { role: 'bulb', color: '#fff3c4', emissive: '#ffedb0', emissiveIntensity: 1.4, roughness: 0.4 } },
      { match: /shade/i, style: { role: 'shade', color: '#f5e6b8', roughness: 0.85, texture: 'fabric lampshade weave' } },
      { match: /.*/i, style: { role: 'stand', color: '#3a4356', ...METAL, texture: 'brushed dark metal' } },
    ],
  },
  {
    id: 'tree', label: 'tree', match: /tree|pine|plant|bush|palm/i,
    roles: [
      { match: /trunk|stem|branch|bark|pot/i, style: { role: 'trunk', color: '#6b4a2a', ...DARK_WOOD, texture: 'rough tree bark' } },
      { match: /.*/i, style: { role: 'leaves', color: '#2d6a4f', roughness: 0.9, texture: 'dense green foliage' } },
    ],
  },
  {
    id: 'house', label: 'house', match: /house|home|cabin|hut|building|tower/i,
    roles: [
      { match: /roof/i, style: { role: 'roof', color: '#a44a3f', roughness: 0.8, texture: 'clay roof tiles' } },
      { match: /door|gate/i, style: { role: 'door', color: '#5a3d22', ...DARK_WOOD, texture: 'wooden door planks' } },
      { match: /window|glass/i, style: { role: 'glass', color: '#7fb3d5', metalness: 0.9, roughness: 0.12 } },
      { match: /.*/i, style: { role: 'walls', color: '#d9c8a9', roughness: 0.9, texture: 'warm plaster wall' } },
    ],
  },
  {
    id: 'car', label: 'car', match: /car|truck|van|vehicle|wagon|jeep|taxi/i,
    roles: [
      { match: /wheel|tire/i, style: { role: 'wheels', color: '#1b1d22', roughness: 0.9, texture: 'rubber tire tread' } },
      { match: /glass|window|cabin|wind/i, style: { role: 'glass', color: '#7fb3d5', metalness: 0.9, roughness: 0.12 } },
      { match: /.*/i, style: { role: 'body', color: '#c0392b', metalness: 0.6, roughness: 0.35, texture: 'glossy car paint' } },
    ],
  },
  {
    id: 'rocket', label: 'rocket', match: /rocket|missile|spaceship|shuttle/i,
    roles: [
      { match: /nose|fin|stripe/i, style: { role: 'accents', color: '#c0392b', metalness: 0.5, roughness: 0.4 } },
      { match: /.*/i, style: { role: 'body', color: '#dfe3ea', metalness: 0.4, roughness: 0.35, texture: 'brushed spacecraft hull metal' } },
    ],
  },
  {
    id: 'robot', label: 'robot', match: /robot|droid|golem|mech|android/i,
    roles: [
      { match: /eye|screen|core|light/i, style: { role: 'lights', color: '#66ccff', emissive: '#3399ff', emissiveIntensity: 1.2, roughness: 0.3 } },
      { match: /.*/i, style: { role: 'armor', color: '#8b9bb4', ...METAL, texture: 'brushed robot armor metal' } },
    ],
  },
  {
    id: 'cup', label: 'cup', match: /cup|mug|glass|bottle|vase|pot/i,
    roles: [
      { match: /.*/i, style: { role: 'ceramic', color: '#e8e4da', roughness: 0.3, metalness: 0.05, texture: 'glazed ceramic' } },
    ],
  },
  {
    id: 'sword', label: 'sword', match: /sword|knife|blade|dagger|axe/i,
    roles: [
      { match: /grip|handle|hilt/i, style: { role: 'grip', color: '#4a3222', ...DARK_WOOD, texture: 'wrapped leather grip' } },
      { match: /guard|pommel/i, style: { role: 'fittings', color: '#8a6d3b', metalness: 0.85, roughness: 0.35 } },
      { match: /.*/i, style: { role: 'blade', color: '#cfd6e4', metalness: 0.9, roughness: 0.25 } },
    ],
  },
];

/** Generic part-name roles used when no profile (or no profile rule) matches. */
export const GENERIC_ROLES: { match: RegExp; style: RoleStyle }[] = [
  { match: /wheel|tire/i, style: { role: 'wheels', color: '#1b1d22', roughness: 0.9, texture: 'rubber tire tread' } },
  { match: /glass|window/i, style: { role: 'glass', color: '#7fb3d5', metalness: 0.9, roughness: 0.12 } },
  { match: /bulb|glow|flame|fire/i, style: { role: 'glow', color: '#ffdf8a', emissive: '#ffb830', emissiveIntensity: 1.2, roughness: 0.4 } },
  { match: /screen|display|monitor/i, style: { role: 'screen', color: '#0e2233', emissive: '#4499ff', emissiveIntensity: 0.9, roughness: 0.3 } },
  { match: /leaf|leaves|foliage|bush|grass|flower/i, style: { role: 'leaves', color: '#2d6a4f', roughness: 0.9, texture: 'dense green foliage' } },
  { match: /trunk|bark|branch|stem|twig/i, style: { role: 'trunk', color: '#6b4a2a', ...DARK_WOOD, texture: 'rough tree bark' } },
  { match: /roof/i, style: { role: 'roof', color: '#a44a3f', roughness: 0.8, texture: 'clay roof tiles' } },
  { match: /door|gate|hatch/i, style: { role: 'door', color: '#5a3d22', ...DARK_WOOD, texture: 'wooden door planks' } },
  { match: /wall/i, style: { role: 'walls', color: '#d9c8a9', roughness: 0.9, texture: 'warm plaster wall' } },
  { match: /seat|cushion|pillow|mattress/i, style: { role: 'fabric', color: '#a85f32', ...FABRIC, texture: 'woven fabric upholstery' } },
  { match: /blade|sword|knife/i, style: { role: 'blade', color: '#cfd6e4', metalness: 0.9, roughness: 0.25 } },
  { match: /handle|grip|knob|lever/i, style: { role: 'grip', color: '#3a3f4a', roughness: 0.7, texture: 'dark rubber grip' } },
  { match: /gold|brass|bronze/i, style: { role: 'brass', color: '#d4af37', metalness: 1, roughness: 0.3 } },
  { match: /steel|iron|metal|chrome/i, style: { role: 'metal', color: '#9aa4b2', ...METAL, texture: 'brushed steel' } },
  { match: /wood|plank|beam/i, style: { role: 'wood', color: '#8b5e3c', ...WOOD, texture: 'oak wood grain' } },
  { match: /stone|rock|concrete|brick/i, style: { role: 'stone', color: '#8d8d96', roughness: 0.95, texture: 'rough stone surface' } },
  { match: /leg|stand|base|foot|pedestal|pole|post/i, style: { role: 'support', color: '#4a4038', roughness: 0.8, texture: 'dark stained wood' } },
];

export interface IdentifiedPart {
  objectId: string;
  name: string;
  type: string;
  role: string;
  style: RoleStyle | null;
}

export interface IdentifiedGroup {
  /** null = loose ungrouped parts analyzed as one pseudo-group. */
  groupId: string | null;
  groupName: string;
  label: string;
  confidence: number;
  parts: IdentifiedPart[];
}

function matchStyle(name: string, profile: ModelProfile | null): RoleStyle | null {
  if (profile) {
    for (const rule of profile.roles) {
      if (rule.match.test(name)) return rule.style;
    }
  }
  for (const rule of GENERIC_ROLES) {
    if (rule.match.test(name)) return rule.style;
  }
  return null;
}

function identifyParts(groupName: string, parts: SceneObjectData[]): { profile: ModelProfile | null; confidence: number } {
  const haystack = `${groupName} ${parts.map((p) => p.name).join(' ')}`;
  let best: ModelProfile | null = null;
  let bestScore = 0;
  for (const profile of MODEL_PROFILES) {
    let score = 0;
    if (profile.match.test(groupName)) score += 3;
    for (const p of parts) {
      if (profile.match.test(p.name)) score += 1;
    }
    // Structural bonus: multi-part groups match "model-like" profiles better.
    if (score > 0 && parts.length >= 3) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  void haystack;
  if (!best) return { profile: null, confidence: 0.2 };
  const confidence = Math.min(0.95, 0.35 + bestScore * 0.15);
  return { profile: best, confidence: Math.round(confidence * 100) / 100 };
}

function toIdentified(groupId: string | null, groupName: string, parts: SceneObjectData[]): IdentifiedGroup {
  const { profile, confidence } = identifyParts(groupName, parts);
  return {
    groupId,
    groupName,
    label: profile?.label ?? 'object',
    confidence,
    parts: parts.map((p) => {
      const style = matchStyle(p.name, profile);
      return {
        objectId: p.id,
        name: p.name,
        type: p.type,
        role: style?.role ?? 'keep',
        style,
      };
    }),
  };
}

/** Group every mesh-holding object under its top group (or pseudo-groups). */
export function analyzeScene(doc: ProjectDoc): { groups: IdentifiedGroup[]; summary: string } {
  const paintables = doc.objects.filter((o) => o.type !== 'light');
  const groups = doc.objects.filter((o) => o.type === 'group');
  const result: IdentifiedGroup[] = [];
  const claimed = new Set<string>();

  for (const g of groups) {
    const children = paintables.filter((o) => o.parentId === g.id && o.id !== g.id);
    if (!children.length) continue;
    children.forEach((c) => claimed.add(c.id));
    result.push(toIdentified(g.id, g.name, children));
  }
  // Loose roots (ungrouped): analyze each as its own single-part model.
  for (const o of paintables) {
    if (o.type === 'group' || o.parentId || claimed.has(o.id)) continue;
    result.push(toIdentified(null, o.name, [o]));
  }
  const named = result.filter((g) => g.label !== 'object').length;
  const summary = result.length
    ? `Found ${result.length} model${result.length === 1 ? '' : 's'} (${named} identified: ${result.filter((g) => g.label !== 'object').map((g) => g.label).join(', ') || 'none'}).`
    : 'Scene is empty.';
  return { groups: result, summary };
}

export interface PaintItem {
  objectId: string;
  objectName: string;
  groupLabel: string;
  role: string;
  materialName: string;
  patch: {
    baseColor: string;
    metalness?: number;
    roughness?: number;
    emissive?: string;
    emissiveIntensity?: number;
  };
  texturePrompt?: string;
}

/** Flatten an analysis into concrete material assignments (skips 'keep' parts). */
export function planPaint(doc: ProjectDoc, groupIds?: string[] | null): PaintItem[] {
  const { groups } = analyzeScene(doc);
  const items: PaintItem[] = [];
  for (const g of groups) {
    if (groupIds && groupIds.length && !(g.groupId && groupIds.includes(g.groupId))) continue;
    for (const p of g.parts) {
      if (!p.style) continue;
      const s = p.style;
      items.push({
        objectId: p.objectId,
        objectName: p.name,
        groupLabel: g.label,
        role: s.role,
        materialName: `${g.groupName} ${s.role}`,
        patch: {
          baseColor: s.color,
          ...(s.metalness !== undefined ? { metalness: s.metalness } : {}),
          ...(s.roughness !== undefined ? { roughness: s.roughness } : {}),
          ...(s.emissive ? { emissive: s.emissive } : {}),
          ...(s.emissiveIntensity !== undefined ? { emissiveIntensity: s.emissiveIntensity } : {}),
        },
        ...(s.texture ? { texturePrompt: s.texture } : {}),
      });
    }
  }
  return items;
}

export interface TidyItem {
  objectId: string;
  name: string;
  x: number;
  z: number;
}

/** Arrange top-level models in a tidy grid (pure; the caller applies it). */
export function planTidy(doc: ProjectDoc, spacing = 3.5): { items: TidyItem[]; cols: number; spacing: number } {
  const roots = doc.objects
    .filter((o) => !o.parentId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const s = Math.max(1, Math.min(50, spacing || 3.5));
  const cols = Math.max(1, Math.ceil(Math.sqrt(roots.length)));
  return {
    cols,
    spacing: s,
    items: roots.map((o, i) => ({
      objectId: o.id,
      name: o.name,
      x: Math.round(((i % cols) * s) * 100) / 100,
      z: Math.round((Math.floor(i / cols) * s) * 100) / 100,
    })),
  };
}
