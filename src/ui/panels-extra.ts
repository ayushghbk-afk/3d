import type { EditorSession } from '../editor/session.js';
import { cloudEnabled } from '../lib/supabase.js';
import { runCloudDiagnostics, reportToText, type CloudReport } from '../lib/cloud-diagnostics.js';
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

const STATUS_ICON: Record<string, string> = { ok: '✓', warn: '⚠', fail: '✕', skip: '·' };

/**
 * Cloud health report. Opened from the save badge, the Project card and the
 * command palette — the three places a "✕ Error" badge appears with no
 * explanation behind it.
 */
export function openCloudDiagnosticsModal(s?: EditorSession): void {
  const body = document.createElement('div');
  body.className = 'diag';
  const projectId = s?.doc.id ?? null;

  const paint = (report: CloudReport | null, running: boolean): void => {
    if (!report) {
      body.innerHTML = `<p class="muted">${running ? 'Probing Supabase… this takes a few seconds.' : 'No report yet.'}</p>`;
      return;
    }
    body.innerHTML = `
      ${report.advice ? `<div class="banner ${report.failed ? 'banner-warn' : 'banner-info'}">${escapeHtml(report.advice)}</div>` : ''}
      <div class="diag-rows">
        ${report.checks
          .map(
            (c) => `<div class="diag-row diag-${c.status}">
              <span class="diag-icon">${STATUS_ICON[c.status] ?? '?'}</span>
              <span class="diag-main">
                <strong>${escapeHtml(c.label)}</strong>
                <span class="muted small">${escapeHtml(c.detail)}</span>
                ${c.raw ? `<code class="diag-raw">${escapeHtml(c.raw)}</code>` : ''}
              </span>
              <span class="muted small diag-ms">${c.ms ? `${c.ms} ms` : ''}</span>
            </div>`,
          )
          .join('')}
      </div>
      <p class="muted small">Ran ${escapeHtml(new Date(report.at).toLocaleTimeString())} against ${escapeHtml(
        report.url || 'no configured project',
      )}. Last save error: ${escapeHtml(s?.syncError.get() ?? 'none')}</p>`;
  };

  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    paint(null, true);
    try {
      paint(await runCloudDiagnostics({ projectId }), false);
    } catch (e) {
      body.innerHTML = `<p class="error">Diagnostics failed: ${escapeHtml((e as Error).message ?? String(e))}</p>`;
    } finally {
      running = false;
    }
  };

  openModal({
    title: 'Cloud diagnostics',
    body,
    wide: true,
    actions: [
      { label: 'Close', kind: 'ghost' },
      {
        label: 'Copy report',
        keepOpen: true,
        onClick: async () => {
          const report = await runCloudDiagnostics({ projectId });
          try {
            await navigator.clipboard.writeText(reportToText(report));
            toast('Report copied — paste it where you are asking for help', 'success');
          } catch {
            toast('Clipboard blocked — see the panel to read it', 'warn');
          }
        },
      },
      { label: 'Run again', kind: 'primary', keepOpen: true, onClick: () => void run() },
    ],
  });
  void run();
}
