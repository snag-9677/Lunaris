import type {
  BudgetLedger,
  EventStore,
  LunarisManifest,
  ProviderAdapter,
  ProviderConfig,
  Reservation,
  StopReason,
  UnifiedEvent,
  UnifiedRequest,
  Usage,
} from '@lunaris/core';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { DEEPSEEK_DEFAULT_BASE_URL, OPENAI_DEFAULT_BASE_URL, OpenAIAdapter } from './adapters/openai.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { MockAdapter } from './adapters/mock.js';
import { estimateCostUsd, findModelInfo, splitModelId } from './pricing.js';

/** Default API-key env var per provider (overridable via manifest providers.<id>.keyEnv). */
const DEFAULT_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export interface ModelGatewayOptions {
  manifest: LunarisManifest;
  ledger: BudgetLedger;
  events?: EventStore;
  /** Env lookup override (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Pre-built adapters keyed by provider id — overrides built-in construction (tests/extensibility). */
  adapters?: Record<string, ProviderAdapter>;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The single streaming chokepoint over all model providers.
 *
 * chat(req) parses "<provider>/<model>", resolves the provider adapter from the
 * manifest, reserves budget BEFORE any tokens flow, streams unified events
 * through, then settles the reservation at the real cost (refunding on error)
 * and appends an `llm.call` event to the event spine.
 *
 * The returned stream always terminates with a message_end event — errors
 * (including budget denials and missing API keys) surface as
 * `{ type: 'message_end', stopReason: 'error', error }` rather than throwing
 * out of the iterator.
 */
export class ModelGateway {
  private readonly manifest: LunarisManifest;
  private readonly ledger: BudgetLedger;
  private readonly events: EventStore | undefined;
  private readonly env: Record<string, string | undefined>;
  private readonly overrides: Record<string, ProviderAdapter>;
  private readonly adapterCache = new Map<string, ProviderAdapter>();

  constructor(opts: ModelGatewayOptions) {
    this.manifest = opts.manifest;
    this.ledger = opts.ledger;
    this.events = opts.events;
    this.env = opts.env ?? process.env;
    this.overrides = opts.adapters ?? {};
  }

  async *chat(req: UnifiedRequest): AsyncIterable<UnifiedEvent> {
    const startedAt = Date.now();

    let adapter: ProviderAdapter;
    let reservation: Reservation;
    try {
      adapter = this.resolveAdapter(req.model);
      reservation = this.ledger.reserve(req.meta, this.estimateReserveUsd(req));
    } catch (err) {
      const error = errorMessage(err);
      this.appendLlmEvent(req, ZERO_USAGE, 'error', Date.now() - startedAt, error);
      yield { type: 'message_end', stopReason: 'error', usage: ZERO_USAGE, error };
      return;
    }

    // Settle/refund exactly once. The finally clause covers consumers that
    // break out of the for-await early: the generator's .return() runs it,
    // and an unsettled reservation is refunded instead of leaking against
    // the day/task caps.
    let finalized = false;
    const settle = (costUsd: number): void => {
      finalized = true;
      reservation.settle(costUsd);
    };
    const refund = (): void => {
      finalized = true;
      reservation.refund();
    };

    let ended = false;
    try {
      for await (const ev of adapter.chat(req)) {
        if (ev.type !== 'message_end') {
          yield ev;
          continue;
        }
        ended = true;
        if (ev.stopReason === 'error') {
          refund();
          this.appendLlmEvent(req, ev.usage, 'error', Date.now() - startedAt, ev.error);
          yield ev;
        } else {
          const costUsd = estimateCostUsd(req.model, ev.usage);
          const usage: Usage = { ...ev.usage, costUsd };
          settle(costUsd);
          this.appendLlmEvent(req, usage, ev.stopReason, Date.now() - startedAt);
          yield { ...ev, usage };
        }
      }
      if (!ended) {
        refund();
        const error = `adapter "${adapter.id}" stream ended without a message_end event`;
        this.appendLlmEvent(req, ZERO_USAGE, 'error', Date.now() - startedAt, error);
        yield { type: 'message_end', stopReason: 'error', usage: ZERO_USAGE, error };
      }
    } catch (err) {
      refund();
      const error = errorMessage(err);
      this.appendLlmEvent(req, ZERO_USAGE, 'error', Date.now() - startedAt, error);
      yield { type: 'message_end', stopReason: 'error', usage: ZERO_USAGE, error };
    } finally {
      if (!finalized) refund();
    }
  }

  // ---------- adapter resolution ----------

  private resolveAdapter(fullModel: string): ProviderAdapter {
    const { provider } = splitModelId(fullModel);
    const override = this.overrides[provider];
    if (override) return override;

    const cached = this.adapterCache.get(provider);
    if (cached) return cached;

    const cfg: ProviderConfig = this.manifest.providers?.[provider] ?? {};
    const adapter = this.createAdapter(provider, cfg);
    this.adapterCache.set(provider, adapter);
    return adapter;
  }

  private createAdapter(provider: string, cfg: ProviderConfig): ProviderAdapter {
    switch (provider) {
      case 'anthropic': {
        const opts: { apiKey: string; baseUrl?: string } = { apiKey: this.requireApiKey(provider, cfg) };
        if (cfg.baseUrl) opts.baseUrl = cfg.baseUrl;
        return new AnthropicAdapter(opts);
      }
      case 'openai':
        return new OpenAIAdapter({
          id: 'openai',
          apiKey: this.requireApiKey(provider, cfg),
          baseUrl: cfg.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
        });
      case 'deepseek':
        return new OpenAIAdapter({
          id: 'deepseek',
          apiKey: this.requireApiKey(provider, cfg),
          baseUrl: cfg.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL,
        });
      case 'ollama': {
        // Base URL precedence: OLLAMA_BASE_URL env (set via .aienv, the
        // per-machine override) > manifest cfg.baseUrl > adapter default.
        const opts: { baseUrl?: string } = {};
        const baseUrl = this.env['OLLAMA_BASE_URL'] || cfg.baseUrl;
        if (baseUrl) opts.baseUrl = baseUrl;
        return new OllamaAdapter(opts);
      }
      case 'mock':
        return new MockAdapter();
      default:
        throw new Error(
          `Unknown provider "${provider}". Known providers: anthropic, openai, deepseek, ollama, mock. ` +
            `Check the model id ("<provider>/<model>") and the [providers] section of lunaris.toml.`,
        );
    }
  }

  private requireApiKey(provider: string, cfg: ProviderConfig): string {
    const keyEnv = cfg.keyEnv ?? DEFAULT_KEY_ENV[provider];
    if (!keyEnv) {
      throw new Error(`Provider "${provider}" requires an API key but no keyEnv is configured in the manifest.`);
    }
    const key = this.env[keyEnv];
    if (!key) {
      throw new Error(
        `Missing API key for provider "${provider}": environment variable ${keyEnv} is not set. ` +
          `Set it (or point providers.${provider}.keyEnv at the right variable in lunaris.toml).`,
      );
    }
    return key;
  }

  // ---------- budget estimation ----------

  /**
   * Rough admission estimate: input chars/4 tokens * input price, floored at
   * $0.001 for paid models. Known-free models (ollama/*, mock/* — pricing
   * table input rate of $0) reserve nothing.
   */
  private estimateReserveUsd(req: UnifiedRequest): number {
    let chars = req.system?.length ?? 0;
    for (const msg of req.messages) {
      for (const part of msg.content) {
        if (part.type === 'text') chars += part.text.length;
        else if (part.type === 'tool_result') chars += part.content.length;
        else chars += JSON.stringify(part.args ?? {}).length;
      }
    }
    if (req.tools) {
      for (const tool of req.tools) {
        chars += tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length;
      }
    }
    const inputTokens = Math.ceil(chars / 4);
    const { provider } = splitModelId(req.model);
    const info = findModelInfo(req.model);
    // Known-free: local/test providers (always $0 in estimateCostUsd) or a $0
    // input rate in the pricing table — no reservation floor for those.
    if (provider === 'ollama' || provider === 'mock' || info?.usdPerMTokIn === 0) return 0;
    const est = (inputTokens * (info?.usdPerMTokIn ?? 0)) / 1_000_000;
    return Math.max(0.001, est);
  }

  // ---------- event spine ----------

  private appendLlmEvent(
    req: UnifiedRequest,
    usage: Usage,
    stopReason: StopReason,
    durationMs: number,
    error?: string,
  ): void {
    if (!this.events) return;
    try {
      this.events.append({
        projectId: req.meta.projectId,
        kind: 'llm.call',
        taskId: req.meta.taskId,
        agentId: req.meta.agentRole,
        payload: {
          callId: req.meta.callId,
          model: req.model,
          usage,
          durationMs,
          stopReason,
          ...(error !== undefined ? { error } : {}),
        },
      });
    } catch {
      // Event-store failures must never break the model stream.
    }
  }
}
