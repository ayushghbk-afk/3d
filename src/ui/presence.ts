import type { EditorSession } from '../editor/session.js';
import { cloudEnabled } from '../lib/supabase.js';
import { escapeHtml, timeAgo } from '../lib/utils.js';
import { toast } from './toast.js';
import { openMembersModal } from './panels.js';

/**
 * Collaboration 2.0: presence list with live "X is editing Y" indicators,
 * object locks, an activity feed, and live cursors drawn over the viewport.
 */

export function buildPresence(s: EditorSession, el: HTMLElement, opts: { onClose?: () => void } = {}): () => void {
  function render(): void {
    const me = s.user();
    const peers = s.peers.get().filter((p) => p.id !== me.id);
    const locks = s.locks.get();
    const activity = s.doc.activity.slice(0, 30);
    const changes = s.recentChanges(6);
    const canUndo = s.history.canUndo();
    const canRedo = s.history.canRedo();

    el.innerHTML = `
      <div class="panel-title presence-head">
        <span>👥 Online (${peers.length + 1})</span>
        <span class="spacer"></span>
        ${opts.onClose ? '<button class="btn btn-xs" data-pres="close">✕</button>' : ''}
      </div>
      <div class="presence-list">
        <div class="presence-row">
          <span class="peer" style="--c:#4ade80">●</span>
          <span class="presence-name"><strong>${escapeHtml(me.name)}</strong> <span class="muted small">(you)</span></span>
          <span class="spacer"></span>
          <span class="muted small">${s.selection.count()} selected</span>
        </div>
        ${peers.length
          ? peers
              .map((p) => {
                const selecting = s.peerSelections.get().get(p.id);
                const editing = p.editingObjectName ?? (selecting?.ids.length ? `${selecting.ids.length} objects` : null);
                return `
              <div class="presence-row">
                <span class="peer" style="--c:${p.color}">●</span>
                <span class="presence-name">${escapeHtml(p.name)}
                  <span class="muted small">${editing ? `— editing ${escapeHtml(editing)}` : '— browsing'}</span>
                </span>
                <span class="spacer"></span>
                ${selecting?.ids.length ? `<button class="btn btn-xs" data-focus-peer="${p.id}">Focus</button>` : ''}
              </div>`;
              })
              .join('')
          : `<p class="muted small presence-note">${
              cloudEnabled
                ? 'Nobody else is here yet — share the project link to invite someone.'
                : 'Local mode: add Supabase keys in settings to enable real-time collaboration.'
            }</p>`}
      </div>
      ${
        locks.size
          ? `<div class="panel-sub">Editing locks</div>
             <div class="presence-list">
              ${[...locks.entries()]
                .map(([objectId, user]) => {
                  const name = s.doc.objects.find((o) => o.id === objectId)?.name ?? objectId.slice(0, 6);
                  return `<div class="presence-row">
                    <span class="peer" style="--c:${user.color}">🔵</span>
                    <span class="presence-name">${escapeHtml(name)} <span class="muted small">${escapeHtml(user.name)}</span></span>
                  </div>`;
                })
                .join('')}
             </div>`
          : ''
      }
      <div class="panel-sub">Activity</div>
      <div class="activity-list">
        ${activity.length
          ? activity
              .map(
                (a) => `<div class="activity-row">
                  <span class="activity-kind kind-${escapeHtml(a.kind)}">${escapeHtml(a.kind)}</span>
                  <span class="activity-msg">${escapeHtml(a.message)}</span>
                  <span class="spacer"></span>
                  <span class="muted small">${escapeHtml(a.actor)} · ${timeAgo(a.at)}</span>
                </div>`,
              )
              .join('')
          : '<p class="muted small">No activity yet.</p>'}
      </div>
      <div class="panel-sub">Recent changes <span class="muted small">— your undo history</span></div>
      <div class="history-list">
        ${changes.length
          ? changes
              .map(
                (c) => `<div class="history-row">
                  <span class="history-label">${escapeHtml(c.label)}</span>
                  <span class="spacer"></span>
                  <span class="muted small">${escapeHtml(c.author ?? 'you')} · ${timeAgo(new Date(c.at).toISOString())}</span>
                </div>`,
              )
              .join('')
          : '<p class="muted small">No edits in this session yet.</p>'}
      </div>
      <div class="presence-actions">
        <button class="btn btn-sm" data-pres="undo" ${canUndo ? '' : 'disabled'}>↩ Undo mine</button>
        <button class="btn btn-sm" data-pres="redo" ${canRedo ? '' : 'disabled'}>↪ Redo</button>
        ${cloudEnabled ? '<button class="btn btn-sm" data-pres="members">Members & invites</button>' : ''}
        <button class="btn btn-sm" data-pres="invitelink">Copy invite link</button>
      </div>`;

    el.querySelectorAll('[data-focus-peer]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        const id = (b as HTMLElement).dataset.focusPeer as string;
        const sel = s.peerSelections.get().get(id);
        if (sel?.ids.length) s.viewport.focusIds([...sel.ids]);
      };
    });
    el.querySelectorAll('[data-pres]').forEach((b) => {
      const act = (b as HTMLElement).dataset.pres;
      (b as HTMLButtonElement).onclick = () => {
        if (act === 'close') opts.onClose?.();
        else if (act === 'members') openMembersModal(s);
        else if (act === 'undo') s.undoMine();
        else if (act === 'redo') s.redoMine();
        else if (act === 'invitelink') {
          const url = `${location.origin}${location.pathname}#/p/${s.doc.id}`;
          void navigator.clipboard.writeText(url).then(
            () => toast('Invite link copied', 'success'),
            () => toast(url, 'info'),
          );
        }
      };
    });
  }

  const u1 = s.peers.subscribe(render);
  const u2 = s.peerSelections.subscribe(render);
  const u3 = s.locks.subscribe(render);
  const u4 = s.rev.subscribe(render);
  const u5 = s.selection.subscribeIds(() => render());
  render();
  return () => {
    u1();
    u2();
    u3();
    u4();
    u5();
  };
}

/**
 * Live cursors + peer selection labels drawn over the viewport.
 * Cheap: a few absolutely-positioned divs updated on a slow tick.
 */
export function mountPresenceOverlay(s: EditorSession, container: HTMLElement): () => void {
  const layer = document.createElement('div');
  layer.className = 'peer-layer';
  container.appendChild(layer);
  const nodes = new Map<string, HTMLElement>();
  let raf = 0;
  let last = 0;

  const tick = (t: number): void => {
    raf = requestAnimationFrame(tick);
    if (t - last < 60) return; // ~15fps is plenty for cursors
    last = t;
    const rect = container.getBoundingClientRect();
    const seen = new Set<string>();

    for (const [id, cursor] of s.peerCursors.get()) {
      if (Date.now() - cursor.at > 12000) continue; // stale
      seen.add(id);
      let node = nodes.get(`c:${id}`);
      if (!node) {
        node = document.createElement('div');
        node.className = 'peer-cursor';
        nodes.set(`c:${id}`, node);
        layer.appendChild(node);
      }
      node.style.setProperty('--c', cursor.color);
      node.style.left = `${rect.width * ((cursor.x + 1) / 2)}px`;
      node.style.top = `${rect.height * ((1 - cursor.y) / 2)}px`;
      node.textContent = cursor.name;
    }

    for (const [id, sel] of s.peerSelections.get()) {
      if (!sel.ids.length) continue;
      seen.add(`s:${id}`);
      let node = nodes.get(`s:${id}`);
      if (!node) {
        node = document.createElement('div');
        node.className = 'peer-select-label';
        nodes.set(`s:${id}`, node);
        layer.appendChild(node);
      }
      node.style.setProperty('--c', sel.color);
      const pos = s.viewport.screenPositionOf(sel.ids[0]);
      if (!pos || pos.behind) {
        node.style.display = 'none';
        continue;
      }
      node.style.display = 'block';
      node.style.left = `${pos.x - rect.left}px`;
      node.style.top = `${pos.y - rect.top}px`;
      node.textContent = `${sel.name} • ${sel.ids.length} selected`;
    }

    for (const [key, node] of nodes) {
      if (!seen.has(key)) {
        node.remove();
        nodes.delete(key);
      }
    }
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    layer.remove();
    nodes.clear();
  };
}

/** Broadcast our own pointer position (throttled by the caller). */
let lastCursorSend = 0;
export function broadcastCursor(s: EditorSession, x: number, y: number): void {
  const now = Date.now();
  if (now - lastCursorSend < 90) return;
  lastCursorSend = now;
  s.sync.broadcastCursor(x, y);
}
