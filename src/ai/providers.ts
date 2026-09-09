// Provider interfaces + shared HTTP helpers. Concrete providers live in
// groq.ts (default Ask), pollinations.ts (free images + chat fallback), triposr.ts (free 3D), custom.ts (user endpoints)
// and procedural.ts (offline fallback).
import type { AgentMessage, ChatOptions, ImageGenOptions, ImageGenResult, MeshGenOptions, MeshGenResult } from './types.js';

export interface ChatProvider {
  id: string;
  label: string;
  free: boolean;
  chat(messages: AgentMessage[], opts?: ChatOptions): Promise<string>;
  test?(): Promise<string>;
}

export interface ImageProvider {
  id: string;
  label: string;
  free: boolean;
  generateImage(prompt: string, opts?: ImageGenOptions): Promise<ImageGenResult>;
  test?(): Promise<string>;
}

export interface MeshProvider {
  id: string;
  label: string;
  free: boolean;
  /** Text prompt → GLB bytes (may chain image→3D internally). */
  textTo3D(prompt: string, opts?: MeshGenOptions): Promise<MeshGenResult>;
  /** Reference/queued image → GLB bytes. */
  imageTo3D?(image: Blob, opts?: MeshGenOptions): Promise<MeshGenResult>;
  test?(): Promise<string>;
}

export class ProviderError extends Error {
  provider: string;
  retryable: boolean;
  constructor(provider: string, message: string, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = retryable;
  }
}

/** fetch with timeout + friendlier network errors. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 60000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`)), timeoutMs);
  // Combine the caller's cancel signal with the timeout: either one aborts.
  const caller = init.signal;
  const onCallerAbort = (): void => ctrl.abort(caller?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const { signal: _dropped, ...rest } = init;
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    return res;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || (e as Error)?.message?.startsWith('Timed out')) throw e;
    throw new ProviderError('network', `Network error calling ${hostOf(url)}: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', onCallerAbort);
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 48);
  }
}

export function randomSeed(): number {
  const c = globalThis.crypto;
  if (c?.getRandomValues) {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] % 1000000;
  }
  return Math.floor(Math.random() * 1000000);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blobToArrayBuffer(blob);
  const bytes = new Uint8Array(buf);
  let b64: string;
  const maybeBuffer = (globalThis as unknown as { Buffer?: { from: (b: Uint8Array) => { toString: (e: string) => string } } }).Buffer;
  if (maybeBuffer) {
    b64 = maybeBuffer.from(bytes).toString('base64');
  } else {
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    b64 = btoa(bin);
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
}

export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  const url = URL.createObjectURL(blob);
  try {
    const res = await fetch(url);
    return await res.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Minimal SSE parser for Gradio queue streams: yields {event, data}. */
export function parseSseChunk(
  text: string,
): { events: { event: string; data: string }[]; rest: string } {
  const events: { event: string; data: string }[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, rest };
}

/** Read an SSE response stream, invoking onEvent until done/aborted. */
export async function readSseStream(
  res: Response,
  onEvent: (event: string, data: string) => boolean | void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) throw new ProviderError('sse', 'Empty stream response', true);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException('Aborted', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const e of events) {
      if (onEvent(e.event, e.data) === true) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  }
  // Flush any trailing event without a blank-line terminator.
  if (buffer.trim()) {
    const { events } = parseSseChunk(`${buffer}\n\n`);
    for (const e of events) onEvent(e.event, e.data);
  }
}
