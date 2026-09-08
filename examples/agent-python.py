"""Example: drive Web 3D Studio from Python via the relay server (stdlib only).

1. npm run agent-relay            # prints RELAY_TOKEN
2. In the app: open a project -> AI -> Agent API -> enable,
   Relay URL http://127.0.0.1:8787 + token -> Connect.
3. RELAY_TOKEN=... python examples/agent-python.py "a wooden chair"
"""
import json
import os
import sys
import urllib.request

RELAY = os.environ.get("AGENT_RELAY_URL", "http://127.0.0.1:8787")
TOKEN = os.environ.get("RELAY_TOKEN") or os.environ.get("AGENT_RELAY_TOKEN")
if not TOKEN:
    sys.exit("Set RELAY_TOKEN to the token printed by `npm run agent-relay`.")
PROMPT = " ".join(sys.argv[1:]) or "a wooden chair"


def call(method: str, params: dict | None = None, timeout_ms: int = 90000):
    req = urllib.request.Request(
        f"{RELAY}/v1/call",
        data=json.dumps({"method": method, "params": params or {}, "timeoutMs": timeout_ms}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_ms / 1000 + 30) as res:
        payload = json.loads(res.read().decode())
    if not payload.get("ok"):
        raise RuntimeError(f"{payload['error'].get('code')}: {payload['error'].get('message')}")
    return payload["result"]


projects = call("project.list")["projects"]
print("projects:", ", ".join(f"{p['name']} ({p['id']})" for p in projects) or "(none)")
project_id = projects[0]["id"] if projects else call("project.create", {"name": "Agent demo"})["project"]["id"]
context = call("project.context", {"projectId": project_id})["context"]
print("--- context ---")
print("\n".join(context.splitlines()[:12]))
print("---")

print(f'generating 3D model: "{PROMPT}" ...')
gen = call("model.generate", {"projectId": project_id, "prompt": PROMPT, "quality": "fast"}, 300000)
print("added:", gen.get("object", {}).get("name", gen.get("objectIds")), "| provider:", gen["provider"])
call("object.add", {"projectId": project_id, "kind": "sphere", "name": "Agent orb",
                    "position": {"x": 2, "y": 1, "z": 0}, "color": "#4ade80"})
call("save.now", {"projectId": project_id})
print("saved OK")
