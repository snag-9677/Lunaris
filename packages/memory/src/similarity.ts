/**
 * Offline, dependency-free lexical similarity used when no embedding function
 * is supplied. This is the DEFAULT path so the memory package works with zero
 * network access and no LLM.
 *
 * similarity() combines token-set Jaccard with term-frequency cosine so that
 * both shared vocabulary and repetition are accounted for. Result is 0..1.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that',
  'as', 'by', 'from', 'we', 'you', 'i', 'do', 'does', 'did', 'will', 'can',
]);

/** Lowercase word/identifier tokens; keeps code-ish tokens like fooBar, snake_case. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return raw.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [t, av] of a) {
    const bv = b.get(t);
    if (bv !== undefined) dot += av * bv;
  }
  let na = 0;
  for (const v of a.values()) na += v * v;
  let nb = 0;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Lexical similarity in 0..1 between two free-text statements. */
export function lexicalSimilarity(x: string, y: string): number {
  const tx = tokenize(x);
  const ty = tokenize(y);
  if (tx.length === 0 || ty.length === 0) return 0;
  const cos = cosine(termFreq(tx), termFreq(ty));
  const jac = jaccard(new Set(tx), new Set(ty));
  // Cosine dominates (handles repetition / weighting); Jaccard stabilises tiny texts.
  return 0.6 * cos + 0.4 * jac;
}

/** Cosine similarity between two equal-length numeric vectors (for embeddings). */
export function vectorCosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
