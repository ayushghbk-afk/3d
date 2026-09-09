import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  PollinationsChatProvider,
  buildPollinationsImageUrl,
  flattenMessages,
  texturePrompt,
  unreachableChatError,
} from '../../src/ai/pollinations.js';
import { parseSseChunk } from '../../src/ai/providers.js';
import { buildSpaceArgs, findGenerateFnIndex, isGlb, makeFileData, parseUploadPaths } from '../../src/ai/triposr.js';
import { findSf3dDeps, parseRunButtonValue } from '../../src/ai/sf3d.js';
import { scanOutputsForFile } from '../../src/ai/gradio.js';
import { planProcedural } from '../../src/ai/procedural.js';
import { defaultSettings, normalizeSettings } from '../../src/ai/settings.js';
import { GROQ_DEFAULT_MODEL, GROQ_PROXY_URL, GroqProxyChatProvider, groqChatUrls, parseGroqReply } from '../../src/ai/groq.js';
import { getChatProvider } from '../../src/ai/factory.js';

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

  it('builds queue args from the Space config (image + resolution + defaults)', () => {
    const file = makeFileData('/tmp/x/input.png', 'input.png', 10, 'image/png');
    expect(file.url).toBe('/gradio_api/file=/tmp/x/input.png');
    expect(file.meta).toEqual({ _type: 'gradio.FileData' });
    const cfg = {
      components: [
        { id: 1, type: 'image' },
        { id: 2, type: 'slider', props: { label: 'Marching Cubes Resolution', value: 256 } },
        { id: 3, type: 'checkbox', props: { label: 'Fancy', value: true } },
        { id: 4, type: 'model3d' },
      ],
      dependencies: [{ id: 7, inputs: [1, 2, 3], outputs: [4] }],
    };
    expect(buildSpaceArgs(cfg, 7, file, 192)).toEqual([file, 192, true]);
  });

  it('rejects arg-building when the image slot disappears', () => {
    const file = makeFileData('/tmp/x.png', 'x.png', 1, 'image/png');
    const cfg = {
      components: [{ id: 2, type: 'slider' }],
      dependencies: [{ id: 7, inputs: [2], outputs: [] }],
    };
    expect(() => buildSpaceArgs(cfg, 7, file, 192)).toThrow(/no image slot/);
  });

  it('parses both upload response shapes', () => {
    expect(parseUploadPaths(['/tmp/a.png', 42])).toEqual(['/tmp/a.png']);
    expect(parseUploadPaths({ files: [{ path: '/tmp/b.png' }, '/tmp/c.png'] })).toEqual(['/tmp/b.png', '/tmp/c.png']);
    expect(parseUploadPaths({})).toEqual([]);
    expect(parseUploadPaths(null)).toEqual([]);
  });
});

describe('sf3d flow discovery', () => {
  const config = {
    components: [
      { id: 1, type: 'image' },
      { id: 3, type: 'slider', props: { label: 'Foreground Ratio', value: 0.85 } },
      { id: 4, type: 'radio', props: { value: 'None' } },
      { id: 7, type: 'button', props: { value: 'Run' } },
      { id: 8, type: 'state' },
      { id: 9, type: 'state' },
      { id: 10, type: 'litmodel3d' },
      { id: 11, type: 'column' },
    ],
    dependencies: [
      { id: 20, inputs: [1, 3], outputs: [7, 8, 9, 10, 11] },
      { id: 21, inputs: [7, 1, 9, 3, 4, 3, 3], outputs: [7, 8, 9, 10, 11] },
      { id: 22, inputs: [8, 3], outputs: [9] }, // foreground slider change — not the flow
    ],
  };

  it('finds the background-check and run actions', () => {
    expect(findSf3dDeps(config)).toEqual({ requiresFn: 20, runFn: 21 });
  });

  it('throws when the flow is missing', () => {
    expect(() => findSf3dDeps({ components: [], dependencies: [] })).toThrow(/changed its UI/);
  });
});

describe('sf3d button parsing', () => {
  it('reads raw and gr.update shapes, defaulting to background removal', () => {
    expect(parseRunButtonValue('Run')).toBe('Run');
    expect(parseRunButtonValue({ value: 'Run', visible: true })).toBe('Run');
    expect(parseRunButtonValue({ value: 'Remove Background' })).toBe('Remove Background');
    expect(parseRunButtonValue(null)).toBe('Remove Background');
    expect(parseRunButtonValue({ unexpected: 1 })).toBe('Remove Background');
  });
});

describe('gradio output scanning', () => {
  it('finds nested model files, preferring the wanted extension', () => {
    const outputs = [
      { value: 'Run' },
      { value: { url: '/gradio_api/file=/tmp/x/model.glb', orig_name: 'model.glb' } },
    ];
    expect(scanOutputsForFile(outputs, '.glb')?.orig_name).toBe('model.glb');
    expect(scanOutputsForFile([{ value: 'Run' }], '.glb')).toBeNull();
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
    expect(d.assistantProvider).toBe('groq');
    expect(d.groqProxyUrl).toContain('groq-proxy.mr-hackerdon808.workers.dev');
    expect(d.groqModel).toBe('llama-3.3-70b-versatile');
    expect(d.imageProvider).toBe('pollinations');
    expect(d.meshProvider).toBe('sf3d');
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

describe('pollinations chat chain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const chatJson = (content: string) => Response.json({ choices: [{ message: { content } }] });

  it('uses the keyed gen API first when a key is configured', async () => {
    const fetchMock = vi.fn(async () => chatJson('keyed answer'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await new PollinationsChatProvider(undefined, 'sk_test').chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(out).toBe('keyed answer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gen.pollinations.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
    expect(String((init as { body: string }).body)).toContain('"model":"openai"');
  });

  it('falls back from a dead POST to the legacy anonymous GET', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('fallback answer', { status: 200 })),
    );
    const out = await new PollinationsChatProvider().chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('fallback answer');
  });

  it('falls back when POST returns an HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('busy', { status: 500 }))
        .mockResolvedValueOnce(new Response('get answer', { status: 200 })),
    );
    const out = await new PollinationsChatProvider().chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('get answer');
  });

  it('tries the gen host anonymously before giving an actionable error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(new PollinationsChatProvider().chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /Couldn't reach the free Pollinations assistant/,
    );
    // legacy POST → legacy GET → gen GET, each naming its failure
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2] as [string])[0]).toContain('https://gen.pollinations.ai/text/');
    try {
      await new PollinationsChatProvider().chat([{ role: 'user', content: 'hi' }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('Setup');
      expect((e as Error).message).toContain('text.pollinations.ai GET');
    }
  });

  it('explains HTTP 402 as anonymous access ended, pointing at the free key', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('pay up', { status: 402 }))
        .mockResolvedValueOnce(new Response('pay up', { status: 402 }))
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })),
    );
    try {
      await new PollinationsChatProvider().chat([{ role: 'user', content: 'hi' }]);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('ended anonymous access');
      expect(msg).toContain('enter.pollinations.ai/keys');
      expect(msg).toContain('Setup');
      expect(msg).not.toContain('ad-blocker');
    }
  });

  it('tells keyed users when their own budget is exhausted (402)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('exhausted', { status: 402 })));
    // Keyed POST 402s; the anonymous fallbacks 402/401 too.
    await expect(new PollinationsChatProvider(undefined, 'sk_test').chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /out of budget/,
    );
  });

  it('reports offline browsers distinctly', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(unreachableChatError(['a: b']).message).toContain('offline');
    vi.stubGlobal('navigator', { onLine: true });
    expect(unreachableChatError(['a: b']).message).toContain("Couldn't reach");
  });

  it('flattens conversations with a length cap', () => {
    const flat = flattenMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(flat).toBe('System: sys\nUser: hello');
    expect(flattenMessages([{ role: 'user', content: 'x'.repeat(99999) }]).length).toBeLessThanOrEqual(4000);
  });

  it('appends the user key to image URLs when set', () => {
    expect(buildPollinationsImageUrl('cat', { key: 'sk_test' })).toContain('key=sk_test');
    expect(buildPollinationsImageUrl('cat', {})).not.toContain('key=');
  });
});

describe('Groq proxy assistant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts OpenAI chat completions to the proxy and parses the reply', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '  hello from llama  ' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = await new GroqProxyChatProvider().chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('hello from llama');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GROQ_PROXY_URL}/`);
    expect((init as { method?: string }).method).toBe('POST');
    const body = JSON.parse(String((init as { body: string }).body)) as { model: string };
    expect(body.model).toBe(GROQ_DEFAULT_MODEL);
  });

  it('skips the health payload and tries the next path', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, service: 'groq-proxy', message: 'Worker is online. Use POST for AI requests.' }))
        .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'ok' } }] })),
    );
    const out = await new GroqProxyChatProvider().chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('ok');
  });

  it('lists chat URLs and ignores health JSON', () => {
    expect(groqChatUrls(GROQ_PROXY_URL)[0]).toBe(`${GROQ_PROXY_URL}/`);
    expect(parseGroqReply({ ok: true, service: 'groq-proxy' })).toBeNull();
    expect(parseGroqReply({ choices: [{ message: { content: 'x' } }] })).toBe('x');
  });

  it('is the default chat provider', () => {
    expect(getChatProvider(defaultSettings()).id).toBe('groq-proxy');
  });
});
