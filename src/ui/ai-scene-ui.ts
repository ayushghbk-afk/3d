import type { EditorSession } from '../editor/session.js';
import { openModal, closeModal } from './modals.js';
import { toast } from './toast.js';
import { escapeHtml } from '../lib/utils.js';
import { SCENE_STYLES } from '../ai/style.js';

/**
 * Scene-aware AI dialogs: "build this scene" and "make it look like X".
 * Both keep working offline (local planner / keyword styles).
 */

const EXAMPLES = [
  'A small sci-fi room with a desk, computer, two monitors, blue neon lights and a chair',
  'A cozy bedroom with a bed, plant and warm lamp',
  'A low poly forest with 12 trees',
  'A solar system with 5 planets',
  'A product showcase stage with a chrome torus',
];

export function promptSceneDescription(s: EditorSession): Promise<void> {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="muted small">Describe a whole scene — the agent plans a hierarchy (groups, parents, materials, lights) and builds it.</p>
      <label class="field">Scene description
        <textarea id="ai-scene-prompt" class="input" rows="3" placeholder="${escapeHtml(EXAMPLES[0])}"></textarea>
      </label>
      <div class="ai-examples">
        ${EXAMPLES.map((e) => `<button class="btn btn-sm ai-example" data-ex="${escapeHtml(e)}">${escapeHtml(e)}</button>`).join('')}
      </div>
      <label class="field small"><input type="checkbox" id="ai-scene-replace" /> Replace the current scene</label>
      <p class="muted small" id="ai-scene-status"></p>`;
    const status = body.querySelector('#ai-scene-status') as HTMLElement;
    const input = body.querySelector('#ai-scene-prompt') as HTMLTextAreaElement;
    openModal({
      title: 'Build a scene with AI',
      body,
      wide: true,
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: 'Build scene',
          kind: 'primary',
          onClick: async () => {
            const text = input.value.trim();
            if (!text) {
              toast('Describe the scene first', 'warn');
              return;
            }
            const replace = (body.querySelector('#ai-scene-replace') as HTMLInputElement).checked;
            status.textContent = 'Planning… (uses the configured AI, falls back to the offline planner)';
            try {
              const result = await s.buildSceneFromPrompt(text, { replace });
              status.textContent = `${result.count} objects created — ${result.description}`;
              toast(`Scene built: ${result.count} objects`, 'success');
              closeModal();
            } catch (e) {
              status.textContent = `Failed: ${(e as Error).message}`;
              toast(`Scene build failed: ${(e as Error).message}`, 'warn');
            }
          },
        },
      ],
    });
    body.querySelectorAll('[data-ex]').forEach((btn) => {
      (btn as HTMLButtonElement).onclick = () => {
        input.value = (btn as HTMLElement).dataset.ex as string;
        input.focus();
      };
    });
    setTimeout(() => input.focus(), 30);
    // keep the promise from dangling when the modal is dismissed
    const check = setInterval(() => {
      if (!document.body.contains(body)) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });
}

export function promptSceneStyle(s: EditorSession): Promise<void> {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    const styles = s.listSceneStyles();
    body.innerHTML = `
      <p class="muted small">Restyle the whole scene: materials, lighting, environment, fog and post-processing.</p>
      <label class="field">Describe a mood
        <input id="ai-style-prompt" class="input" placeholder="cyberpunk" />
      </label>
      <div class="style-grid">
        ${styles
          .map(
            (st) => `<button class="style-card" data-style="${st.id}">
          <span class="style-swatch" style="--a:${st.palette[0]};--b:${st.palette[1] ?? st.palette[0]};--c:${st.palette[2] ?? st.palette[0]}"></span>
          <strong>${escapeHtml(st.label)}</strong>
          <span class="muted small">${escapeHtml(st.description)}</span>
        </button>`,
          )
          .join('')}
      </div>
      <p class="muted small" id="ai-style-status"></p>`;
    const status = body.querySelector('#ai-style-status') as HTMLElement;
    const input = body.querySelector('#ai-style-prompt') as HTMLInputElement;
    const apply = async (text: string): Promise<void> => {
      status.textContent = 'Applying…';
      const result = await s.styleScene(text);
      if (!result) {
        status.textContent = 'No matching style — try “cyberpunk”, “sunset”, “studio”, “clay”…';
        return;
      }
      status.textContent = result.summary;
      toast(result.summary, 'success');
      closeModal();
    };
    openModal({
      title: 'Restyle the scene',
      body,
      wide: true,
      actions: [
        { label: 'Close', kind: 'ghost' },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: () => void apply(input.value.trim() || 'cyberpunk'),
        },
      ],
    });
    body.querySelectorAll('[data-style]').forEach((btn) => {
      (btn as HTMLButtonElement).onclick = () => {
        const id = (btn as HTMLElement).dataset.style as string;
        const st = SCENE_STYLES.find((x) => x.id === id);
        void apply(st?.label ?? id);
      };
    });
    setTimeout(() => input.focus(), 30);
    const check = setInterval(() => {
      if (!document.body.contains(body)) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });
}
