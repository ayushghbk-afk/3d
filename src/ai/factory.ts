// Provider wiring: reads AiSettings and returns the configured providers with
// graceful fallbacks (custom → free → offline). Used by the Agent API and UI.
import type { AiSettings } from './settings.js';
import { aiSettings } from './settings.js';
import type { ImageGenOptions, MeshGenOptions } from './types.js';
import type { ChatProvider, ImageProvider, MeshProvider } from './providers.js';
import { PollinationsChatProvider, PollinationsImageProvider } from './pollinations.js';
import { CustomChatProvider, CustomImageProvider, CustomMeshProvider } from './custom.js';
import { TripoSRMeshProvider } from './triposr.js';
import { Sf3dMeshProvider } from './sf3d.js';
import { ProceduralImageProvider, planProcedural, type ProcPart } from './procedural.js';

export type FreeMeshModel = 'sf3d' | 'triposr';

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

function freeMeshProvider(model: FreeMeshModel, s: AiSettings, images: ImageProvider): MeshProvider {
  return model === 'triposr'
    ? new TripoSRMeshProvider({ spaceUrl: s.meshCustom.spaceUrl, hfToken: s.hfToken, imageProvider: images })
    : new Sf3dMeshProvider({ spaceUrl: s.sf3dSpaceUrl, hfToken: s.hfToken, imageProvider: images });
}

export function getMeshProvider(
  s: AiSettings = aiSettings.get(),
  images?: ImageProvider,
  modelOverride?: FreeMeshModel,
): MeshProvider {
  const imgs = images ?? getImageProvider(s);
  if (!modelOverride && s.meshProvider === 'custom' && s.meshCustom.baseUrl) {
    return new CustomMeshProvider(s.meshCustom);
  }
  const model = modelOverride ?? (s.meshProvider === 'custom' ? 'sf3d' : s.meshProvider);
  return freeMeshProvider(model, s, imgs);
}

/** Ordered 3D chain: configured provider → the other free model. */
export function meshProviderChain(
  s: AiSettings = aiSettings.get(),
  modelOverride?: FreeMeshModel,
): MeshProvider[] {
  const images = getImageProvider(s);
  if (!modelOverride && s.meshProvider === 'custom' && s.meshCustom.baseUrl) {
    return [new CustomMeshProvider(s.meshCustom), freeMeshProvider('sf3d', s, images), freeMeshProvider('triposr', s, images)];
  }
  const first = modelOverride ?? (s.meshProvider === 'custom' ? 'sf3d' : s.meshProvider);
  const second: FreeMeshModel = first === 'sf3d' ? 'triposr' : 'sf3d';
  return [freeMeshProvider(first, s, images), freeMeshProvider(second, s, images)];
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

/** 3D chain: configured model → other free model → offline plan (unless strict). */
export async function generateMeshSmart(
  prompt: string,
  opts: MeshGenOptions & { strict?: boolean; model?: FreeMeshModel } = {},
  s: AiSettings = aiSettings.get(),
): Promise<SmartMeshOutcome> {
  const chain = meshProviderChain(s, opts.model);
  const primary = chain[0];
  let firstError: Error | null = null;
  const attempts = opts.strict ? chain.slice(0, 1) : chain;
  for (const provider of attempts) {
    try {
      const result = await provider.textTo3D(prompt, opts);
      return {
        kind: 'glb',
        result,
        fallback: provider === primary
          ? null
          : { from: primary.label, to: provider.label, reason: (firstError as Error).message },
      };
    } catch (e) {
      if (!firstError) firstError = e as Error;
      if (opts.strict) throw e;
    }
  }
  if (opts.strict) throw firstError ?? new Error('3D generation failed.');
  const { template, parts } = planProcedural(prompt);
  return {
    kind: 'plan',
    parts,
    template,
    prompt,
    fallback: {
      from: primary.label,
      to: 'Offline primitives (no AI)',
      reason: (firstError as Error).message,
    },
  };
}
