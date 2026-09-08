// Example: drive Web 3D Studio from Node via the relay server (no dependencies).
//
// 1. npm run agent-relay            # prints RELAY_TOKEN
// 2. In the app: open a project → ✨ AI → Agent API → enable,
//    Relay URL http://127.0.0.1:8787 + token → Connect.
// 3. RELAY_TOKEN=… node examples/agent-node.mjs "a red robot"
//
// The agent reads project context, adds a generated 3D model, and saves.
const RELAY = process.env.AGENT_RELAY_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.RELAY_TOKEN || process.env.AGENT_RELAY_TOKEN;
if (!TOKEN) {
  console.error('Set RELAY_TOKEN to the token printed by `npm run agent-relay`.');
  process.exit(1);
}
const prompt = process.argv.slice(2).join(' ') || 'a cute robot toy';

async function call(method, params = {}, timeoutMs = 90000) {
  const res = await fetch(`${RELAY}/v1/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${json.error?.code}: ${json.error?.message}`);
  return json.result;
}

const { projects } = await call('project.list');
console.log('projects:', projects.map((p) => `${p.name} (${p.id})`).join(', ') || '(none)');
let projectId = projects[0]?.id;
if (!projectId) {
  projectId = (await call('project.create', { name: 'Agent demo' })).project.id;
  console.log('created project', projectId);
}
const { context } = await call('project.context', { projectId });
console.log('--- context ---\n' + context.split('\n').slice(0, 12).join('\n') + '\n---');

console.log(`generating 3D model: "${prompt}" …`);
const gen = await call('model.generate', { projectId, prompt, quality: 'fast' }, 300000);
console.log('added:', gen.object?.name ?? gen.objectIds, '| provider:', gen.provider, gen.fallback ? `(fallback: ${gen.fallback.to})` : '');

await call('object.add', { projectId, kind: 'cube', name: 'Agent plinth', position: { x: 0, y: -0.6, z: 0 }, scale: { x: 3, y: 0.2, z: 3 }, color: '#222831' });
await call('save.now', { projectId });
console.log('saved ✔');
