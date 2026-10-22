// Telegram Bot API: one message into one topic of the group.
export type TelegramTarget = { token: string; chatId: string; threadId?: string };

export async function sendMessage(target: TelegramTarget, text: string, fetcher: typeof fetch = fetch): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: target.chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (target.threadId) body.message_thread_id = Number(target.threadId);
  const res = await fetcher(`https://api.telegram.org/bot${target.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // The description says what is wrong (bad chat id, bot not in the group, ...); never the token.
    const data = (await res.json().catch(() => ({}))) as { description?: string };
    throw new Error(`Telegram HTTP ${res.status}: ${data.description ?? 'unknown error'}`);
  }
}
