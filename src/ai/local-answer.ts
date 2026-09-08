// Offline scene Q&A: when the free cloud assistant is unreachable (network
// block, outage), still answer factual questions straight from the ProjectDoc.
// Pure + synchronous — used by the Ask tab and the ai.ask agent method as a
// fallback. Returns null when the question needs real AI (caller then shows
// the provider error instead).
import type { MaterialData, ProjectDoc, SceneObjectData } from '../state/models.js';

const MAX_LIST = 15;

function counts(doc: ProjectDoc): { objects: SceneObjectData[]; meshes: SceneObjectData[]; lights: SceneObjectData[]; groups: SceneObjectData[] } {
  const objects = doc.objects ?? [];
  return {
    objects,
    meshes: objects.filter((o) => o.type && o.type !== 'light' && o.type !== 'group'),
    lights: objects.filter((o) => o.type === 'light'),
    groups: objects.filter((o) => o.type === 'group'),
  };
}

function fmtNames(names: string[]): string {
  if (!names.length) return 'none';
  const shown = names.slice(0, MAX_LIST).join(', ');
  return names.length > MAX_LIST ? `${shown} (+${names.length - MAX_LIST} more)` : shown;
}

function fmtVec(v: unknown): string {
  const p = v as { x?: unknown; y?: unknown; z?: unknown } | null | undefined;
  const n = (u: unknown): string => (typeof u === 'number' && Number.isFinite(u) ? String(Math.round(u * 100) / 100) : '?');
  return p && typeof p === 'object' ? `(${n(p.x)}, ${n(p.y)}, ${n(p.z)})` : '(?, ?, ?)';
}

function materialOf(doc: ProjectDoc, o: SceneObjectData): MaterialData | null {
  if (!o.materialId) return null;
  return (doc.materials ?? []).find((m) => m.id === o.materialId) ?? null;
}

function sceneSummary(doc: ProjectDoc): string {
  const c = counts(doc);
  const mats = doc.materials ?? [];
  const clips = doc.clips ?? [];
  const keyframes = clips.reduce((n, cl) => n + (cl.tracks ?? []).reduce((t, tr) => t + (tr.keyframes ?? []).length, 0), 0);
  return (
    `"${doc.name}" has ${c.objects.length} object${c.objects.length === 1 ? '' : 's'}` +
    ` (${c.meshes.length} meshes, ${c.lights.length} lights, ${c.groups.length} groups), ` +
    `${mats.length} material${mats.length === 1 ? '' : 's'}, ${clips.length} clip${clips.length === 1 ? '' : 's'}` +
    ` with ${keyframes} keyframes. Mode: ${doc.mode}, version ${doc.version}.`
  );
}

function findObject(doc: ProjectDoc, q: string): SceneObjectData | null {
  const hay = q.toLowerCase();
  const objs = (doc.objects ?? []).filter((o) => o.name);
  // Prefer exact / longest-name match so "Leg front" beats "Leg".
  const hits = objs
    .filter((o) => hay.includes(o.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  return hits[0] ?? null;
}

/**
 * Answer a factual scene question offline, or null if it needs the cloud AI.
 * Handles counts, lists, summaries, and per-object transform/material lookups.
 */
export function answerLocally(doc: ProjectDoc, question: string): string | null {
  const q = question.toLowerCase().trim();
  if (!q) return null;
  const c = counts(doc);
  const mats = doc.materials ?? [];
  const clips = doc.clips ?? [];

  // --- counts: "how many lights / objects / materials / ..." ---
  if (/how many|count|number of/.test(q)) {
    if (/light|lamp/.test(q)) return `There ${c.lights.length === 1 ? 'is' : 'are'} ${c.lights.length} light${c.lights.length === 1 ? '' : 's'} in "${doc.name}".`;
    if (/material|texture|color/.test(q)) return `There are ${mats.length} materials in "${doc.name}".`;
    if (/group/.test(q)) return `There are ${c.groups.length} groups in "${doc.name}".`;
    if (/clip|animation/.test(q)) return `There are ${clips.length} animation clips in "${doc.name}".`;
    if (/mesh|object|model|part|thing|item/.test(q) || /how many/.test(q)) {
      return `There are ${c.objects.length} objects in "${doc.name}" (${c.meshes.length} meshes, ${c.lights.length} lights, ${c.groups.length} groups).`;
    }
  }

  // --- lists: "list my objects / materials / ..." ---
  if (/^(list|show|name|what are)( the| my| all)?/.test(q) || (/what.*(objects|materials|lights|groups|clips)/.test(q) && /list|all|names|there/.test(q))) {
    if (/material/.test(q)) return `Materials: ${fmtNames(mats.map((m) => m.name))}.`;
    if (/light|lamp/.test(q)) return `Lights: ${fmtNames(c.lights.map((o) => o.name))}.`;
    if (/group/.test(q)) return `Groups: ${fmtNames(c.groups.map((o) => o.name))}.`;
    if (/clip/.test(q)) return `Clips: ${fmtNames(clips.map((cl) => cl.name))}.`;
    if (/object|mesh|model|scene|everything|all/.test(q)) return `Objects: ${fmtNames(c.objects.map((o) => o.name))}.`;
  }

  // --- how-to / creative / advice questions need the real AI ---
  if (/^(how (do|does|can|to|should)|why|write|create|make|design|suggest|improve|help|can you|could you|please)|what (should|would|if)/.test(q)) {
    return null;
  }

  // --- summary: "what's in my scene / summarize / ..." ---
  if (/summar|summary|overview|what('| i)s (in|inside)|contents|describe.*scene|about.*(scene|project)/.test(q)) {
    return sceneSummary(doc);
  }

  // --- per-object lookups: "where is X / position of X / X material" ---
  const target = findObject(doc, q);
  if (target) {
    if (/where|position|location|place|coordinat/.test(q)) {
      return `${target.name} is at position ${fmtVec(target.position)}, rotation ${fmtVec(target.rotation)}, scale ${fmtVec(target.scale)}.`;
    }
    if (/material|color|colour|texture|paint/.test(q)) {
      const m = materialOf(doc, target);
      if (!m) return `${target.name} has no material assigned.`;
      return `${target.name} uses material "${m.name}" (base color ${m.baseColor ?? 'default'}).`;
    }
    if (/visible|hidden|hide|lock/.test(q)) {
      return `${target.name} is ${target.visible === false ? 'hidden' : 'visible'}${target.locked ? ' and locked' : ''}.`;
    }
    if (/what is|tell me about|info|detail/.test(q)) {
      const m = materialOf(doc, target);
      return `${target.name} (${target.type ?? 'object'}) at ${fmtVec(target.position)}${m ? `, material "${m.name}"` : ', no material'}.`;
    }
  }

  return null;
}
