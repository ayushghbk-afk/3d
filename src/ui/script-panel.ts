// Scripts panel: user (and AI) authored restricted JS that drives meshes,
// keyframes, the camera, extra models and the texture generator.
import type { EditorSession } from '../editor/session.js';
import { SCRIPT_EXAMPLES } from '../editor/scripts.js';
import type { SceneScript, ScriptTrigger } from '../state/models.js';
import { escapeHtml } from '../lib/utils.js';
import { toast } from './toast.js';
import { closeFloatWin, getFloatWin, openFloatWin } from './floatwin.js';

export function openScriptPanel(session: EditorSession): void {
  const win = openFloatWin({ id: 'scripts', title: '{ } Scripts', width: 720, height: 580, minWidth: 360, minHeight: 320 });
  renderScriptPanel(session, win.body);
}

export function toggleScriptPanel(session: EditorSession): void {
  if (getFloatWin('scripts')) {
    closeFloatWin('scripts');
    return;
  }
  openScriptPanel(session);
}

function renderScriptPanel(session: EditorSession, root: HTMLElement): void {
  if (!session.doc.scripts) session.doc.scripts = [];
  let selectedId = session.doc.scripts[0]?.id ?? null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const current = (): SceneScript | null => session.doc.scripts.find((s) => s.id === selectedId) ?? null;

  const paint = (): void => {
    if (!document.contains(root)) return;
    const scripts = session.doc.scripts;
    const s = current();
    root.innerHTML = `
      <div class="script-layout">
        <aside class="script-list" aria-label="Scripts">
          <div class="row-between" style="margin-bottom:8px">
            <span class="small muted">${scripts.length} script${scripts.length === 1 ? '' : 's'}</span>
            <button class="btn btn-sm btn-primary" id="sc-new">＋ New</button>
          </div>
          ${scripts.length
            ? scripts.map((sc) => `
              <button class="script-item${sc.id === selectedId ? ' active' : ''}" data-id="${sc.id}">
                <span class="script-item-name">${escapeHtml(sc.name)}</span>
                <span class="muted small">${sc.trigger}${sc.enabled ? ' · on' : ''}</span>
              </button>`).join('')
            : '<p class="muted small">No scripts yet — add one or pick an example.</p>'}
        </aside>
        <div class="script-editor">
          ${s ? `
            <div class="row-between wrap">
              <input id="sc-name" class="input input-sm" value="${escapeHtml(s.name)}" maxlength="80" style="flex:1;min-width:120px" />
              <select id="sc-trigger" class="input input-sm" title="When to run">
                ${(['manual', 'open', 'play', 'frame'] as ScriptTrigger[]).map((t) =>
                  `<option value="${t}"${s.trigger === t ? ' selected' : ''}>${t}</option>`).join('')}
              </select>
              <label class="small"><input type="checkbox" id="sc-enabled" ${s.enabled ? 'checked' : ''} /> enabled</label>
            </div>
            <label class="field">Code
              <textarea id="sc-code" class="input script-code" spellcheck="false" rows="12">${escapeHtml(s.code)}</textarea>
            </label>
            <div class="row-between wrap">
              <label class="small">Examples
                <select id="sc-example" class="input input-sm">
                  <option value="">— insert example —</option>
                  ${SCRIPT_EXAMPLES.map((ex) => `<option value="${ex.id}">${escapeHtml(ex.name)}</option>`).join('')}
                </select>
              </label>
              <span>
                <button class="btn btn-sm" id="sc-del">Delete</button>
                <button class="btn btn-sm btn-primary" id="sc-run">▶ Run</button>
              </span>
            </div>
          ` : '<p class="muted">Create a script to control any mesh, keyframes, camera angle, extra models and AI textures.</p>'}
          <div class="panel-sub">Log</div>
          <pre class="script-log" id="sc-log">${escapeHtml(formatLogs(session))}</pre>
          <p class="small muted">Restricted JS: <code>scene</code>, <code>Math</code>, <code>dt</code>, <code>time</code>, <code>frame</code>. No window/fetch. AI can add/run the same scripts via Agent API <code>script.*</code> and generate textures via <code>window.Web3DStudio.textures</code>.</p>
        </div>
      </div>`;

    root.querySelectorAll('[data-id]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        flush();
        selectedId = (b as HTMLElement).dataset.id as string;
        paint();
      };
    });
    (root.querySelector('#sc-new') as HTMLButtonElement).onclick = () => {
      flush();
      try {
        const created = session.addScript({ name: `Script ${session.doc.scripts.length + 1}` });
        selectedId = created.id;
        paint();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    };

    if (!s) return;
    const nameEl = root.querySelector('#sc-name') as HTMLInputElement;
    const triggerEl = root.querySelector('#sc-trigger') as HTMLSelectElement;
    const enabledEl = root.querySelector('#sc-enabled') as HTMLInputElement;
    const codeEl = root.querySelector('#sc-code') as HTMLTextAreaElement;

    const schedule = (): void => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => flush(), 400);
    };
    nameEl.oninput = schedule;
    codeEl.oninput = schedule;
    triggerEl.onchange = () => { flush(); paint(); };
    enabledEl.onchange = () => { flush(); };

    (root.querySelector('#sc-example') as HTMLSelectElement).onchange = (e) => {
      const id = (e.target as HTMLSelectElement).value;
      const ex = SCRIPT_EXAMPLES.find((x) => x.id === id);
      if (!ex) return;
      session.updateScript(s.id, { name: ex.name, code: ex.code, trigger: ex.trigger });
      paint();
    };
    (root.querySelector('#sc-del') as HTMLButtonElement).onclick = () => {
      if (!confirm(`Delete “${s.name}”?`)) return;
      session.deleteScript(s.id);
      selectedId = session.doc.scripts[0]?.id ?? null;
      paint();
    };
    (root.querySelector('#sc-run') as HTMLButtonElement).onclick = async () => {
      flush();
      const btn = root.querySelector('#sc-run') as HTMLButtonElement;
      btn.disabled = true;
      try {
        const result = await session.runScript(s.id);
        toast(result.ok ? `Ran ${s.name}` : result.error ?? 'Script failed', result.ok ? 'success' : 'error');
        const log = root.querySelector('#sc-log');
        if (log) log.textContent = formatLogs(session);
      } catch (err) {
        toast((err as Error).message, 'error');
      } finally {
        btn.disabled = false;
      }
    };
  };

  const flush = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const s = current();
    if (!s || !document.contains(root)) return;
    const nameEl = root.querySelector('#sc-name') as HTMLInputElement | null;
    const triggerEl = root.querySelector('#sc-trigger') as HTMLSelectElement | null;
    const enabledEl = root.querySelector('#sc-enabled') as HTMLInputElement | null;
    const codeEl = root.querySelector('#sc-code') as HTMLTextAreaElement | null;
    if (!nameEl || !codeEl || !triggerEl || !enabledEl) return;
    session.updateScript(s.id, {
      name: nameEl.value,
      code: codeEl.value,
      trigger: triggerEl.value as ScriptTrigger,
      enabled: enabledEl.checked,
    });
  };

  session.scriptEngine.setOnLog(() => {
    const log = root.querySelector('#sc-log');
    if (log) log.textContent = formatLogs(session);
  });
  paint();
}

function formatLogs(session: EditorSession): string {
  const lines = session.scriptEngine.logs.slice(-40);
  if (!lines.length) return '(empty — run a script)';
  return lines.map((l) => `${l.level === 'error' ? '✖' : '·'} ${l.message}`).join('\n');
}
