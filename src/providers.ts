import { financeTools, isFinanceToolName, financeToolNames, type FinanceToolCall, type ToolDefinition } from "./finance-tools";
import { habitTools, isHabitToolName } from "./habit-tools";
import { financeSystemPrompt } from "./systemPrompt";

const allTools: ToolDefinition[] = [...financeTools, ...habitTools];

const allToolNames: Set<string> = new Set([...financeToolNames, ...new Set(habitTools.map((t) => t.function.name))]);

function isToolName(value: string): boolean {
  return allToolNames.has(value);
}

type ProviderType = "OPENAI" | "ANTHROPIC";

type ProviderConfig = {
  BASE_URL: string;
  NAME: string;
  TYPE: ProviderType;
  API_KEY: string;
  MODEL_ID: string;
  MODEL_NAME: string;
};

type ChatRequest = {
  provider: ProviderConfig;
  message: string;
  fetcher?: typeof fetch;
  systemPrompt?: string;
  tools?: ToolDefinition[];
};

type ChatResult = {
  text: string;
  toolCalls: FinanceToolCall[];
  rawResponse: unknown;
  usage?: unknown;
};

type ProviderErrorOptions = {
  provider: string;
  status?: number;
  body?: unknown;
};

class ProviderError extends Error {
  provider: string;
  status?: number;
  body?: unknown;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.body = options.body;
  }
}

function isProviderType(value: string): value is ProviderType {
  return value === "OPENAI" || value === "ANTHROPIC";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseProviders(value?: string): ProviderConfig[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const provider = item as Record<string, unknown>;
    const type = isNonEmptyString(provider.TYPE) ? provider.TYPE.toUpperCase() : "";
    if (
      !isNonEmptyString(provider.BASE_URL) ||
      !isNonEmptyString(provider.NAME) ||
      !isProviderType(type) ||
      !isNonEmptyString(provider.API_KEY) ||
      !isNonEmptyString(provider.MODEL_ID) ||
      !isNonEmptyString(provider.MODEL_NAME)
    ) {
      return [];
    }

    return [
      {
        BASE_URL: provider.BASE_URL,
        NAME: provider.NAME,
        TYPE: type,
        API_KEY: provider.API_KEY,
        MODEL_ID: provider.MODEL_ID,
        MODEL_NAME: provider.MODEL_NAME,
      },
    ];
  });
}

function selectProvider(providers: ProviderConfig[]): ProviderConfig | undefined {
  return providers[0];
}

function providerUrl(provider: ProviderConfig, path: string): string {
  return `${provider.BASE_URL.replace(/\/+$/, "")}${path}`;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseOpenAiToolCalls(value: unknown): FinanceToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const call = item as { function?: { name?: string; arguments?: unknown } };
    const name = call.function?.name;
    if (!name || !isToolName(name)) {
      return [];
    }

    return [{ name, arguments: parseToolArguments(call.function?.arguments) }];
  });
}

function parseAnthropicToolCalls(value: unknown): FinanceToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const block = item as { type?: string; name?: string; input?: unknown };
    if (block.type !== "tool_use" || !block.name || !isToolName(block.name)) {
      return [];
    }

    return [{ name: block.name, arguments: parseToolArguments(block.input) }];
  });
}

async function callOpenAiCompatible({
  provider,
  message,
  fetcher = fetch,
  systemPrompt = financeSystemPrompt,
  tools = allTools,
}: ChatRequest): Promise<ChatResult> {
  const response = await fetcher(providerUrl(provider, "/chat/completions"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.MODEL_ID,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      tools,
      tool_choice: "auto",
    }),
  });

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text();
    }
    throw new ProviderError(`Provider ${provider.NAME} returned ${response.status}`, {
      provider: provider.NAME,
      status: response.status,
      body: errorBody,
    });
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
    usage?: unknown;
  };
  const providerMessage = body.choices?.[0]?.message;
  const text = providerMessage?.content?.trim() ?? "";
  const toolCalls = parseOpenAiToolCalls(providerMessage?.tool_calls);
  if (!text && toolCalls.length === 0) {
    throw new ProviderError(`Provider ${provider.NAME} returned an empty response`, {
      provider: provider.NAME,
      body,
    });
  }

  return { text, toolCalls, rawResponse: body, usage: body.usage };
}

async function callAnthropicCompatible({
  provider,
  message,
  fetcher = fetch,
  systemPrompt = financeSystemPrompt,
  tools = allTools,
}: ChatRequest): Promise<ChatResult> {
  const response = await fetcher(providerUrl(provider, "/messages"), {
    method: "POST",
    headers: {
      "x-api-key": provider.API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.MODEL_ID,
      system: systemPrompt,
      max_tokens: 1024,
      messages: [{ role: "user", content: message }],
      tools: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      })),
    }),
  });

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text();
    }
    throw new ProviderError(`Provider ${provider.NAME} returned ${response.status}`, {
      provider: provider.NAME,
      status: response.status,
      body: errorBody,
    });
  }

  const body = (await response.json()) as {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    usage?: unknown;
  };
  const text = body.content?.find((item) => item.type === "text" && item.text)?.text?.trim() ?? "";
  const toolCalls = parseAnthropicToolCalls(body.content);
  if (!text && toolCalls.length === 0) {
    throw new ProviderError(`Provider ${provider.NAME} returned an empty response`, {
      provider: provider.NAME,
      body,
    });
  }

  return { text, toolCalls, rawResponse: body, usage: body.usage };
}

function callProvider(request: ChatRequest): Promise<ChatResult> {
  if (request.provider.TYPE === "ANTHROPIC") {
    return callAnthropicCompatible(request);
  }

  return callOpenAiCompatible(request);
}

export {
  allTools,
  callAnthropicCompatible,
  callOpenAiCompatible,
  callProvider,
  isToolName,
  parseAnthropicToolCalls,
  parseOpenAiToolCalls,
  parseProviders,
  ProviderError,
  selectProvider,
};
export type { ChatResult, ProviderConfig, ProviderType, ToolDefinition };
