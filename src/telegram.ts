type SendTelegramMessageOptions = {
  chatId: number | string;
  text: string;
  token: string;
  parseMode?: "HTML" | "Markdown";
  replyMarkup?: Record<string, unknown>;
  fetcher?: typeof fetch;
};

async function sendTelegramMessage({ chatId, text, token, parseMode, replyMarkup, fetcher = fetch }: SendTelegramMessageOptions): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage returned ${response.status}`);
  }
}

export { sendTelegramMessage };
export type { SendTelegramMessageOptions };
