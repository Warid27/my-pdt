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
};

type ChatResult = {
  text: string;
};

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

async function callOpenAiCompatible({ provider, message, fetcher = fetch }: ChatRequest): Promise<ChatResult> {
  const response = await fetcher(providerUrl(provider, "/chat/completions"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.MODEL_ID,
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Provider ${provider.NAME} returned ${response.status}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error(`Provider ${provider.NAME} returned an empty response`);
  }

  return { text };
}

async function callAnthropicCompatible({ provider, message, fetcher = fetch }: ChatRequest): Promise<ChatResult> {
  const response = await fetcher(providerUrl(provider, "/messages"), {
    method: "POST",
    headers: {
      "x-api-key": provider.API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.MODEL_ID,
      max_tokens: 1024,
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Provider ${provider.NAME} returned ${response.status}`);
  }

  const body = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = body.content?.find((item) => item.type === "text" && item.text)?.text?.trim();
  if (!text) {
    throw new Error(`Provider ${provider.NAME} returned an empty response`);
  }

  return { text };
}

function callProvider(request: ChatRequest): Promise<ChatResult> {
  if (request.provider.TYPE === "ANTHROPIC") {
    return callAnthropicCompatible(request);
  }

  return callOpenAiCompatible(request);
}

export {
  callAnthropicCompatible,
  callOpenAiCompatible,
  callProvider,
  parseProviders,
  selectProvider,
};
export type { ChatResult, ProviderConfig, ProviderType };
