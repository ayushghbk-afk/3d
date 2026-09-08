import { describe, it, expect } from 'vitest';
import { buildPollinationsImageUrl, texturePrompt } from '../../src/ai/pollinations.js';
import { parseSseChunk } from '../../src/ai/providers.js';
import { findGenerateFnIndex, isGlb } from '../../src/ai/triposr.js';
import { planProcedural } from '../../src/ai/procedural.js';
import { defaultSettings, normalizeSettings } from '../../src/ai/settings.js';

describe('pollinations URL builder', () => {
  it('encodes the prompt and defaults sensibly', () => {
    const url = buildPollinationsImageUrl('red cube & sphere', { seed: 42 });
    expect(url).toContain('https://image.pollinations.ai/prompt/red%20cube%20%26%20sphere');
    expect(url).toContain('width=512');
    expect(url).toContain('height=512');
    expect(url).toContain('model=flux');
    expect(url).toContain('seed=42');
    expect(url).toContain('nologo=true');
  });

  it('clamps dimensions and honors overrides', () => {
    const url = buildPollinationsImageUrl('x', { width: 99999, height: 1, model: 'turbo', nologo: false, referrer: 'app.test' });
    expect(url).toContain('width=2048');
    expect(url).toContain('height=64');
    expect(url).toContain('model=turbo');
    expect(url).toContain('nologo=false');
    expect(url).toContain('referrer=app.test');
  });
});

describe('texture prompts', () => {
  it('adds a seamless suffix when asked', () => {
    expect(texturePrompt('rusty metal', true)).toContain('seamless tileable texture');
    expect(texturePrompt('rusty metal', false)).not.toContain('seamless');
    expect(texturePrompt('rusty metal', false)).toContain('rusty metal');
  });
});

describe('SSE parsing', () => {
  it('splits events and keeps the partial tail', () => {
    const { events, rest } = parseSseChunk('event: estimation\ndata: {"rank":2}\n\nevent: process_generating\ndata: {}\n\npartial');
    expect(events).toEqual([
      { event: 'estimation', data: '{"rank":2}' },
      { event: 'process_generating', data: '{}' },
    ]);
    expect(rest).toBe('partial');
  });
});

describe('triposr config discovery', () => {
  const config = {
    components: [
      { id: 1, type: 'image' },
      { id: 2, type: 'slider' },
      { id: 3, type: 'image' },
      { id: 4, type: 'model3d' },
      { id: 5, type: 'model3d' },
    ],
    dependencies: [
      { id: 0, inputs: [1], outputs: [3] },
      { id: 3, inputs: [1, 2], outputs: [3, 4, 5] },
    ],
  };

  it('finds the image→3D dependency', () => {
    expect(findGenerateFnIndex(config)).toBe(3);
  });

  it('throws a helpful error when the Space UI changed', () => {
    expect(() => findGenerateFnIndex({ components: [], dependencies: [] })).toThrow(/changed its UI/);
  });
});

describe('GLB magic check', () => {
  it('accepts glTF binaries and rejects the rest', () => {
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0, 0, 0, 0, 0]).buffer as ArrayBuffer;
    expect(isGlb(glb)).toBe(true);
    expect(isGlb(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)).toBe(false);
    expect(isGlb(new ArrayBuffer(0))).toBe(false);
  });
});

describe('procedural plans', () => {
  it('matches keyword templates', () => {
    const chair = planProcedural('a wooden chair');
    expect(chair.parts.length).toBeGreaterThanOrEqual(5);
    expect(chair.parts[0].kind).toBe('cube');
    const rocket = planProcedural('rocket ship');
    expect(rocket.parts.some((p) => p.name === 'Nose')).toBe(true);
  });

  it('falls back to a deterministic abstraction', () => {
    const a = planProcedural('something indescribable xyz');
    const b = planProcedural('something indescribable xyz');
    expect(a.template).toBe('abstract');
    expect(a.parts).toEqual(b.parts);
    expect(a.parts.length).toBeGreaterThanOrEqual(4);
  });
});

describe('AI settings', () => {
  it('defaults to free providers with the agent disabled', () => {
    const d = defaultSettings();
    expect(d.assistantProvider).toBe('pollinations');
    expect(d.imageProvider).toBe('pollinations');
    expect(d.meshProvider).toBe('triposr');
    expect(d.agent.enabled).toBe(false);
    expect(d.agent.tokens).toEqual([]);
  });

  it('survives corrupt stored JSON', () => {
    expect(normalizeSettings(null).agent.enabled).toBe(false);
    expect(normalizeSettings('nope').imageProvider).toBe('pollinations');
    const merged = normalizeSettings({ agent: { enabled: true, tokens: [{ id: 't', secretHash: 'h' }], relayUrl: 'http://x/' } });
    expect(merged.agent.enabled).toBe(true);
    expect(merged.agent.tokens).toHaveLength(1);
    expect(merged.agent.relayUrl).toBe('http://x');
    expect(merged.meshCustom.spaceUrl).toContain('hf.space');
  });
});
