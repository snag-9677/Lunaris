import type { ModelInfo, Usage } from '@lunaris/core';

/**
 * Static model/pricing table (models.json style).
 * Prices are USD per million tokens.
 */
export const MODELS: ModelInfo[] = [
  // --- Anthropic (per platform.claude.com model table, cached 2026-06) ---
  { provider: 'anthropic', model: 'claude-fable-5', contextWindow: 1_000_000, usdPerMTokIn: 10, usdPerMTokOut: 50 },
  { provider: 'anthropic', model: 'claude-opus-4-8', contextWindow: 1_000_000, usdPerMTokIn: 5, usdPerMTokOut: 25 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', contextWindow: 1_000_000, usdPerMTokIn: 3, usdPerMTokOut: 15 },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000, usdPerMTokIn: 1, usdPerMTokOut: 5 },

  // --- OpenAI (PLACEHOLDER prices — verify against openai.com/pricing before relying on them) ---
  { provider: 'openai', model: 'gpt-4o', contextWindow: 128_000, usdPerMTokIn: 2.5, usdPerMTokOut: 10 },
  { provider: 'openai', model: 'gpt-4o-mini', contextWindow: 128_000, usdPerMTokIn: 0.15, usdPerMTokOut: 0.6 },

  // --- DeepSeek (PLACEHOLDER prices — verify against api-docs.deepseek.com before relying on them) ---
  { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 128_000, usdPerMTokIn: 0.27, usdPerMTokOut: 1.1 },
  { provider: 'deepseek', model: 'deepseek-reasoner', contextWindow: 128_000, usdPerMTokIn: 0.55, usdPerMTokOut: 2.19 },

  // --- Local / test providers: always free ---
  { provider: 'ollama', model: '*', contextWindow: 32_768, usdPerMTokIn: 0, usdPerMTokOut: 0 },
  { provider: 'mock', model: 'echo', contextWindow: 32_768, usdPerMTokIn: 0, usdPerMTokOut: 0 },
];

/** Split a "<provider>/<model>" id. Throws on malformed input. */
export function splitModelId(model: string): { provider: string; model: string } {
  const idx = model.indexOf('/');
  if (idx <= 0 || idx === model.length - 1) {
    throw new Error(`Invalid model id "${model}": expected "<provider>/<model>" (e.g. "anthropic/claude-sonnet-4-6")`);
  }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

/** Look up the pricing entry for a "<provider>/<model>" id (supports per-provider "*" wildcard). */
export function findModelInfo(fullModel: string): ModelInfo | undefined {
  const { provider, model } = splitModelId(fullModel);
  return (
    MODELS.find((m) => m.provider === provider && m.model === model) ??
    MODELS.find((m) => m.provider === provider && m.model === '*')
  );
}

/**
 * Compute the USD cost of a call from its token usage.
 * Local (ollama/*) and test (mock/*) providers are always $0.
 * Unknown models fall back to $0 (no silent over-billing).
 */
export function estimateCostUsd(fullModel: string, usage: Pick<Usage, 'inputTokens' | 'outputTokens'>): number {
  const { provider } = splitModelId(fullModel);
  if (provider === 'ollama' || provider === 'mock') return 0;
  const info = findModelInfo(fullModel);
  if (!info) return 0;
  return (usage.inputTokens * info.usdPerMTokIn + usage.outputTokens * info.usdPerMTokOut) / 1_000_000;
}
