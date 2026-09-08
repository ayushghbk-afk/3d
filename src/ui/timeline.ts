import type { EditorSession } from '../editor/session.js';
import { activeClip, describeClip } from '../editor/animation.js';
import type { AnimTrack } from '../state/models.js';
import { escapeHtml } from '../lib/utils.js';

const PROP_COLORS: Record<AnimTrack['property'], string> = {
  position: '#4ade80',
  rotation: '#60a5fa',
  scale: '#f472b6',
};

export function buildTimeline(s: EditorSession, el: HTMLElement, togglePlay: () => void): () => void {
  let collapsed = window.innerWidth < 720;

  function render(): void {
    const clip = activeClip(s.doc);
    const st = s.anim.get();
    if (!clip) {
      el.innerHTML = '<div class="tl-empty">No animation clips</div>';
      return;
    }
    el.innerHTML = `
      <div class="tl-bar">
        <button class="btn btn-icon btn-sm" data-tl="collapse" aria-label="Toggle timeline">${collapsed ? '▴' : '▾'}</button>
        <select id="tl-clip" class="input input-sm" aria-label="Clip">
          ${s.doc.clips.map((c) => `<option value="${c.id}"${c.id === clip.id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <button class="btn btn-sm" data-tl="addclip" title="New clip">New clip</button>
        <button class="btn btn-sm" data-tl="stop" title="Stop playback">⏹ Stop</button>
        <button class="btn btn-sm" data-tl="play" title="Play/Pause (Space)">${st.playing ? '⏸ Pause' : '▶ Play'}</button>
        <button class="btn btn-sm ${s.autoKey.get() ? 'rec-on' : ''}" data-tl="rec" title="Auto-key (record): transform edits write keyframes">⏺ Auto-key</button>
        <button class="btn btn-sm" data-tl="prevkey" title="Previous keyframe">Prev key</button>
        <button class="btn btn-sm" data-tl="nextkey" title="Next keyframe">Next key</button>
        <span class="tl-frame" title="Current frame">${st.frame} / ${clip.length}</span>
        <label class="tl-num">fps <input id="tl-fps" class="input input-sm" type="number" min="1" max="120" value="${clip.fps}" /></label>
        <label class="tl-num">len <input id="tl-len" class="input input-sm" type="number" min="1" max="2000" value="${clip.length}" /></label>
        <span class="spacer"></span>
        <span class="tl-hint muted">${escapeHtml(describeClip(clip))}</span>
        <button class="btn btn-sm" data-tl="key-all" title="Keyframe all (selected)">Key all</button>
        <button class="btn btn-sm" data-tl="key" title="Keyframe position (selected)">Key pos</button>
        <button class="btn btn-sm" data-tl="keyr" title="Keyframe rotation (selected)">Key rot</button>
        <button class="btn btn-sm" data-tl="keys" title="Keyframe scale (selected)">Key scale</button>
        <button class="btn btn-sm" data-tl="interp" title="Toggle linear/step at playhead">${s.interpAtPlayhead() === 'step' ? 'Interpolation: Step' : s.interpAtPlayhead() === 'linear' ? 'Interpolation: Linear' : 'Interpolation'}</button>
        <button class="btn btn-sm" data-tl="keydel" title="Delete keyframe at playhead">Delete key</button>
      </div>
      <div class="tl-ruler-wrap" style="display:${collapsed ? 'none' : 'block'}">
        <canvas id="tl-ruler" class="tl-ruler"></canvas>
      </div>`;

    (el.querySelector('#tl-clip') as HTMLSelectElement).onchange = (e) => s.setActiveClip((e.target as HTMLSelectElement).value);
    (el.querySelector('#tl-fps') as HTMLInputElement).onchange = (e) => {
      const len = (el.querySelector('#tl-len') as HTMLInputElement).value;
      s.setClipProps(parseInt((e.target as HTMLInputElement).value) || 30, parseInt(len) || 90);
    };
    (el.querySelector('#tl-len') as HTMLInputElement).onchange = (e) => {
      const fps = (el.querySelector('#tl-fps') as HTMLInputElement).value;
      s.setClipProps(parseInt(fps) || 30, parseInt((e.target as HTMLInputElement).value) || 90);
    };
    const acts: Record<string, () => void> = {
      collapse: () => {
        collapsed = !collapsed;
        render();
      },
      stop: () => s.playback.stop(),
      play: () => togglePlay(),
      rec: () => {
        s.autoKey.set(!s.autoKey.get());
        render();
      },
      prevkey: () => s.gotoPrevKey(),
      nextkey: () => s.gotoNextKey(),
      interp: () => s.toggleInterpAtPlayhead(),
      addclip: () => {
        const v = prompt('Clip name', `Clip ${s.doc.clips.length + 1}`);
        s.addClip(v?.trim() || undefined);
      },
      'key-all': () => s.addKeyframeAll(),
      key: () => s.addKeyframeSelected('position'),
      keyr: () => s.addKeyframeSelected('rotation'),
      keys: () => s.addKeyframeSelected('scale'),
      keydel: () => {
        (['position', 'rotation', 'scale'] as AnimTrack['property'][]).forEach((p) => s.deleteKeyframeSelected(p));
      },
    };
    el.querySelectorAll('[data-tl]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => acts[(b as HTMLElement).dataset.tl as string]?.();
    });

    if (!collapsed) {
      const canvas = el.querySelector('#tl-ruler') as HTMLCanvasElement;
      drawRuler(s, canvas, clip.length, st.frame);
    }
  }

  const u1 = s.rev.subscribe(() => {
    if (document.activeElement?.tagName !== 'INPUT' || !(el.contains(document.activeElement))) render();
    else {
      const canvas = el.querySelector('#tl-ruler') as HTMLCanvasElement | null;
      const clip = activeClip(s.doc);
      if (canvas && clip) drawRuler(s, canvas, clip.length, s.anim.get().frame);
    }
  });
  const u2 = s.anim.subscribe((st) => {
    const frameEl = el.querySelector('.tl-frame');
    const clip = activeClip(s.doc);
    if (frameEl && clip) frameEl.textContent = `${st.frame} / ${clip.length}`;
    const playBtn = el.querySelector('[data-tl="play"]');
    if (playBtn) playBtn.textContent = st.playing ? '⏸ Pause' : '▶ Play';
    const interpBtn = el.querySelector('[data-tl="interp"]');
    if (interpBtn) {
      const v = s.interpAtPlayhead();
      interpBtn.textContent = v === 'step' ? 'Interpolation: Step' : v === 'linear' ? 'Interpolation: Linear' : 'Interpolation';
    }
    const canvas = el.querySelector('#tl-ruler') as HTMLCanvasElement | null;
    if (canvas && clip) drawRuler(s, canvas, clip.length, st.frame);
  });
  const u3 = s.selection.subscribe(() => render());
  window.addEventListener('resize', render);
  render();
  return () => {
    u1();
    u2();
    u3();
    window.removeEventListener('resize', render);
  };
}

function drawRuler(s: EditorSession, canvas: HTMLCanvasElement, length: number, frame: number): void {
  const wrap = canvas.parentElement as HTMLElement;
  const w = Math.max(50, wrap.clientWidth);
  const h = 56;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pad = 8;
  const x = (f: number) => pad + (f / Math.max(1, length)) * (w - pad * 2);

  // bg + ticks
  ctx.fillStyle = '#141923';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8b93a7';
  ctx.font = '10px system-ui';
  ctx.strokeStyle = '#2a3346';
  const step = Math.max(1, Math.round(length / Math.max(1, Math.floor(w / 60))));
  for (let f = 0; f <= length; f += step) {
    ctx.beginPath();
    ctx.moveTo(x(f), 14);
    ctx.lineTo(x(f), 24);
    ctx.stroke();
    ctx.fillText(String(f), x(f) - 6, 12);
  }

  // keyframes of selected object (all props)
  const sel = s.selectedObject();
  const clip = activeClip(s.doc);
  if (sel && clip) {
    for (const track of clip.tracks) {
      if (track.objectId !== sel.id) continue;
      ctx.fillStyle = PROP_COLORS[track.property];
      const y = track.property === 'position' ? 34 : track.property === 'rotation' ? 43 : 52;
      for (const k of track.keyframes) {
        const kx = x(k.frame);
        ctx.beginPath();
        ctx.moveTo(kx, y - 4);
        ctx.lineTo(kx + 4, y);
        ctx.lineTo(kx, y + 4);
        ctx.lineTo(kx - 4, y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // playhead
  ctx.strokeStyle = '#f43f5e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(frame), 0);
  ctx.lineTo(x(frame), h);
  ctx.stroke();

  // scrub interaction
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const f = Math.round(((ev.clientX - rect.left - pad) / (rect.width - pad * 2)) * length);
      s.playback.setFrame(Math.max(0, Math.min(length, f)));
    };
    move(e);
    const up = () => {
      canvas.onpointermove = null;
      canvas.onpointerup = null;
    };
    canvas.onpointermove = move;
    canvas.onpointerup = up;
  };
}
