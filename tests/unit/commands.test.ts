// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeStubSession } from '../helpers/stub-session';
import { defaultObject } from '../../src/state/models';
import {
  allCommands,
  findCommand,
  runCommand,
  searchCommands,
  scoreCommand,
  setCommandHost,
  type CommandHost,
} from '../../src/ui/commands';

function cube(s: ReturnType<typeof makeStubSession>['session'], name = 'Cube') {
  const o = defaultObject('cube', name);
  s.doc.objects.push(o);
  s.viewport.addObject(o);
  return o;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="toast-root"></div><div id="modal-root"></div>';
  setCommandHost(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  setCommandHost(null);
});

describe('command registry', () => {
  it('registers a broad palette of actions with unique ids', () => {
    const cmds = allCommands();
    expect(cmds.length).toBeGreaterThan(60);
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
    for (const c of cmds) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.group.length).toBeGreaterThan(0);
      expect(typeof c.run).toBe('function');
    }
    const groups = new Set(cmds.map((c) => c.group));
    for (const g of ['Create', 'Select', 'Transform', 'View', 'Animation', 'Material', 'AI', 'Project', 'Interface']) {
      expect(groups).toContain(g);
    }
  });

  it('covers the roadmap verbs (gizmo, snapping, modelling, play, export, share)', () => {
    for (const id of [
      'transform.applyAll',
      'transform.mirrorX',
      'transform.snapToGrid',
      'transform.dropToGround',
      'transform.pivotCenter',
      'view.grid',
      'view.firstPerson',
      'anim.bake',
      'anim.autoKey',
      'material.assetBrowser',
      'ai.scene',
      'ai.style',
      'project.backup',
      'project.share',
      'project.exportWeb',
      'project.versions',
      'ui.undo',
      'ui.resetLayout',
    ]) {
      expect(findCommand(id), `missing command ${id}`).toBeTruthy();
    }
  });

  it('fuzzy search ranks exact titles first and respects `when`', () => {
    const { session: s } = makeStubSession();
    const top = searchCommands('mirror x', s);
    expect(top[0].cmd.id).toBe('transform.mirrorX');

    const cubeHits = searchCommands('cube', s);
    expect(cubeHits[0].cmd.title.toLowerCase()).toContain('cube');

    // undo/redo only surface when the history can actually move
    expect(searchCommands('undo', s).map((m) => m.cmd.id)).not.toContain('ui.undo');
    s.history.checkpoint(s.doc, 'test');
    expect(searchCommands('undo', s).map((m) => m.cmd.id)).toContain('ui.undo');
  });

  it('scoreCommand rewards prefixes and rejects non-matches', () => {
    const cmd = findCommand('transform.mirrorX')!;
    expect(scoreCommand(cmd, 'mirror')).toBeGreaterThan(scoreCommand(cmd, 'mirx'));
    expect(scoreCommand(cmd, 'zzzqqq')).toBe(0);
    expect(scoreCommand(cmd, '')).toBe(1);
  });

  it('honours the result limit', () => {
    const { session: s } = makeStubSession();
    expect(searchCommands('e', s, 5).length).toBeLessThanOrEqual(5);
  });
});

describe('running commands', () => {
  it('runs session commands through the registry', async () => {
    const { session: s } = makeStubSession();
    const a = cube(s, 'A');
    const b = cube(s, 'B');
    s.selectIds([a.id, b.id]);

    expect(await runCommand('select.all', s)).toBe(true);
    expect(s.selection.count()).toBe(2);

    a.position = { x: 3, y: 3, z: 3 };
    expect(await runCommand('transform.reset', s)).toBe(true);
    expect(a.position).toEqual({ x: 0, y: 0, z: 0 });

    expect(await runCommand('anim.autoKey', s)).toBe(true);
    expect(s.autoKey.get()).toBe(true);

    const before = s.doc.objects.length;
    expect(await runCommand('transform.duplicate', s)).toBe(true);
    expect(s.doc.objects.length).toBe(before + 2);
  });

  it('returns false and toasts for unknown ids or a missing session', async () => {
    const { session: s } = makeStubSession();
    expect(await runCommand('nope.not.a.command', s)).toBe(false);
    expect(await runCommand('select.all', null)).toBe(false);
  });

  it('routes host-only commands (panels, playback, share) to the command host', async () => {
    const { session: s } = makeStubSession();
    const host: CommandHost = {
      session: s,
      togglePlay: vi.fn(),
      togglePanel: vi.fn(),
      resetLayout: vi.fn(),
      enterPlayMode: vi.fn(),
      exitPlayMode: vi.fn(),
      openImportBackup: vi.fn(),
      isPlayMode: () => false,
    };
    setCommandHost(host);

    expect(await runCommand('anim.play', s)).toBe(true);
    expect(host.togglePlay).toHaveBeenCalledTimes(1);
    expect(await runCommand('ui.assets', s)).toBe(true);
    expect(host.togglePanel).toHaveBeenCalledWith('assets');
    expect(await runCommand('ui.resetLayout', s)).toBe(true);
    expect(host.resetLayout).toHaveBeenCalledTimes(1);
    expect(await runCommand('project.importBackup', s)).toBe(true);
    expect(host.openImportBackup).toHaveBeenCalledTimes(1);
  });

  it('never throws out of runCommand — failures are surfaced as a toast', async () => {
    const { session: s } = makeStubSession();
    s.deleteSelection = () => {
      throw new Error('boom');
    };
    await expect(runCommand('transform.delete', s)).resolves.toBe(false); // failed, not thrown
    const el = document.querySelector('#toast-root .toast-warn');
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('boom');
  });
});
