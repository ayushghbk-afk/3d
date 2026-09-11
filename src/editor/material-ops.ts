import type { EditorSession } from './session.js';
import { defaultMaterial, materialPreset, type MaterialData, type MaterialPresetId } from '../state/models.js';
import { pickFiles } from '../lib/utils.js';
import { toast } from '../ui/toast.js';

/**
 * Material editor commands: PBR presets, per-map assignment (base colour,
 * normal, AO) and the AI texture entry points used by the palette.
 */
export interface MaterialOps {
  applyMaterialPreset(this: EditorSession, materialId: string, preset: MaterialPresetId): MaterialData | null;
  applyMaterialPresetToSelection(this: EditorSession, preset: MaterialPresetId): number;
  newMaterialFromPreset(this: EditorSession, preset: MaterialPresetId, name?: string): MaterialData;
  setMaterialMap(this: EditorSession, materialId: string, slot: 'base' | 'normal' | 'ao', assetId: string | null): void;
  uploadTextureForSelection(this: EditorSession): Promise<void>;
  uploadMapForSelection(this: EditorSession, slot: 'base' | 'normal' | 'ao'): Promise<void>;
  generateTextureForSelection(this: EditorSession): Promise<void>;
  duplicateMaterial(this: EditorSession, id: string): MaterialData | null;
  deleteMaterial(this: EditorSession, id: string): void;
  /** Materials used by the current selection. */
  selectionMaterials(this: EditorSession): MaterialData[];
}

const SLOT_FIELD = {
  base: 'mapAssetId',
  normal: 'normalMapAssetId',
  ao: 'aoMapAssetId',
} as const;

export const materialOps: MaterialOps = {
  applyMaterialPreset(materialId, preset): MaterialData | null {
    const m = this.doc.materials.find((x) => x.id === materialId);
    if (!m) return null;
    this.history.checkpoint(this.doc, `Material: ${preset}`);
    const patch = materialPreset(preset);
    if (preset === 'neon' && !patch.emissive) patch.emissive = m.baseColor;
    Object.assign(m, patch, { updatedAt: new Date().toISOString() });
    this.viewport.syncMaterials(this.doc.materials);
    this.markDirty('material');
    this.sync.broadcastMaterial(m);
    return m;
  },

  applyMaterialPresetToSelection(preset): number {
    const mats = this.selectionMaterials();
    if (!mats.length) {
      this.notice('warn', 'Select an object with a material first');
      return 0;
    }
    for (const m of mats) this.applyMaterialPreset(m.id, preset);
    toast(`${preset} applied to ${mats.length} material${mats.length === 1 ? '' : 's'}`, 'success');
    return mats.length;
  },

  newMaterialFromPreset(preset, name): MaterialData {
    this.history.checkpoint(this.doc, 'New material');
    const m = defaultMaterial(name ?? preset.charAt(0).toUpperCase() + preset.slice(1));
    Object.assign(m, materialPreset(preset));
    this.doc.materials.push(m);
    this.viewport.syncMaterials(this.doc.materials);
    this.markDirty('material');
    this.sync.broadcastMaterial(m);
    return m;
  },

  setMaterialMap(materialId, slot, assetId): void {
    const m = this.doc.materials.find((x) => x.id === materialId);
    if (!m) return;
    this.history.checkpoint(this.doc, 'Assign map');
    const field = SLOT_FIELD[slot];
    if (assetId) {
      (m[field] as string | null) = assetId;
    } else {
      (m[field] as string | null) = null;
      void this.removeTexture(materialId);
    }
    m.updatedAt = new Date().toISOString();
    this.markDirty('material');
    this.sync.broadcastMaterial(m);
    void this.hydrateTextures();
  },

  async uploadTextureForSelection(): Promise<void> {
    await this.uploadMapForSelection('base');
  },

  async uploadMapForSelection(slot): Promise<void> {
    const mats = this.selectionMaterials();
    if (!mats.length) {
      this.notice('warn', 'Select an object with a material first');
      return;
    }
    const files = await pickFiles('image/*');
    if (!files.length) return;
    toast(`Uploading ${files[0].name}…`);
    await this.uploadTexture(mats[0].id, files[0], slot === 'base' ? undefined : slot);
    toast(`${slot === 'base' ? 'Texture' : slot.toUpperCase()} map applied`, 'success');
  },

  async generateTextureForSelection(): Promise<void> {
    const mats = this.selectionMaterials();
    if (!mats.length) {
      this.notice('warn', 'Select an object with a material first');
      return;
    }
    const prompt = window.prompt('Describe the texture (AI)', 'brushed metal panel, seamless');
    if (!prompt) return;
    toast('Generating texture…');
    try {
      await this.generateTexture(prompt, { materialId: mats[0].id });
      toast('Texture generated', 'success');
    } catch (e) {
      toast(`Texture failed: ${(e as Error).message}`, 'warn');
    }
  },

  duplicateMaterial(id): MaterialData | null {
    const src = this.doc.materials.find((m) => m.id === id);
    if (!src) return null;
    this.history.checkpoint(this.doc, 'Duplicate material');
    const copy: MaterialData = { ...JSON.parse(JSON.stringify(src)), id: `${src.id}-copy-${Date.now()}`, name: `${src.name} copy`, updatedAt: new Date().toISOString() };
    this.doc.materials.push(copy);
    this.viewport.syncMaterials(this.doc.materials);
    this.markDirty('material');
    return copy;
  },

  deleteMaterial(id): void {
    if (this.doc.materials.length <= 1) {
      this.notice('warn', 'Keep at least one material');
      return;
    }
    this.history.checkpoint(this.doc, 'Delete material');
    this.doc.materials = this.doc.materials.filter((m) => m.id !== id);
    for (const o of this.doc.objects) {
      if (o.materialId === id) o.materialId = this.doc.materials[0]?.id ?? null;
    }
    this.viewport.syncMaterials(this.doc.materials);
    for (const o of this.doc.objects) this.viewport.updateObject(o);
    this.markDirty('material');
  },

  selectionMaterials(): MaterialData[] {
    const out = new Map<string, MaterialData>();
    for (const o of this.selectedObjects()) {
      const m = this.doc.materials.find((x) => x.id === o.materialId);
      if (m) out.set(m.id, m);
    }
    return [...out.values()];
  },
};
