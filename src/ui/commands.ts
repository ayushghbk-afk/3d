import type { EditorSession } from '../editor/session.js';
import type { MaterialPresetId, PrimitiveType } from '../state/models.js';
import { toast } from './toast.js';
import { openVersionsModal, openMembersModal, openShortcutsModal } from './panels.js';
import { openExportModal, openShareModal } from './panels-extra.js';

export type PanelName = 'rail' | 'outliner' | 'inspector' | 'timeline' | 'assets' | 'animation' | 'presence';

/** Editor-level actions the command registry can't own itself. */
export interface CommandHost {
  session: EditorSession | null;
  togglePlay(): void;
  togglePanel(name: PanelName): void;
  resetLayout(): void;
  enterPlayMode(): void;
  exitPlayMode(): void;
  openImportBackup(): void;
  isPlayMode(): boolean;
}

let host: CommandHost | null = null;

export function setCommandHost(h: CommandHost | null): void {
  host = h;
}
export function getCommandHost(): CommandHost | null {
  return host;
}

export interface CommandContext {
  session: EditorSession | null;
}

export interface Command {
  id: string;
  title: string;
  group: string;
  icon?: string;
  /** Shortcut hint shown on the right of the palette row. */
  keys?: string;
  /** Extra search terms matched by fuzzy search. */
  keywords?: string;
  /** Hidden from the palette when false (still runnable by id). */
  when?: (session: EditorSession | null) => boolean;
  run: (session: EditorSession) => void | Promise<void>;
}

const PRIMS: { kind: PrimitiveType; label: string; icon: string }[] = [
  { kind: 'cube', label: 'Cube', icon: '▣' },
  { kind: 'sphere', label: 'Sphere', icon: '●' },
  { kind: 'cylinder', label: 'Cylinder', icon: '▤' },
  { kind: 'cone', label: 'Cone', icon: '▲' },
  { kind: 'plane', label: 'Plane', icon: '▱' },
  { kind: 'torus', label: 'Torus', icon: '◎' },
];

const PRESETS: { id: MaterialPresetId; label: string; icon: string }[] = [
  { id: 'plastic', label: 'Plastic', icon: '🧴' },
  { id: 'metal', label: 'Metal', icon: '🔩' },
  { id: 'glass', label: 'Glass', icon: '🪟' },
  { id: 'wood', label: 'Wood', icon: '🪵' },
  { id: 'stone', label: 'Stone', icon: '🪨' },
  { id: 'fabric', label: 'Fabric', icon: '🧵' },
  { id: 'neon', label: 'Neon', icon: '💡' },
  { id: 'gold', label: 'Gold', icon: '🥇' },
  { id: 'chrome', label: 'Chrome', icon: '🪞' },
  { id: 'rubber', label: 'Rubber', icon: '⚫' },
  { id: 'emerald', label: 'Emerald', icon: '🟢' },
  { id: 'matte', label: 'Matte', icon: '◻️' },
];

const VIEWS: { id: string; label: string; az: number; pol: number; keys?: string }[] = [
  { id: 'top', label: 'Top view', az: 0, pol: 1, keys: 'Numpad 7' },
  { id: 'front', label: 'Front view', az: 0, pol: 90, keys: 'Numpad 1' },
  { id: 'right', label: 'Right view', az: 90, pol: 90, keys: 'Numpad 3' },
  { id: 'back', label: 'Back view', az: 180, pol: 90 },
  { id: 'left', label: 'Left view', az: -90, pol: 90 },
  { id: 'bottom', label: 'Bottom view', az: 0, pol: 179 },
];

function requireSession(s: EditorSession | null): EditorSession | null {
  if (!s) return null;
  return s;
}

function buildCommands(): Command[] {
  const out: Command[] = [];

  // ---------- Create ----------
  for (const p of PRIMS) {
    out.push({
      id: `create.${p.kind}`,
      title: `Create ${p.label}`,
      group: 'Create',
      icon: p.icon,
      run: (s) => {
        s.addPrimitive(p.kind);
        toast(`${p.label} added`, 'success');
      },
    });
  }
  out.push(
    {
      id: 'create.group',
      title: 'Create Group',
      group: 'Create',
      icon: '🗂',
      keys: 'Ctrl+G',
      run: (s) => {
        if (!s.selection.count()) {
          const g = s.addGroup();
          s.renameObject(g.id, 'Group');
          toast('Group added', 'success');
        } else {
          s.groupSelection();
          toast('Grouped selection', 'success');
        }
      },
    },
    {
      id: 'create.light.point',
      title: 'Add Point Light',
      group: 'Create',
      icon: '💡',
      run: (s) => {
        const l = s.addLight('point');
        s.renameObject(l.id, 'Point Light');
        toast('Point light added', 'success');
      },
    },
    {
      id: 'create.light.spot',
      title: 'Add Spot Light',
      group: 'Create',
      icon: '🔦',
      run: (s) => {
        const l = s.addLight('spot');
        s.renameObject(l.id, 'Spot Light');
        toast('Spot light added', 'success');
      },
    },
    {
      id: 'create.light.directional',
      title: 'Add Directional Light (sun)',
      group: 'Create',
      icon: '☀️',
      run: (s) => {
        const l = s.addLight('directional');
        s.renameObject(l.id, 'Sun');
        toast('Sun light added', 'success');
      },
    },
    {
      id: 'create.light.ambient',
      title: 'Add Ambient Light',
      group: 'Create',
      icon: '🌫',
      run: (s) => { s.addLight('ambient'); },
    },
    {
      id: 'object.import',
      title: 'Import Model (GLB/glTF)',
      group: 'Create',
      icon: '📥',
      run: (s) => void importModel(s),
    },
  );

  // ---------- Select ----------
  out.push(
    { id: 'select.all', title: 'Select All', group: 'Select', icon: '▦', keys: 'Ctrl+A', run: (s) => s.selectAll() },
    { id: 'select.none', title: 'Select None', group: 'Select', icon: '◻', keys: 'Esc', run: (s) => s.selectNone() },
    { id: 'select.invert', title: 'Invert Selection', group: 'Select', icon: '🔄', keys: 'Ctrl+I', run: (s) => s.selectInvert() },
    { id: 'select.children', title: 'Select Children', group: 'Select', icon: '👶', run: (s) => s.selectChildren(true) },
    { id: 'select.parent', title: 'Select Parent', group: 'Select', icon: '👪', run: (s) => s.selectParent() },
    { id: 'select.siblings', title: 'Select Siblings', group: 'Select', icon: '👬', run: (s) => s.selectSiblings() },
    { id: 'select.sameMaterial', title: 'Select Same Material', group: 'Select', icon: '🎨', run: (s) => s.selectSameMaterial() },
    { id: 'select.next', title: 'Select Next Object', group: 'Select', icon: '➡', keys: 'Tab', run: (s) => s.selectCycle(1) },
    { id: 'select.prev', title: 'Select Previous Object', group: 'Select', icon: '⬅', keys: 'Shift+Tab', run: (s) => s.selectCycle(-1) },
    {
      id: 'object.hide',
      title: 'Hide Selection',
      group: 'Select',
      icon: '👁‍🗨',
      keys: 'H',
      run: (s) => s.hideSelection(),
    },
    {
      id: 'object.showAll',
      title: 'Show All Objects',
      group: 'Select',
      icon: '👁',
      keys: 'Shift+H',
      run: (s) => s.showAllObjects(),
    },
    { id: 'object.solo', title: 'Solo Selection (isolate)', group: 'Select', icon: '🎯', keys: '/', run: (s) => s.soloSelection() },
    { id: 'object.exitSolo', title: 'Exit Solo', group: 'Select', icon: '↩', when: (s) => !!s?.isSolo(), run: (s) => s.exitSolo() },
    { id: 'object.lock', title: 'Lock Selection', group: 'Select', icon: '🔒', run: (s) => s.lockSelection() },
    { id: 'object.unlockAll', title: 'Unlock All', group: 'Select', icon: '🔓', run: (s) => s.unlockAllObjects() },
  );

  // ---------- Transform ----------
  out.push(
    { id: 'tool.move', title: 'Move Tool', group: 'Transform', icon: '↔', keys: 'W', run: (s) => s.setTransformMode('translate') },
    { id: 'tool.rotate', title: 'Rotate Tool', group: 'Transform', icon: '🔄', keys: 'E', run: (s) => s.setTransformMode('rotate') },
    { id: 'tool.scale', title: 'Scale Tool', group: 'Transform', icon: '📐', keys: 'R', run: (s) => s.setTransformMode('scale') },
    {
      id: 'transform.space',
      title: 'Toggle Local / World Space',
      group: 'Transform',
      icon: '🌐',
      keys: 'X',
      run: (s) => {
        s.setGizmoSpace(s.gizmoSpace.get() === 'world' ? 'local' : 'world');
        toast(`Gizmo space: ${s.gizmoSpace.get()}`, 'info');
      },
    },
    {
      id: 'transform.snap',
      title: 'Toggle Snapping',
      group: 'Transform',
      icon: '🧲',
      keys: 'Shift+S',
      run: (s) => {
        s.setSnapSettings({ enabled: !s.snapSettings.get().enabled });
        toast(`Snapping ${s.snapSettings.get().enabled ? 'on' : 'off'}`, 'info');
      },
    },
    {
      id: 'transform.snapObjects',
      title: 'Toggle Snap to Objects',
      group: 'Transform',
      icon: '📌',
      run: (s) => {
        s.setSnapSettings({ toObjects: !s.snapSettings.get().toObjects });
        toast(`Snap to objects ${s.snapSettings.get().toObjects ? 'on' : 'off'}`, 'info');
      },
    },
    { id: 'transform.snapToGrid', title: 'Snap Selection to Grid', group: 'Transform', icon: '#', run: (s) => s.snapSelectionToGrid() },
    { id: 'transform.duplicate', title: 'Duplicate Selection', group: 'Transform', icon: '⧉', keys: 'Ctrl+D', run: (s) => { s.duplicateSelection(); } },
    { id: 'transform.delete', title: 'Delete Selection', group: 'Transform', icon: '🗑', keys: 'Del', run: (s) => s.deleteSelection() },
    { id: 'transform.reset', title: 'Reset Transform', group: 'Transform', icon: '↺', keys: 'Alt+R', run: (s) => s.resetTransform('all') },
    { id: 'transform.resetPosition', title: 'Reset Position', group: 'Transform', icon: '↺', run: (s) => s.resetTransform('position') },
    { id: 'transform.resetRotation', title: 'Reset Rotation', group: 'Transform', icon: '↺', run: (s) => s.resetTransform('rotation') },
    { id: 'transform.resetScale', title: 'Reset Scale', group: 'Transform', icon: '↺', run: (s) => s.resetTransform('scale') },
    { id: 'transform.applyAll', title: 'Apply All Transforms', group: 'Transform', icon: '✅', keys: 'Ctrl+Shift+A', run: (s) => s.applyTransforms('all') },
    { id: 'transform.applyRotationScale', title: 'Apply Rotation & Scale', group: 'Transform', icon: '✅', run: (s) => s.applyTransforms('rotationScale') },
    { id: 'transform.mirrorX', title: 'Mirror Selection on X', group: 'Transform', icon: '🪞', run: (s) => s.mirrorSelection('x') },
    { id: 'transform.mirrorY', title: 'Mirror Selection on Y', group: 'Transform', icon: '🪞', run: (s) => s.mirrorSelection('y') },
    { id: 'transform.mirrorZ', title: 'Mirror Selection on Z', group: 'Transform', icon: '🪞', run: (s) => s.mirrorSelection('z') },
    { id: 'transform.dropToGround', title: 'Drop Selection to Ground', group: 'Transform', icon: '⬇', run: (s) => s.dropToGround() },
    { id: 'transform.copyXf', title: 'Copy Transform', group: 'Transform', icon: '📋', run: (s) => s.copyTransform() },
    { id: 'transform.pasteXf', title: 'Paste Transform', group: 'Transform', icon: '📄', run: (s) => s.pasteTransform() },
    { id: 'transform.pivotCenter', title: 'Pivot: Bounds Centre', group: 'Transform', icon: '⊕', run: (s) => s.setPivotPreset('center') },
    { id: 'transform.pivotBase', title: 'Pivot: Bottom', group: 'Transform', icon: '⊕', run: (s) => s.setPivotPreset('base') },
    { id: 'transform.pivotTop', title: 'Pivot: Top', group: 'Transform', icon: '⊕', run: (s) => s.setPivotPreset('top') },
    { id: 'transform.pivotOrigin', title: 'Pivot: Object Origin', group: 'Transform', icon: '⊕', run: (s) => s.setPivotPreset('origin') },
    {
      id: 'transform.editPivot',
      title: 'Edit Pivot (drag the origin)',
      group: 'Transform',
      icon: '✥',
      run: (s) => s.setTransformTarget(s.transformTarget.get() === 'pivot' ? 'object' : 'pivot'),
    },
    { id: 'transform.pivotMode', title: 'Cycle Multi-select Pivot Mode', group: 'Transform', icon: '⚓', run: (s) => {
      const order = ['origin', 'median', 'bounds'] as const;
      const next = order[(order.indexOf(s.pivotMode.get()) + 1) % order.length];
      s.setPivotMode(next);
      toast(`Pivot mode: ${next}`, 'info');
    } },
  );

  // ---------- View ----------
  out.push(
    { id: 'view.frame', title: 'Frame Selected', group: 'View', icon: '🎯', keys: 'F', run: (s) => s.frameSelection() },
    { id: 'view.frameAll', title: 'Frame All', group: 'View', icon: '⛶', keys: 'Shift+F', run: (s) => { s.select(null); s.viewport.focusIds(null); } },
    { id: 'view.focus', title: 'Focus Selected (keep distance)', group: 'View', icon: '🔍', run: (s) => s.focusSelected() },
    {
      id: 'view.camera',
      title: 'Toggle Perspective / Orthographic',
      group: 'View',
      icon: '📷',
      keys: 'Numpad 5',
      run: (s) => s.cameraType.set(s.cameraType.get() === 'perspective' ? 'orthographic' : 'perspective'),
    },
    {
      id: 'view.wireframe',
      title: 'Toggle Wireframe',
      group: 'View',
      icon: '🕸',
      keys: 'Z',
      run: (s) => s.shadingMode.set(s.shadingMode.get() === 'wireframe' ? 'material' : 'wireframe'),
    },
    { id: 'view.grid', title: 'Toggle Grid', group: 'View', icon: '▦', keys: 'Shift+G', run: (s) => s.toggleGrid() },
    {
      id: 'view.firstPerson',
      title: 'First-person Camera (WASD)',
      group: 'View',
      icon: '🚶',
      run: (s) => s.toggleFirstPerson(),
    },
  );
  for (const v of VIEWS) {
    out.push({
      id: `view.${v.id}`,
      title: v.label,
      group: 'View',
      icon: '🧭',
      keys: v.keys,
      run: (s) => {
        s.viewport.setView(v.az, v.pol);
        s.persistCamera();
      },
    });
  }
  out.push(
    {
      id: 'view.bookmarkAdd',
      title: 'Save Camera Bookmark',
      group: 'View',
      icon: '🔖',
      run: (s) => {
        const name = window.prompt('Bookmark name', `View ${s.doc.cameraBookmarks.length + 1}`);
        s.addCameraBookmark(name ?? undefined);
        toast('Camera bookmark saved', 'success');
      },
    },
  );

  // ---------- Animation ----------
  out.push(
    { id: 'anim.play', title: 'Play / Pause', group: 'Animation', icon: '▶', keys: 'Space', run: () => getCommandHost()?.togglePlay() },
    { id: 'anim.stop', title: 'Stop Playback', group: 'Animation', icon: '⏹', run: (s) => s.stop() },
    { id: 'anim.keyAll', title: 'Add Keyframe (all channels)', group: 'Animation', icon: '◉', keys: 'K', run: (s) => s.addKeyframeAll() },
    { id: 'anim.keyPos', title: 'Keyframe Position', group: 'Animation', icon: '◉', run: (s) => s.addKeyframeSelected('position') },
    { id: 'anim.keyRot', title: 'Keyframe Rotation', group: 'Animation', icon: '◉', run: (s) => s.addKeyframeSelected('rotation') },
    { id: 'anim.keyScale', title: 'Keyframe Scale', group: 'Animation', icon: '◉', run: (s) => s.addKeyframeSelected('scale') },
    { id: 'anim.keyDelete', title: 'Delete Keyframes at Playhead', group: 'Animation', icon: '✖', run: (s) => { s.deleteKeyframesAtPlayhead(); } },
    { id: 'anim.autoKey', title: 'Toggle Auto-key (record)', group: 'Animation', icon: '⏺', run: (s) => s.autoKey.set(!s.autoKey.get()) },
    { id: 'anim.loop', title: 'Toggle Loop Playback', group: 'Animation', icon: '🔁', run: (s) => s.loop.set(!s.loop.get()) },
    { id: 'anim.newClip', title: 'New Animation Clip', group: 'Animation', icon: '➕', run: (s) => s.addClip() },
    { id: 'anim.prevKey', title: 'Go to Previous Keyframe', group: 'Animation', icon: '⏮', keys: ',', run: (s) => s.gotoPrevKey() },
    { id: 'anim.nextKey', title: 'Go to Next Keyframe', group: 'Animation', icon: '⏭', keys: '.', run: (s) => s.gotoNextKey() },
    { id: 'anim.copyKeys', title: 'Copy Keyframes', group: 'Animation', icon: '📋', run: (s) => { s.copyKeyframes(); } },
    { id: 'anim.pasteKeys', title: 'Paste Keyframes', group: 'Animation', icon: '📄', run: (s) => { s.pasteKeyframes(); } },
    { id: 'anim.bake', title: 'Bake Animation to New Clip (sample every frame)', group: 'Animation', icon: '🍞', run: (s) => { void s.bakeClip(); } },
  );

  // ---------- Material ----------
  out.push({ id: 'material.new', title: 'New Material', group: 'Material', icon: '🎨', run: (s) => {
    const m = s.addMaterial(`Material ${s.doc.materials.length + 1}`);
    const sel = s.selectedObjects();
    for (const o of sel) s.assignMaterial(o.id, m.id);
    toast('Material created', 'success');
  } });
  for (const p of PRESETS) {
    out.push({
      id: `material.preset.${p.id}`,
      title: `Material: ${p.label}`,
      group: 'Material',
      icon: p.icon,
      run: (s) => { s.applyMaterialPresetToSelection(p.id); },
    });
  }
  out.push(
    { id: 'material.assetBrowser', title: 'Open Asset Library', group: 'Material', icon: '📚', run: () => { getCommandHost()?.togglePanel('assets'); } },
    { id: 'material.uploadTexture', title: 'Upload Texture…', group: 'Material', icon: '🖼', run: (s) => void s.uploadTextureForSelection() },
    { id: 'material.generateTexture', title: 'Generate AI Texture…', group: 'Material', icon: '✨', run: (s) => void s.generateTextureForSelection() },
  );

  // ---------- AI ----------
  out.push(
    {
      id: 'ai.studio',
      title: 'AI Studio',
      group: 'AI',
      icon: '✨',
      keys: 'A',
      run: (s) => void openAiStudio(s),
    },
    {
      id: 'ai.scripts',
      title: 'Scripts',
      group: 'AI',
      icon: '{ }',
      keys: 'J',
      run: (s) => void openScripts(s),
    },
    { id: 'ai.scene', title: 'Build Scene from Text…', group: 'AI', icon: '🏗', run: (s) => void openScenePrompt(s) },
    { id: 'ai.style', title: 'Restyle Scene…', group: 'AI', icon: '🎭', run: (s) => void openStylePrompt(s) },
    { id: 'ai.optimize', title: 'Optimize Scene (AI suggestions)', group: 'AI', icon: '⚡', run: (s) => void s.optimizeScene() },
  );

  // ---------- Project ----------
  out.push(
    { id: 'project.save', title: 'Save Project', group: 'Project', icon: '💾', keys: 'Ctrl+S', run: (s) => void s.forceSave().then(() => toast('Saved', 'success')) },
    { id: 'project.exportGlb', title: 'Export GLB', group: 'Project', icon: '📤', run: (s) => void s.exportGlb() },
    { id: 'project.exportObj', title: 'Export OBJ', group: 'Project', icon: '📤', run: (s) => void s.exportObj() },
    { id: 'project.exportPng', title: 'Render PNG Image', group: 'Project', icon: '🖼', run: (s) => void s.exportPng() },
    { id: 'project.exportWeb', title: 'Export Web Scene (single HTML file)', group: 'Project', icon: '🌐', run: (s) => void s.exportWebScene() },
    { id: 'project.exportModal', title: 'Export / Download…', group: 'Project', icon: '📦', run: (s) => openExportModal(s) },
    { id: 'project.backup', title: 'Download Backup (.3dproject)', group: 'Project', icon: '🗄', run: (s) => void s.exportProjectBackup() },
    { id: 'project.importBackup', title: 'Import Backup…', group: 'Project', icon: '📥', run: () => getCommandHost()?.openImportBackup() },
    { id: 'project.versions', title: 'Version History', group: 'Project', icon: '🕘', run: (s) => openVersionsModal(s) },
    { id: 'project.members', title: 'Members & Invites', group: 'Project', icon: '👥', run: (s) => openMembersModal(s) },
    { id: 'project.share', title: 'Share Project…', group: 'Project', icon: '🔗', run: (s) => openShareModal(s) },
    { id: 'project.shortcuts', title: 'Keyboard Shortcuts', group: 'Project', icon: '⌨', keys: '?', run: () => openShortcutsModal() },
  );

  // ---------- Interface ----------
  out.push(
    { id: 'ui.outliner', title: 'Toggle Outliner', group: 'Interface', icon: '🗂', run: () => getCommandHost()?.togglePanel('outliner') },
    { id: 'ui.inspector', title: 'Toggle Inspector', group: 'Interface', icon: '🔍', run: () => getCommandHost()?.togglePanel('inspector') },
    { id: 'ui.timeline', title: 'Toggle Timeline', group: 'Interface', icon: '🎞', run: () => getCommandHost()?.togglePanel('timeline') },
    { id: 'ui.rail', title: 'Toggle Tool Rail', group: 'Interface', icon: '🧰', run: () => getCommandHost()?.togglePanel('rail') },
    { id: 'ui.assets', title: 'Toggle Asset Library', group: 'Interface', icon: '📚', run: () => getCommandHost()?.togglePanel('assets') },
    { id: 'ui.animation', title: 'Toggle Dope Sheet', group: 'Interface', icon: '📈', run: () => getCommandHost()?.togglePanel('animation') },
    { id: 'ui.presence', title: 'Toggle People Panel', group: 'Interface', icon: '👥', run: () => getCommandHost()?.togglePanel('presence') },
    { id: 'ui.resetLayout', title: 'Reset Panel Layout', group: 'Interface', icon: '↺', run: () => getCommandHost()?.resetLayout() },
    { id: 'ui.undo', title: 'Undo', group: 'Interface', icon: '↩', keys: 'Ctrl+Z', when: (s) => !!s?.history.canUndo(), run: (s) => s.undo() },
    { id: 'ui.redo', title: 'Redo', group: 'Interface', icon: '↪', keys: 'Ctrl+Shift+Z', when: (s) => !!s?.history.canRedo(), run: (s) => s.redo() },
    {
      id: 'ui.undoMine',
      title: 'Undo My Last Change',
      group: 'Interface',
      icon: '↩',
      keywords: 'per user collaboration history mine',
      when: (s) => !!s?.history.canUndo(),
      run: (s) => s.undoMine(),
    },
    {
      id: 'ui.redoMine',
      title: 'Redo My Last Change',
      group: 'Interface',
      icon: '↪',
      keywords: 'per user collaboration history mine',
      when: (s) => !!s?.history.canRedo(),
      run: (s) => s.redoMine(),
    },
    {
      id: 'ui.undoForce',
      title: 'Undo Anyway (also revert collaborators)',
      group: 'Interface',
      icon: '⚠',
      keywords: 'force undo peers conflict',
      when: (s) => !!s?.history.canUndo() && !!s?.peerEdits.get(),
      run: (s) => s.undoMine(true),
    },
    { id: 'ui.play', title: 'Play Mode', group: 'Interface', icon: '▶', keys: 'P', run: () => {
      const h = getCommandHost();
      if (!h) return;
      if (h.isPlayMode()) h.exitPlayMode();
      else h.enterPlayMode();
    } },
  );

  return out;
}

let cache: Command[] | null = null;

export function allCommands(): Command[] {
  if (!cache) cache = buildCommands();
  return cache;
}

export function findCommand(id: string): Command | null {
  return allCommands().find((c) => c.id === id) ?? null;
}

export async function runCommand(id: string, session: EditorSession | null): Promise<boolean> {
  const cmd = findCommand(id);
  if (!cmd) return false;
  const s = requireSession(session);
  if (!s && cmd.id !== 'project.shortcuts') return false;
  try {
    await cmd.run(s as EditorSession);
    return true;
  } catch (e) {
    toast(`${cmd.title} failed: ${(e as Error).message}`, 'warn');
    return false;
  }
}

// ---------- fuzzy matching used by the palette ----------

export interface CommandMatch {
  cmd: Command;
  score: number;
}

/** Subsequence match with word-boundary and prefix bonuses. */
export function scoreCommand(cmd: Command, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const haystack = `${cmd.title} ${cmd.group} ${cmd.keywords ?? ''}`.toLowerCase();
  if (haystack.startsWith(q)) return 1000;
  const title = cmd.title.toLowerCase();
  if (title.startsWith(q)) return 900;
  if (title.includes(q)) return 700 - title.indexOf(q);
  // subsequence
  let i = 0;
  let score = 0;
  let last = -2;
  for (const ch of q) {
    const at = haystack.indexOf(ch, i);
    if (at < 0) return 0;
    if (at === last + 1) score += 3;
    if (at === 0 || /[\s.\-+_]/.test(haystack[at - 1] ?? '')) score += 4;
    score += 1;
    last = at;
    i = at + 1;
  }
  return score;
}

export function searchCommands(query: string, session: EditorSession | null, limit = 40): CommandMatch[] {
  return allCommands()
    .filter((c) => (c.when ? c.when(session) : true))
    .map((cmd) => ({ cmd, score: scoreCommand(cmd, query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------- helpers that need late imports ----------

async function importModel(s: EditorSession): Promise<void> {
  const { pickFiles } = await import('../lib/utils.js');
  const files = await pickFiles('.glb,.gltf,model/gltf-binary');
  for (const f of files) {
    toast(`Importing ${f.name}…`);
    await s.importGlbFile(f);
  }
}

// AI studio, the script editor and the scene dialogs are heavy: keep them out
// of the first paint by loading them on demand (mobile-first budget).
async function openAiStudio(s: EditorSession): Promise<void> {
  const { openAiPanel } = await import('./ai-panel.js');
  openAiPanel(s);
}

async function openScripts(s: EditorSession): Promise<void> {
  const { openScriptPanel } = await import('./script-panel.js');
  openScriptPanel(s);
}

async function openScenePrompt(s: EditorSession): Promise<void> {
  const { promptSceneDescription } = await import('./ai-scene-ui.js');
  await promptSceneDescription(s);
}

async function openStylePrompt(s: EditorSession): Promise<void> {
  const { promptSceneStyle } = await import('./ai-scene-ui.js');
  await promptSceneStyle(s);
}
