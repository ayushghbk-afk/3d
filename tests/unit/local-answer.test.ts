import { describe, it, expect } from 'vitest';
import { createProjectDoc, defaultClip, defaultLight, defaultMaterial, defaultObject } from '../../src/state/models.js';
import { answerLocally } from '../../src/ai/local-answer.js';

function sceneDoc() {
  const doc = createProjectDoc('Mini', 'solo', 'guest');
  const chair = defaultObject('group', 'Chair');
  doc.objects.push(chair);
  const seat = defaultObject('cube', 'Seat');
  seat.parentId = chair.id;
  seat.position = { x: 1, y: 0.5, z: 0 };
  doc.objects.push(seat);
  const lamp = defaultObject('light', 'Desk lamp');
  lamp.light = { ...defaultLight('point') };
  doc.objects.push(lamp);
  const wood = defaultMaterial('Wood');
  wood.baseColor = '#8b5e3c';
  doc.materials.push(wood);
  seat.materialId = wood.id;
  const clip = defaultClip('Spin');
  clip.tracks.push({ id: 't1', objectId: seat.id, property: 'rotation', keyframes: [{ frame: 0, value: [0, 0, 0], interp: 'linear' }] });
  doc.clips.push(clip);
  return doc;
}

describe('answerLocally', () => {
  it('counts objects, lights, materials, groups and clips', () => {
    const doc = sceneDoc();
    expect(answerLocally(doc, 'how many objects are there?')).toContain('3 objects');
    expect(answerLocally(doc, 'how many lights in my scene?')).toContain('1 light');
    expect(answerLocally(doc, 'number of materials?')).toContain('2 materials'); // +1 seeded default
    expect(answerLocally(doc, 'how many groups?')).toContain('1 groups');
    expect(answerLocally(doc, 'count the clips')).toContain('2 animation clips'); // +1 seeded default
    expect(answerLocally(doc, 'how many scripts?')).toContain('0 scene scripts');
  });

  it('lists objects, materials, lights and clips by name', () => {
    const doc = sceneDoc();
    expect(answerLocally(doc, 'list all objects')).toContain('Seat');
    expect(answerLocally(doc, 'list all objects')).toContain('Chair');
    expect(answerLocally(doc, 'show materials')).toContain('Wood');
    expect(answerLocally(doc, 'what lights are there?')).toContain('Desk lamp');
    expect(answerLocally(doc, 'list clips')).toContain('Spin');
  });

  it('summarizes the scene', () => {
    const doc = sceneDoc();
    const out = answerLocally(doc, "what's in my scene?");
    expect(out).toContain('"Mini"');
    expect(out).toContain('3 objects');
    expect(out).toContain('1 keyframe');
    expect(answerLocally(doc, 'summarize the project')).toContain('"Mini"');
  });

  it('looks up object transforms, materials and visibility', () => {
    const doc = sceneDoc();
    expect(answerLocally(doc, 'where is the Seat?')).toContain('(1, 0.5, 0)');
    expect(answerLocally(doc, 'what material does Seat use?')).toContain('Wood');
    expect(answerLocally(doc, 'what material does Seat use?')).toContain('#8b5e3c');
    expect(answerLocally(doc, 'is Desk lamp visible?')).toContain('visible');
    expect(answerLocally(doc, 'tell me about Seat')).toContain('cube');
  });

  it('returns null for questions needing real AI', () => {
    const doc = sceneDoc();
    expect(answerLocally(doc, 'how do I make this look like a castle?')).toBeNull();
    expect(answerLocally(doc, 'write a poem about my scene')).toBeNull();
    expect(answerLocally(doc, '')).toBeNull();
    expect(answerLocally(doc, 'where is the dragon?')).toBeNull();
  });

  it('tolerates sparse objects from mocks', () => {
    const doc = createProjectDoc('Sparse', 'solo', 'guest');
    (doc.objects as unknown[]).push({ id: 'a', name: 'Blob' });
    expect(answerLocally(doc, 'how many objects?')).toContain('1 objects');
    expect(answerLocally(doc, 'list objects')).toContain('Blob');
    expect(answerLocally(doc, 'summarize')).toContain('"Sparse"');
  });
});
