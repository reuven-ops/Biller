// The single Anthropic client wrapper (docs/DECISIONS.md D1, D13). LLM_MODE=live
// uses the SDK; LLM_MODE=stub uses a deterministic scriptable stub so the whole
// engine runs and tests without a key. Model IDs come from env (brief rule 10);
// no sampling parameter is ever sent on models that reject them (D13).
import Anthropic from '@anthropic-ai/sdk';
import { optionalEnv, requireEnv } from '@advisor/db';

export interface LlmToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type LlmContentBlock =
  { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content:
    | string
    | (
        | LlmContentBlock
        | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      )[];
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  toolChoice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmResponse {
  content: LlmContentBlock[];
  stopReason: string;
  usage: LlmUsage;
}

export interface LlmClient {
  readonly mode: 'live' | 'stub';
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// USD per million tokens (input, output); overridable with MODEL_PRICES_JSON.
const DEFAULT_PRICES: [RegExp, { in: number; out: number }][] = [
  [/^claude-opus/, { in: 5, out: 25 }],
  [/^claude-sonnet/, { in: 2, out: 10 }],
  [/^claude-haiku/, { in: 1, out: 5 }],
];

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const override = optionalEnv('MODEL_PRICES_JSON', '');
  if (override) {
    const table = JSON.parse(override) as Record<string, { in: number; out: number }>;
    for (const [prefix, price] of Object.entries(table)) {
      if (model.startsWith(prefix)) {
        return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
      }
    }
  }
  for (const [re, price] of DEFAULT_PRICES) {
    if (re.test(model)) {
      return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
    }
  }
  return 0;
}

// Models from the 4.6 family onward reject sampling parameters (D13).
function acceptsTemperature(model: string): boolean {
  return !/claude-(sonnet-5|opus-5|opus-4-[678]|sonnet-4-6|fable|mythos)/.test(model);
}

class LiveLlmClient implements LlmClient {
  readonly mode = 'live' as const;
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      // Prompt caching: the system prompt and tool definitions are the stable
      // prefix; the cache breakpoint sits on the system block.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: req.messages as Anthropic.MessageParam[],
      ...(req.tools ? { tools: req.tools as Anthropic.Tool[] } : {}),
      ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
      ...(acceptsTemperature(req.model) ? { temperature: 0 } : {}),
    });
    const content: LlmContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use')
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
    const inputTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
    const outputTokens = response.usage.output_tokens;
    return {
      content,
      stopReason: response.stop_reason ?? 'end_turn',
      usage: {
        inputTokens,
        outputTokens,
        costUsd: costUsd(req.model, response.usage.input_tokens, outputTokens),
      },
    };
  }
}

export type StubHandler = (req: LlmRequest) => LlmResponse | Promise<LlmResponse>;

/**
 * Deterministic stub. Tests install handlers; without one, the stub returns an
 * explicit failure text so nothing downstream can mistake it for a real answer.
 */
export class StubLlmClient implements LlmClient {
  readonly mode = 'stub' as const;
  readonly requests: LlmRequest[] = [];
  private handlers: StubHandler[] = [];

  enqueue(...handlers: StubHandler[]): void {
    this.handlers.push(...handlers);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const handler = this.handlers.shift();
    if (!handler) {
      return {
        content: [{ type: 'text', text: 'STUB: no scripted response' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    }
    return handler(req);
  }
}

export function resolveLlmMode(): 'live' | 'stub' {
  const mode = optionalEnv('LLM_MODE', '');
  if (mode === 'stub') return 'stub';
  if (mode === 'live') return 'live';
  return process.env.ANTHROPIC_API_KEY ? 'live' : 'stub';
}

export function createLlmClient(mode: 'live' | 'stub' = resolveLlmMode()): LlmClient {
  return mode === 'live' ? new LiveLlmClient() : new StubLlmClient();
}

export interface ModelConfig {
  composer: string;
  verifier: string;
  light: string;
}

export function modelConfig(): ModelConfig {
  return {
    composer: optionalEnv('MODEL_COMPOSER', 'claude-sonnet-5'),
    verifier: optionalEnv('MODEL_VERIFIER', 'claude-sonnet-5'),
    light: optionalEnv('MODEL_LIGHT', 'claude-haiku-4-5-20251001'),
  };
}
