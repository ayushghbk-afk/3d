import type { EditorSession } from '../editor/session.js';
import { activeClip } from '../editor/animation.js';
import type { AnimTrack, KeyInterp } from '../state/models.js';
import { escapeHtml } from '../lib/utils.js';
import { toast } from './toast.js';

/**
 * Dope sheet + graph editor.
 *
 * Left column: one row per animated object, one per track.
 * Right canvas: keyframe diamonds (dope sheet) or value curves (graph editor).
 * Drag keys to retime, double-click to cycle easing, drag the ruler to scrub.
 */

type Mode = 'dope' | 'graph';

const PROP_COLORS: Record<AnimTrack['property'], string> = {
  position: '#4ade80',
  rotation: '#60a5fa',
  scale: '#f472b6',
};
const COMP_COLORS = ['#f87171', '#4ade80', '#60a5fa'];
const ROW_H = 22;
const HEADER_H = 26;

interface KeyRef {
  objectId: string;
  property: AnimTrack['property'];
  frame: number;
}

const keyId = (k: KeyRef): string => `${k.objectId}|${k.property}|${k.frame}`;

export function buildDopeSheet(s: EditorSession, el: HTMLElement, togglePlay: () => void): () => void {
  let mode: Mode = 'dope';
  let selected = new Set<string>();
  let dragFrom: number | null = null;
  let dragKeys: KeyRef[] = [];
  let graphTrack: { objectId: string; property: AnimTrack['property'] } | null = null;
  let canvas: HTMLCanvasElement | null = null;

  function render(): void {
    const clip = activeClip(s.doc);
    if (!clip) {
      el.innerHTML = '<div class="tl-empty">No clips — create one to animate.</div>';
      return;
    }
    const st = s.anim.get();
    const groups = s.dopeSheet();
    el.innerHTML = `
      <div class="ds-bar">
        <button class="btn btn-icon btn-sm" data-ds="mode" title="Dope sheet / graph editor">${mode === 'dope' ? '📊' : '📈'}</button>
        <select id="ds-clip" class="input input-sm" aria-label="Clip">
          ${s.doc.clips.map((c) => `<option value="${c.id}"${c.id === clip.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-ds="addclip">＋ clip</button>
        <button class="btn btn-sm" data-ds="stop">⏹</button>
        <button class="btn btn-sm${s.loop.get() ? ' active' : ''}" data-ds="loop">🔁</button>
        <button class="btn btn-sm" data-ds="play">${st.playing ? '⏸' : '▶'}</button>
        <button class="btn btn-sm ${s.autoKey.get() ? 'rec-on' : ''}" data-ds="rec">⏺</button>
        <span class="tl-frame">${st.frame} / ${clip.length}</span>
        <label class="tl-num">fps <input id="ds-fps" class="input input-sm" type="number" min="1" max="120" value="${clip.fps}" /></label>
        <label class="tl-num">len <input id="ds-len" class="input input-sm" type="number" min="1" max="2000" value="${clip.length}" /></label>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-ds="keyall">Key all</button>
        <button class="btn btn-sm" data-ds="copy">Copy keys</button>
        <button class="btn btn-sm" data-ds="paste">Paste keys</button>
        <button class="btn btn-sm" data-ds="del">Delete keys</button>
        <button class="btn btn-sm" data-ds="bake">Bake</button>
      </div>
      <div class="ds-body">
        <div class="ds-rows" style="padding-top:${HEADER_H}px">
          ${groups.length ? '' : '<p class="muted small ds-empty">Select an object and press “Key all”.</p>'}
          ${groups
            .map(
              (g) => `
            <div class="ds-obj${s.selection.has(g.objectId) ? ' sel' : ''}" data-obj="${g.objectId}" title="${escapeHtml(g.name)}">🟦 ${escapeHtml(g.name)}</div>
            ${g.tracks
              .map(
                (t) => `<div class="ds-track${graphTrack && graphTrack.objectId === t.objectId && graphTrack.property === t.property ? ' sel' : ''}"
                    data-track="${t.objectId}|${t.property}" style="--c:${PROP_COLORS[t.property]}">
                    <span class="ds-dot"></span>${t.property}<span class="muted small"> ${t.keyframes.length}</span>
                  </div>`,
              )
              .join('')}`,
            )
            .join('')}
        </div>
        <div class="ds-canvas-wrap"><canvas id="ds-canvas" class="ds-canvas"></canvas></div>
      </div>`;

    const clipSel = el.querySelector('#ds-clip') as HTMLSelectElement | null;
    if (clipSel) clipSel.onchange = () => s.setActiveClip(clipSel.value);
    const fpsInput = el.querySelector('#ds-fps') as HTMLInputElement | null;
    if (fpsInput) {
      fpsInput.onchange = () => {
        const len = (el.querySelector('#ds-len') as HTMLInputElement)?.value;
        s.setClipProps(parseInt(fpsInput.value) || 30, parseInt(len ?? '90') || 90);
      };
    }
    const lenInput = el.querySelector('#ds-len') as HTMLInputElement | null;
    if (lenInput) {
      lenInput.onchange = () => {
        const fps = (el.querySelector('#ds-fps') as HTMLInputElement)?.value;
        s.setClipProps(parseInt(fps ?? '30') || 30, parseInt(lenInput.value) || 90);
      };
    }

    const acts: Record<string, () => void> = {
      mode: () => {
        mode = mode === 'dope' ? 'graph' : 'dope';
        render();
      },
      stop: () => s.stop(),
      loop: () => s.loop.set(!s.loop.get()),
      play: () => togglePlay(),
      rec: () => s.autoKey.set(!s.autoKey.get()),
      addclip: () => {
        const v = window.prompt('Clip name', `Clip ${s.doc.clips.length + 1}`);
        s.addClip(v?.trim() || undefined);
      },
      keyall: () => s.addKeyframeAll(),
      copy: () => {
        const refs = [...selected].map((id) => {
          const [objectId, property, frame] = id.split('|');
          return { objectId, property: property as AnimTrack['property'], frame: Number(frame) };
        });
        const n = s.copyKeyframes(refs.length ? refs : undefined);
        if (n) toast(`${n} keyframes copied`, 'success');
      },
      paste: () => {
        const n = s.pasteKeyframes();
        if (n) toast(`${n} keyframes pasted`, 'success');
      },
      del: () => {
        const refs = [...selected].map((id) => {
          const [objectId, property, frame] = id.split('|');
          return { objectId, property: property as AnimTrack['property'], frame: Number(frame) };
        });
        const n = s.deleteSelectedKeys(refs);
        selected.clear();
        if (n) toast(`${n} keyframes deleted`, 'info');
      },
      bake: () => void s.bakeClip(1),
    };
    el.querySelectorAll('[data-ds]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.ds as string]?.();
    });
    el.querySelectorAll('[data-obj]').forEach((row) => {
      (row as HTMLElement).onclick = () => s.select((row as HTMLElement).dataset.obj as string);
    });
    el.querySelectorAll('[data-track]').forEach((row) => {
      (row as HTMLElement).onclick = () => {
        const [objectId, property] = ((row as HTMLElement).dataset.track as string).split('|');
        graphTrack = { objectId, property: property as AnimTrack['property'] };
        s.select(objectId);
        render();
      };
    });

    canvas = el.querySelector('#ds-canvas') as HTMLCanvasElement | null;
    if (canvas) {
      draw();
      attachCanvas();
    }
  }

  function rowsFor(): { objectId: string; property: AnimTrack['property']; index: number }[] {
    const clip = activeClip(s.doc);
    if (!clip) return [];
    const out: { objectId: string; property: AnimTrack['property']; index: number }[] = [];
    let index = 0;
    for (const g of s.dopeSheet()) {
      index++; // object row
      for (const t of g.tracks) {
        out.push({ objectId: g.objectId, property: t.property, index });
        index++;
      }
    }
    return out;
  }

  function draw(): void {
    const c = canvas;
    if (!c) return;
    const wrap = c.parentElement as HTMLElement;
    const w = Math.max(120, wrap.clientWidth);
    const h = Math.max(120, wrap.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const clip = activeClip(s.doc);
    if (!clip) return;
    const st = s.anim.get();
    const length = clip.length;
    const padL = 10;
    const x = (f: number): number => padL + (f / Math.max(1, length)) * (w - padL * 2);

    // background + ruler
    ctx.fillStyle = '#12161f';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8b93a7';
    ctx.font = '10px system-ui';
    ctx.strokeStyle = '#242c3c';
    const step = Math.max(1, Math.round(length / Math.max(1, Math.floor(w / 70))));
    ctx.fillStyle = '#8b93a7';
    for (let f = 0; f <= length; f += step) {
      ctx.beginPath();
      ctx.moveTo(x(f), HEADER_H - 8);
      ctx.lineTo(x(f), HEADER_H - 1);
      ctx.stroke();
      ctx.fillText(String(f), x(f) - 6, HEADER_H - 12);
    }
    ctx.strokeStyle = '#1d2431';
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H);
    ctx.lineTo(w, HEADER_H);
    ctx.stroke();

    if (mode === 'dope') {
      const rows = rowsFor();
      const scrollTop = (el.querySelector('.ds-rows') as HTMLElement)?.scrollTop ?? 0;
      for (const row of rows) {
        const y = HEADER_H + row.index * ROW_H + ROW_H / 2 - scrollTop;
        if (y < HEADER_H - 4 || y > h + 8) continue;
        const track = clip.tracks.find((t) => t.objectId === row.objectId && t.property === row.property);
        if (!track) continue;
        ctx.fillStyle = PROP_COLORS[row.property];
        for (const k of track.keyframes) {
          const kx = x(k.frame);
          const on = selected.has(keyId({ objectId: row.objectId, property: row.property, frame: k.frame }));
          drawDiamond(ctx, kx, y, 5, on);
        }
      }
    } else {
      drawGraph(ctx, w, h, padL, x);
    }

    // playhead
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(st.frame), 0);
    ctx.lineTo(x(st.frame), h);
    ctx.stroke();
  }

  function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, filled: boolean): void {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    if (filled) {
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fill();
    }
  }

  function drawGraph(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    padL: number,
    x: (f: number) => number,
  ): void {
    const clip = activeClip(s.doc);
    const track = graphTrack
      ? clip?.tracks.find((t) => t.objectId === graphTrack?.objectId && t.property === graphTrack?.property)
      : (clip?.tracks[0] ?? null);
    if (!track || !clip) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '12px system-ui';
      ctx.fillText('Pick a track on the left to edit its curves.', padL + 8, HEADER_H + 40);
      return;
    }
    const top = HEADER_H + 8;
    const bottom = h - 8;
    const values = track.keyframes.flatMap((k) => k.value);
    const min = Math.min(...values, -1);
    const max = Math.max(...values, 1);
    const span = Math.max(0.5, max - min);
    const y = (v: number): number => bottom - ((v - min) / span) * (bottom - top);

    // zero line
    ctx.strokeStyle = '#242c3c';
    ctx.beginPath();
    ctx.moveTo(0, y(0));
    ctx.lineTo(w, y(0));
    ctx.stroke();

    for (let c = 0; c < 3; c++) {
      ctx.strokeStyle = COMP_COLORS[c];
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let f = 0; f <= clip.length; f++) {
        const sampled = sample(track, f);
        const px = x(f);
        const py = y(sampled[c]);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      // handles
      for (const k of track.keyframes) {
        const on = selected.has(keyId({ objectId: track.objectId, property: track.property, frame: k.frame }));
        ctx.fillStyle = on ? '#ffd166' : COMP_COLORS[c];
        ctx.beginPath();
        ctx.arc(x(k.frame), y(k.value[c]), on ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = '#8b93a7';
    ctx.font = '10px system-ui';
    ctx.fillText(`${track.property} — X red · Y green · Z blue`, padL + 4, top - 2);
  }

  function sample(track: AnimTrack, frame: number): [number, number, number] {
    const ks = track.keyframes;
    if (!ks.length) return [0, 0, 0];
    if (frame <= ks[0].frame) return ks[0].value;
    if (frame >= ks[ks.length - 1].frame) return ks[ks.length - 1].value;
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i];
      const b = ks[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        if (a.interp === 'step' || b.frame === a.frame) return a.value;
        return sampleEased(a.value, b.value, (frame - a.frame) / (b.frame - a.frame), a.interp);
      }
    }
    return ks[ks.length - 1].value;
  }

  function sampleEased(a: [number, number, number], b: [number, number, number], t: number, interp: KeyInterp): [number, number, number] {
    const e = interp === 'ease' ? (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
      : interp === 'easeIn' ? t * t * t
      : interp === 'easeOut' ? 1 - Math.pow(1 - t, 3)
      : t;
    return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
  }

  function attachCanvas(): void {
    const c = canvas;
    if (!c) return;
    const clip = activeClip(s.doc);
    if (!clip) return;
    const length = clip.length;
    const padL = 10;
    const frameAt = (clientX: number): number => {
      const rect = c.getBoundingClientRect();
      return Math.round(((clientX - rect.left - padL) / Math.max(1, rect.width - padL * 2)) * length);
    };
    const rowAt = (clientY: number): { objectId: string; property: AnimTrack['property'] } | null => {
      const rect = c.getBoundingClientRect();
      const scrollTop = (el.querySelector('.ds-rows') as HTMLElement)?.scrollTop ?? 0;
      const localY = clientY - rect.top - HEADER_H + scrollTop;
      const index = Math.floor(localY / ROW_H);
      const row = rowsFor().find((r) => r.index === index);
      return row ? { objectId: row.objectId, property: row.property } : null;
    };

    c.onpointerdown = (e) => {
      const f = frameAt(e.clientX);
      c.setPointerCapture(e.pointerId);
      if (e.clientY - c.getBoundingClientRect().top < HEADER_H) {
        // ruler: scrub
        const move = (ev: PointerEvent): void => s.setFrame(frameAt(ev.clientX));
        move(e);
        c.onpointermove = move;
        c.onpointerup = () => {
          c.onpointermove = null;
          c.onpointerup = null;
        };
        return;
      }
      const row = rowAt(e.clientY);
      if (!row) {
        const move = (ev: PointerEvent): void => s.setFrame(frameAt(ev.clientX));
        move(e);
        c.onpointermove = move;
        c.onpointerup = () => {
          c.onpointermove = null;
          c.onpointerup = null;
        };
        return;
      }
      // hit test a key
      const track = clip.tracks.find((t) => t.objectId === row.objectId && t.property === row.property);
      const near = track?.keyframes.find((k) => Math.abs(k.frame - f) <= 2);
      if (near && track) {
        const ref: KeyRef = { objectId: row.objectId, property: row.property, frame: near.frame };
        if (e.shiftKey) {
          const id = keyId(ref);
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          draw();
          return;
        }
        if (!selected.has(keyId(ref))) {
          selected = new Set([keyId(ref)]);
        }
        dragFrom = near.frame;
        dragKeys = [...selected].map((id) => {
          const [objectId, property, frame] = id.split('|');
          return { objectId, property: property as AnimTrack['property'], frame: Number(frame) };
        });
        s.setFrame(near.frame);
        const move = (ev: PointerEvent): void => {
          const to = frameAt(ev.clientX);
          if (dragFrom === null || to === dragFrom) return;
          const delta = to - dragFrom;
          for (const k of dragKeys) {
            void s.moveKey(k.objectId, k.property, k.frame, Math.max(0, k.frame + delta));
          }
          dragFrom = to;
          dragKeys = dragKeys.map((k) => ({ ...k, frame: Math.max(0, k.frame + delta) }));
          selected = new Set(dragKeys.map(keyId));
          draw();
        };
        c.onpointermove = move;
        c.onpointerup = () => {
          c.onpointermove = null;
          c.onpointerup = null;
          dragFrom = null;
        };
        draw();
        return;
      }
      // empty area: scrub
      selected.clear();
      const move = (ev: PointerEvent): void => s.setFrame(frameAt(ev.clientX));
      move(e);
      c.onpointermove = move;
      c.onpointerup = () => {
        c.onpointermove = null;
        c.onpointerup = null;
      };
      draw();
    };

    c.ondblclick = (e) => {
      const row = rowAt(e.clientY);
      if (!row) return;
      const f = frameAt(e.clientX);
      const track = clip.tracks.find((t) => t.objectId === row.objectId && t.property === row.property);
      const hit = track?.keyframes.find((k) => Math.abs(k.frame - f) <= 2);
      if (!track || !hit) return;
      const next = s.cycleInterpAt(row.objectId, row.property, hit.frame);
      if (next) toast(`Interpolation: ${next}`, 'info');
    };

    // keep the left column and canvas rows aligned while scrolling
    const rowsEl = el.querySelector('.ds-rows') as HTMLElement | null;
    rowsEl?.addEventListener('scroll', draw);
  }

  const u1 = s.rev.subscribe(() => {
    if (canvas) draw();
    else render();
  });
  const u2 = s.anim.subscribe(() => {
    if (canvas) draw();
    const frameEl = el.querySelector('.tl-frame');
    const clip = activeClip(s.doc);
    if (frameEl && clip) frameEl.textContent = `${s.anim.get().frame} / ${clip.length}`;
  });
  const u3 = s.selection.subscribe(() => render());
  window.addEventListener('resize', () => draw());
  render();
  return () => {
    u1();
    u2();
    u3();
    window.removeEventListener('resize', () => draw());
  };
}
