import type { EditorSession } from '../editor/session.js';
import { cloudEnabled } from '../lib/supabase.js';
import { toast } from './toast.js';
import { openModal, closeModal } from './modals.js';
import { escapeHtml } from '../lib/utils.js';

/** Export / download hub — every format the studio can write. */
export function openExportModal(s: EditorSession): void {
  const body = document.createElement('div');
  body.className = 'menu-list';
  const rows: { icon: string; title: string; hint: string; run: () => void | Promise<void> }[] = [
    { icon: '📦', title: 'GLB / glTF', hint: 'Meshes, materials and animation clips', run: () => void s.exportGlb() },
    { icon: '🧱', title: 'OBJ', hint: 'Plain geometry, no materials', run: () => void s.exportObj() },
    { icon: '🖼', title: 'PNG render', hint: 'Current camera at 1920×1080', run: () => void s.exportPng(1920, 1080) },
    { icon: '🌐', title: 'Playable web game', hint: 'One HTML file with ▶ Play, WASD/touch controls and physics', run: () => void s.exportWebScene() },
    { icon: '🗄', title: 'Backup (.3dproject)', hint: 'Full project, re-importable', run: () => void s.exportProjectBackup() },
    { icon: '📥', title: 'Import backup…', hint: 'Restore a .3dproject file', run: () => void s.importProjectBackupFile() },
  ];
  body.innerHTML = rows
    .map(
      (r) => `<button class="btn btn-block menu-item export-row" data-export="${escapeHtml(r.title)}">
        <span class="export-icon">${r.icon}</span>
        <span class="export-text"><strong>${escapeHtml(r.title)}</strong><span class="muted small">${escapeHtml(r.hint)}</span></span>
      </button>`,
    )
    .join('');
  openModal({ title: 'Export', body, actions: [{ label: 'Close', kind: 'ghost' }] });
  body.querySelectorAll('[data-export]').forEach((btn) => {
    (btn as HTMLButtonElement).onclick = () => {
      const row = rows.find((r) => r.title === (btn as HTMLElement).dataset.export);
      closeModal();
      void row?.run();
    };
  });
}

export type ShareRole = 'view' | 'edit' | 'comment' | 'public';

/** Share / publish: link roles (view, comment, edit, public). */
export function openShareModal(s: EditorSession): void {
  const body = document.createElement('div');
  const url = `${location.origin}${location.pathname}#/p/${s.doc.id}`;
  body.innerHTML = `
    <p class="muted small">Anyone with the link and the right role can open this project.</p>
    <label class="field">Share link
      <input id="share-url" class="input" value="${escapeHtml(url)}" readonly />
    </label>
    <div class="prop-actions">
      <button class="btn btn-sm" data-share="copy">Copy link</button>
      <button class="btn btn-sm" data-share="copy-ai">Copy link for AI</button>
    </div>
    <div class="panel-sub">Access</div>
    <div class="share-roles">
      ${(
        [
          ['view', 'View only', 'Open and look around — no edits'],
          ['comment', 'Can comment', 'View plus comments on the activity feed'],
          ['edit', 'Can edit', 'Full editing rights'],
          ['public', 'Public', 'Anyone with the link (read-only)'],
        ] as [ShareRole, string, string][]
      )
        .map(
          ([role, label, hint]) => `
        <label class="share-role">
          <input type="radio" name="share-role" value="${role}"${role === 'view' ? ' checked' : ''} />
          <span><strong>${label}</strong><span class="muted small">${hint}</span></span>
        </label>`,
        )
        .join('')}
    </div>
    <p class="muted small">${
      cloudEnabled
        ? 'Roles apply to invited members (People → Members & invites).'
        : 'Cloud sync is off, so links only open projects stored in this browser.'
    }</p>`;
  openModal({
    title: 'Share project',
    body,
    actions: [
      { label: 'Close', kind: 'ghost' },
      {
        label: 'Apply role',
        kind: 'primary',
        onClick: () => {
          const role = (body.querySelector('input[name="share-role"]:checked') as HTMLInputElement | null)?.value as ShareRole | undefined;
          const map: Record<ShareRole, string> = {
            view: 'viewer',
            comment: 'commenter',
            edit: 'editor',
            public: 'viewer',
          };
          toast(role ? `Default role for new invites: ${map[role]}` : 'Pick a role', 'info');
        },
      },
    ],
  });
  (body.querySelector('[data-share="copy"]') as HTMLButtonElement).onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied', 'success');
    } catch {
      (body.querySelector('#share-url') as HTMLInputElement).select();
      toast('Press Ctrl+C to copy', 'info');
    }
  };
  (body.querySelector('[data-share="copy-ai"]') as HTMLButtonElement).onclick = async () => {
    const aiUrl = `${url}?open=ai`;
    try {
      await navigator.clipboard.writeText(aiUrl);
      toast('AI link copied — opens AI Studio directly', 'success');
    } catch {
      toast(aiUrl, 'info');
    }
  };
}
