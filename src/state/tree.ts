/**
 * Pure hierarchy helpers shared by the editor session, scripts sandbox and the
 * agent API so every parent/delete path enforces the same semantics.
 * (Bug class these fix: deleting a Group only removed its DIRECT children,
 * orphaning grandchildren; setting a parent inside its own descendant created
 * a THREE cycle that hung the render loop.)
 */

interface TreeNode {
  id: string;
  parentId: string | null;
}

/** `root` plus every transitive descendant, in parent-before-child order. */
export function collectSubtree<T extends TreeNode>(all: readonly T[], rootId: string): T[] {
  const byId = new Map<string, T>();
  const childrenOf = new Map<string, T[]>();
  for (const node of all) {
    byId.set(node.id, node);
    if (!node.parentId) continue;
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node);
    else childrenOf.set(node.parentId, [node]);
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    out.push(node);
    for (const kid of childrenOf.get(id) ?? []) stack.push(kid.id);
  }
  return out;
}

/**
 * True when `maybeDescendantId` is `ancestorId` itself or lies inside its
 * subtree. Used to reject cycles before `child.parentId = parent` assignment.
 * Iteration is capped so already-corrupted (cyclic) data can't hang callers.
 */
export function isWithinSubtree<T extends TreeNode>(
  all: readonly T[], ancestorId: string, maybeDescendantId: string,
): boolean {
  const byId = new Map(all.map((x) => [x.id, x]));
  let cur = byId.get(maybeDescendantId);
  for (let hops = 0; cur && hops <= all.length + 1; hops++) {
    if (cur.id === ancestorId) return true;
    if (!cur.parentId) return false;
    const next = byId.get(cur.parentId);
    if (!next || next.id === cur.id) return false; // dangling or already-cyclic data
    cur = next;
  }
  return false;
}
