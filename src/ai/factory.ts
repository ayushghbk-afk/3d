// Provider wiring: reads AiSettings and returns the configured providers with
// graceful fallbacks (custom → free → offline). Used by the Agent API and UI.
import type { AiSettings } from './settings.js';
import { aiSettings } from './settings.js';
import type { ImageGenOptions, MeshGenOptions } from './types.js';
import type { ChatProvider, ImageProvider, MeshProvider } from './providers.js';
import { PollinationsChatProvider, PollinationsImageProvider } from './pollinations.js';
import { CustomChatProvider, CustomImageProvider, CustomMeshProvider } from './custom.js';
import { TripoSRMeshProvider } from './triposr.js';
import { ProceduralImageProvider, planProcedural, type ProcPart } from './procedural.js';

export function getChatProvider(s: AiSettings = aiSettings.get()): ChatProvider {
  if (s.assistantProvider === 'custom' && s.assistantCustom.baseUrl) {
    return new CustomChatProvider(s.assistantCustom);
  }
  return new PollinationsChatProvider();
}

export function getImageProvider(s: AiSettings = aiSettings.get()): ImageProvider {
  if (s.imageProvider === 'custom' && s.imageCustom.baseUrl) {
    return new CustomImageProvider(s.imageCustom);
  }
  return new PollinationsImageProvider();
}

export function getMeshProvider(s: AiSettings = aiSettings.get(), images?: ImageProvider): MeshProvider {
  if (s.meshProvider === 'custom' && s.meshCustom.baseUrl) {
    return new CustomMeshProvider(s.meshCustom);
  }
  return new TripoSRMeshProvider({
    spaceUrl: s.meshCustom.spaceUrl,
    hfToken: s.hfToken,
    imageProvider: images ?? getImageProvider(s),
  });
}

export interface FallbackInfo {
  from: string;
  to: string;
  reason: string;
}

export interface SmartImageOutcome {
  result: import('./types.js').ImageGenResult;
  fallback: FallbackInfo | null;
}

/** Configured image provider → offline canvas pattern (unless strict). */
export async function generateImageSmart(
  prompt: string,
  opts: ImageGenOptions & { strict?: boolean } = {},
  s: AiSettings = aiSettings.get(),
): Promise<SmartImageOutcome> {
  const primary = getImageProvider(s);
  try {
    const result = await primary.generateImage(prompt, opts);
    return { result, fallback: null };
  } catch (e) {
    if (opts.strict) throw e;
    if (typeof document === 'undefined') throw e;
    const fallback = new ProceduralImageProvider();
    const result = await fallback.generateImage(prompt, opts);
    return {
      result,
      fallback: {
        from: primary.label,
        to: fallback.label,
        reason: (e as Error).message,
      },
    };
  }
}

export type SmartMeshOutcome =
  | { kind: 'glb'; result: import('./types.js').MeshGenResult; fallback: FallbackInfo | null }
  | { kind: 'plan'; parts: ProcPart[]; template: string; prompt: string; fallback: FallbackInfo | null };

/** Configured 3D provider → offline primitive plan (unless strict). */
export async function generateMeshSmart(
  prompt: string,
  opts: MeshGenOptions & { strict?: boolean } = {},
  s: AiSettings = aiSettings.get(),
): Promise<SmartMeshOutcome> {
  const primary = getMeshProvider(s);
  try {
    const result = await primary.textTo3D(prompt, opts);
    return { kind: 'glb', result, fallback: null };
  } catch (e) {
    if (opts.strict) throw e;
    const { template, parts } = planProcedural(prompt);
    return {
      kind: 'plan',
      parts,
      template,
      prompt,
      fallback: {
        from: primary.label,
        to: 'Offline primitives (no AI)',
        reason: (e as Error).message,
      },
    };
  }
}
