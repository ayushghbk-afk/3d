/**
 * Procedural textures for the built-in asset library — canvas-generated, so
 * the browser ships with usable maps instead of downloading a texture pack.
 */

export type ProceduralTextureId = 'checker' | 'grid' | 'noise' | 'wood' | 'marble' | 'brick' | 'gradient' | 'dots';

export interface ProceduralTextureInfo {
  id: ProceduralTextureId;
  label: string;
  /** Good defaults for map slots. */
  slot: 'base' | 'normal' | 'ao';
}

export const PROCEDURAL_TEXTURES: ProceduralTextureInfo[] = [
  { id: 'checker', label: 'Checker', slot: 'base' },
  { id: 'grid', label: 'Grid', slot: 'base' },
  { id: 'noise', label: 'Noise', slot: 'base' },
  { id: 'wood', label: 'Wood', slot: 'base' },
  { id: 'marble', label: 'Marble', slot: 'base' },
  { id: 'brick', label: 'Bricks', slot: 'base' },
  { id: 'gradient', label: 'Gradient', slot: 'base' },
  { id: 'dots', label: 'Dots', slot: 'base' },
];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function paint(ctx: CanvasRenderingContext2D, size: number, id: ProceduralTextureId, base = '#c9d2e0', accent = '#5b8cff'): void {
  const hex = (h: string): Rgb => {
    const v = h.replace('#', '');
    const n = parseInt(v.length === 3 ? v.split('').map((c) => c + c).join('') : v, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const a = hex(accent);
  const b = hex(base);
  const img = ctx.createImageData(size, size);
  const data = img.data;

  // deterministic value noise
  const hash = (x: number, y: number): number => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const smoothNoise = (x: number, y: number, scale: number): number => {
    const sx = x / scale;
    const sy = y / scale;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    const n00 = hash(x0, y0);
    const n10 = hash(x0 + 1, y0);
    const n01 = hash(x0, y0 + 1);
    const n11 = hash(x0 + 1, y0 + 1);
    const ix0 = n00 + (n10 - n00) * fx;
    const ix1 = n01 + (n11 - n01) * fx;
    return ix0 + (ix1 - ix0) * fy;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let t = 0;
      let col: Rgb = b;
      switch (id) {
        case 'checker': {
          const cells = 8;
          t = (Math.floor(x / (size / cells)) + Math.floor(y / (size / cells))) % 2 === 0 ? 1 : 0;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'grid': {
          const step = size / 8;
          const on = x % step < 2 || y % step < 2;
          t = on ? 1 : 0;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'noise': {
          t = smoothNoise(x, y, size / 24);
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'wood': {
          const rings = Math.sin((x + smoothNoise(x, y, size / 8) * 26) * 0.06) * 0.5 + 0.5;
          t = rings * 0.8 + smoothNoise(x, y, size / 48) * 0.2;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'marble': {
          const v = Math.sin((x + y) * 0.02 + smoothNoise(x, y, size / 6) * 6);
          t = v * 0.5 + 0.5;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'brick': {
          const rows = 10;
          const rowH = size / rows;
          const row = Math.floor(y / rowH);
          const offset = (row % 2) * (size / 8);
          const brickW = size / 4;
          const inMortar = y % rowH < 3 || (x + offset) % brickW < 3;
          t = inMortar ? 0 : 0.85 + smoothNoise(x, y, size / 32) * 0.15;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'gradient': {
          t = y / size;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
        case 'dots': {
          const step = size / 10;
          const cx = (x % step) - step / 2;
          const cy = (y % step) - step / 2;
          t = Math.hypot(cx, cy) < step / 4 ? 1 : 0;
          col = { r: b.r + (a.r - b.r) * t, g: b.g + (a.g - b.g) * t, b: b.b + (a.b - b.b) * t };
          break;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = Math.max(0, Math.min(255, col.r));
      data[i + 1] = Math.max(0, Math.min(255, col.g));
      data[i + 2] = Math.max(0, Math.min(255, col.b));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Render a procedural texture to a PNG blob (seamless-ish, powers of two). */
export function proceduralTextureBlob(
  id: ProceduralTextureId,
  size = 512,
  colors: { base?: string; accent?: string; slot?: 'base' | 'normal' | 'ao' } = {},
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas unavailable'));
  const slot = colors.slot ?? 'base';
  const base = slot === 'normal' ? '#8080ff' : slot === 'ao' ? '#ffffff' : colors.base ?? '#c9d2e0';
  const accent = slot === 'normal' ? '#8080ff' : slot === 'ao' ? '#9a9a9a' : colors.accent ?? '#5b8cff';
  paint(ctx, size, id, base, accent);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Texture generation failed'))), 'image/png');
  });
}

/** Small preview data URL for the asset browser tiles. */
export function proceduralTexturePreview(id: ProceduralTextureId, size = 64): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  paint(ctx, size, id);
  return canvas.toDataURL('image/png');
}
