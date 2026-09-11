import * as THREE from 'three';
import type { EditorSession } from './session.js';
import { planScene, expandPlan, describePlan, type ScenePlan } from '../ai/scene-planner.js';
import { applyStyle, findStyle, SCENE_STYLES, type SceneStyle, type SceneStyleId, styleById } from '../ai/style.js';
import { geometryStats } from '../engine/modeling.js';
import { defaultLight, defaultObject, type MaterialData, type ObjectType, type SceneObjectData } from '../state/models.js';
import { uid, nowIso } from '../lib/utils.js';

/**
 * Scene-aware AI commands: build a scene from a sentence, restyle the whole
 * scene, and a conservative optimiser. All three are offline-safe — the local
 * planner/style engine always produces a result when the LLM is unreachable.
 */
export interface AiOps {
  buildSceneFromPrompt(this: EditorSession, prompt: string, opts?: { replace?: boolean }): Promise<{ count: number; description: string; plan: ScenePlan }>;
  styleScene(this: EditorSession, prompt: string): Promise<{ style: SceneStyle; summary: string } | null>;
  applySceneStyle(this: EditorSession, id: SceneStyleId): { style: SceneStyle; summary: string };
  listSceneStyles(this: EditorSession): SceneStyle[];
  optimizeScene(this: EditorSession): Promise<string>;
}

function makeMaterial(session: EditorSession, name: string, patch: Record<string, unknown>): MaterialData {
  const m = session.addMaterial(name);
  const safe: Partial<MaterialData> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (k === 'baseColor' || k === 'emissive') {
      if (typeof val === 'string') (safe as Record<string, unknown>)[k] = val;
    } else if (typeof val === 'number') {
      (safe as Record<string, unknown>)[k] = val;
    } else if (typeof val === 'boolean') {
      (safe as Record<string, unknown>)[k] = val;
    }
  }
  Object.assign(m, safe, { updatedAt: nowIso() });
  return m;
}

export const aiOps: AiOps = {
  async buildSceneFromPrompt(prompt, opts = {}): Promise<{ count: number; description: string; plan: ScenePlan }> {
    const text = prompt.trim();
    if (!text) throw new Error('Describe the scene you want');
    this.history.checkpoint(this.doc, 'AI scene');
    if (opts.replace) {
      for (const o of [...this.doc.objects]) this.deleteObject(o.id);
    }

    const plan = await planScene(text);
    const concrete = expandPlan(plan);
    const created: SceneObjectData[] = [];
    const idMap = new Map<string, string>();

    for (const node of concrete) {
      const type: ObjectType = node.type;
      const data: SceneObjectData = defaultObject(type, node.name);
      data.position = { ...node.position };
      data.rotation = { ...node.rotation };
      data.scale = { ...node.scale };
      if (type === 'light') {
        data.light = {
          ...defaultLight(node.light?.kind ?? 'point'),
          intensity: node.light?.intensity ?? 8,
          color: node.light?.color ?? '#ffffff',
        };
      }
      idMap.set(node.tempId, data.id);
      this.doc.objects.push(data);
      this.viewport.addObject(data);
      this.sync.broadcastOp('add', data);
      created.push(data);

      if (type !== 'light' && type !== 'group') {
        const mat = makeMaterial(this, `${node.name} material`, node.materialPatch);
        this.assignMaterial(data.id, mat.id);
      }
    }

    // second pass: parenting (children may be created before their parent)
    concrete.forEach((node, i) => {
      const child = created[i];
      if (!node.parentTempId) return;
      const parentId = idMap.get(node.parentTempId);
      if (parentId) this.setParent(child.id, parentId);
    });

    if (plan.environment) {
      this.doc.settings.environment = {
        preset: plan.environment,
        intensity: 1.05,
        rotation: 0,
        background: plan.environment === 'void' || plan.environment === 'sunset' || plan.environment === 'cyberpunk',
      };
    }
    if (plan.fog) this.doc.settings.fog = { enabled: true, ...plan.fog };
    if (plan.postfx) {
      this.doc.settings.postfx = { enabled: true, bloom: plan.postfx.bloom ?? 0.4, vignette: plan.postfx.vignette ?? 0.3, grain: 0.05, dof: 0 };
    }
    this.applySettings();
    this.applySettingsFromDoc();
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.updateObject(o);

    // frame the result
    if (created.length) {
      const box = new THREE.Box3();
      for (const o of created) {
        const obj = this.viewport.objects.get(o.id);
        if (!obj) continue;
        const b = new THREE.Box3().setFromObject(obj);
        if (!b.isEmpty()) box.union(b);
      }
      if (!box.isEmpty()) {
        this.viewport.focusIds(created.map((o) => o.id));
      }
    }
    this.markDirty('ai scene');
    this.logActivity('system', `built a scene from “${text.slice(0, 60)}” (${created.length} objects)`);
    const description = describePlan(plan);
    this.notice('info', `${plan.title}: ${description}`);
    return { count: created.length, description, plan };
  },

  async styleScene(prompt): Promise<{ style: SceneStyle; summary: string } | null> {
    const text = prompt.trim();
    if (!text) return null;
    let style = findStyle(text);
    if (!style) {
      // ask the LLM to pick from the known style ids
      try {
        const { chatSmart } = await import('../ai/factory.js');
        const reply = await chatSmart([
          {
            role: 'system',
            content: `Reply with exactly one id from this list: ${SCENE_STYLES.map((s) => s.id).join(', ')}. Nothing else.`,
          },
          { role: 'user', content: `Which style matches: ${text}` },
        ], { maxTokens: 16, temperature: 0.1, signal: AbortSignal.timeout(12000) });
        const id = reply.trim().toLowerCase().replace(/[^a-z-]/g, '') as SceneStyleId;
        if (SCENE_STYLES.some((s) => s.id === id)) style = styleById(id);
      } catch {
        /* offline: keep the keyword result */
      }
    }
    if (!style) {
      this.notice('warn', 'Describe a mood, e.g. “cyberpunk”, “sunset”, “studio”, “clay”');
      return null;
    }
    return this.applySceneStyle(style.id);
  },

  applySceneStyle(id): { style: SceneStyle; summary: string } {
    const style = styleById(id);
    this.history.checkpoint(this.doc, `Style: ${style.label}`);
    const outcome = applyStyle(this.doc, style);
    this.rebuildFromDoc();
    this.applySettings();
    this.applySettingsFromDoc();
    this.markDirty('style');
    const summary = `${style.label}: ${outcome.materials} materials, ${outcome.lights} lights, ${style.environment} environment`;
    this.notice('info', summary);
    this.logActivity('style', `restyled the scene — ${style.label}`);
    return { style, summary };
  },

  listSceneStyles(): SceneStyle[] {
    return SCENE_STYLES;
  },

  async optimizeScene(): Promise<string> {
    const notes: string[] = [];
    let triTotal = 0;
    let heavy = 0;
    const seen = new Set<string>();
    for (const o of this.doc.objects) {
      const obj = this.viewport.objects.get(o.id);
      if (!obj) continue;
      const stats = geometryStats(obj);
      triTotal += stats.tris;
      if (stats.tris > 20000) heavy++;
      // share materials between objects with identical appearance
      const mat = this.doc.materials.find((m) => m.id === o.materialId);
      if (mat) {
        const key = `${mat.baseColor}|${mat.metalness}|${mat.roughness}|${mat.emissive}|${mat.emissiveIntensity}|${mat.opacity}`;
        if (seen.has(key) && this.doc.materials.length > 1) {
          const twin = this.doc.materials.find(
            (m) => `${m.baseColor}|${m.metalness}|${m.roughness}|${m.emissive}|${m.emissiveIntensity}|${m.opacity}` === key,
          );
          if (twin && twin.id !== mat.id) this.assignMaterial(o.id, twin.id);
        }
        seen.add(key);
      }
    }
    const before = this.doc.materials.length;
    // drop unused materials
    const used = new Set(this.doc.objects.map((o) => o.materialId).filter(Boolean) as string[]);
    this.doc.materials = this.doc.materials.filter((m) => used.has(m.id) || this.doc.materials.length <= 1);
    if (before !== this.doc.materials.length) notes.push(`removed ${before - this.doc.materials.length} unused materials`);
    this.viewport.syncMaterials(this.doc.materials);

    // cap shadow casters on low-power devices
    if (this.viewport.caps.lowPower && this.doc.settings.shadows) {
      this.updateSettings({ shadows: false });
      notes.push('shadows off (low-power device)');
    }
    // trim empty animation tracks
    let pruned = 0;
    for (const clip of this.doc.clips) {
      const before2 = clip.tracks.length;
      clip.tracks = clip.tracks.filter((t) => t.keyframes.length > 0);
      pruned += before2 - clip.tracks.length;
    }
    if (pruned) notes.push(`removed ${pruned} empty animation tracks`);

    this.markDirty('optimize');
    const summary = `${Math.round(triTotal).toLocaleString()} triangles · ${this.doc.materials.length} materials${heavy ? ` · ${heavy} heavy mesh(es) — try Simplify` : ''}${notes.length ? ` · ${notes.join(', ')}` : ''}`;
    this.notice('info', summary);
    return summary;
  },
};
