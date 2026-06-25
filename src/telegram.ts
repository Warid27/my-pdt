type SendTelegramMessageOptions = {
  chatId: number | string;
  text: string;
  token: string;
  fetcher?: typeof fetch;
};

async function sendTelegramMessage({ chatId, text, token, fetcher = fetch }: SendTelegramMessageOptions): Promise<void> {
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage returned ${response.status}`);
  }
}

export { sendTelegramMessage };
export type { SendTelegramMessageOptions };
