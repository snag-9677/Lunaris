/**
 * Lightweight, dependency-free community detection over an undirected entity
 * co-occurrence graph using synchronous label propagation.
 *
 * Deterministic: nodes are processed in sorted order, and ties in neighbour
 * label frequency are broken by the smallest label, so the same graph always
 * yields the same community assignment. Communities are renumbered to a dense
 * 0-based range in order of first appearance for stable, readable ids.
 */

/** Undirected weighted edge between two entity names. */
export interface CoEdge {
  a: string;
  b: string;
  weight: number;
}

const MAX_ITERATIONS = 100;

/**
 * Assign a community id to every node. Nodes with no edges form singleton
 * communities. Returns a map of entity name -> community id.
 */
export function detectCommunities(nodes: string[], edges: CoEdge[]): Map<string, number> {
  const names = [...new Set(nodes)].sort();
  if (names.length === 0) return new Map();

  // Build an adjacency map of neighbour -> summed edge weight.
  const adjacency = new Map<string, Map<string, number>>();
  for (const name of names) adjacency.set(name, new Map());
  for (const { a, b, weight } of edges) {
    if (a === b) continue;
    const na = adjacency.get(a);
    const nb = adjacency.get(b);
    if (!na || !nb) continue; // edge endpoint not in node set
    na.set(b, (na.get(b) ?? 0) + weight);
    nb.set(a, (nb.get(a) ?? 0) + weight);
  }

  // Seed each node with a unique label (its index in sorted order).
  const labels = new Map<string, number>();
  names.forEach((name, i) => labels.set(name, i));

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (const name of names) {
      const neighbours = adjacency.get(name);
      if (!neighbours || neighbours.size === 0) continue;

      // Tally weighted votes per neighbour label.
      const votes = new Map<number, number>();
      for (const [nb, w] of neighbours) {
        const lbl = labels.get(nb);
        if (lbl === undefined) continue;
        votes.set(lbl, (votes.get(lbl) ?? 0) + w);
      }
      if (votes.size === 0) continue;

      // Pick the highest-weight label; break ties by smallest label id.
      let bestLabel = labels.get(name) ?? 0;
      let bestWeight = -Infinity;
      for (const [lbl, w] of [...votes].sort((x, y) => x[0] - y[0])) {
        if (w > bestWeight) {
          bestWeight = w;
          bestLabel = lbl;
        }
      }
      if (bestLabel !== labels.get(name)) {
        labels.set(name, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Renumber labels to a dense 0-based range in order of first appearance.
  const remap = new Map<number, number>();
  const result = new Map<string, number>();
  for (const name of names) {
    const raw = labels.get(name) ?? 0;
    let dense = remap.get(raw);
    if (dense === undefined) {
      dense = remap.size;
      remap.set(raw, dense);
    }
    result.set(name, dense);
  }
  return result;
}
