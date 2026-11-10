const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, accurate AI assistant. Reply in the same language as the user's latest message. Be clear, practical, and honest about uncertainty.";

const DEFAULTS = {
  provider: "coarena",
  coarenaModel: "gemini-3-8-flash",
  googleModel: "gemini-2.5-flash",
  coarenaBaseUrl: "https://coarena.ai/api/v1",
  maxHistoryMessages: 20,
  maxTelegramLength: 3900,
  timeoutMs: 55000,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "telegram-ai-bot-cloudflare", timestamp: new Date().toISOString() });
    }
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: "Bot is not configured" }, 503);

    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
      if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: "Unauthorized" }, 401);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    try {
      const message = update.message || update.edited_message;
      if (message && message.chat && message.chat.id && typeof message.text === "string") {
        await handleMessage(message, env);
      }
    } catch (error) {
      console.error("Update processing failed:", safeError(error));
    }

    // Return 200 for valid Telegram updates to avoid endless Telegram retries.
    return json({ ok: true });
  },
};

async function handleMessage(message, env) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  if (!text) return;

  if (text.startsWith("/start")) {
    await sendTelegramMessage(env, chatId,
      "سلام! من ربات هوش مصنوعی هستم. پیام خودت را بفرست تا پاسخ بدهم.\n\n" +
      "دستورات:\n/start — شروع\n/reset — پاک‌کردن حافظه گفتگو\n/provider — نمایش مدل فعال\n/provider gemini — استفاده از Google AI Studio\n/provider coarena — استفاده از Coarena"
    );
    return;
  }

  if (text === "/reset") {
    await env.CHAT_KV.delete(historyKey(chatId));
    await sendTelegramMessage(env, chatId, "حافظه گفتگوی این چت پاک شد.");
    return;
  }

  if (text === "/provider" || text.startsWith("/provider ")) {
    const requested = text.split(/\s+/)[1]?.toLowerCase();
    if (!requested) {
      const active = await getProvider(chatId, env);
      await sendTelegramMessage(env, chatId, "مدل فعال: " + active + "\nبرای تغییر: /provider gemini یا /provider coarena");
      return;
    }
    if (requested !== "gemini" && requested !== "coarena") {
      await sendTelegramMessage(env, chatId, "مقدار نامعتبر است. از /provider gemini یا /provider coarena استفاده کن.");
      return;
    }
    const requiredKey = requested === "gemini" ? env.GOOGLEAISTUDIO_API_KEY : env.COARENA_API_KEY;
    if (!requiredKey) {
      await sendTelegramMessage(env, chatId, requested === "gemini"
        ? "کلید Google AI Studio روی سرور تنظیم نشده است."
        : "کلید Coarena روی سرور تنظیم نشده است.");
      return;
    }
    await env.CHAT_KV.put(providerKey(chatId), requested);
    await sendTelegramMessage(env, chatId, "مدل فعال این گفتگو به " + requested + " تغییر کرد.");
    return;
  }

  if (text.startsWith("/")) {
    await sendTelegramMessage(env, chatId, "دستور ناشناخته است. برای راهنما /start را بفرست.");
    return;
  }

  if (!env.CHAT_KV) {
    await sendTelegramMessage(env, chatId, "حافظه ربات تنظیم نشده است. مدیر ربات باید KV با نام CHAT_KV را متصل کند.");
    return;
  }

  const provider = await getProvider(chatId, env);
  const apiKey = provider === "gemini" ? env.GOOGLEAISTUDIO_API_KEY : env.COARENA_API_KEY;
  if (!apiKey) {
    await sendTelegramMessage(env, chatId, provider === "gemini"
      ? "کلید Google AI Studio تنظیم نشده است. از مدیر ربات بخواه آن را در Cloudflare ثبت کند."
      : "کلید Coarena تنظیم نشده است. از مدیر ربات بخواه آن را در Cloudflare ثبت کند.");
    return;
  }

  const history = await readHistory(chatId, env);
  history.push({ role: "user", content: text });

  try {
    const answer = provider === "gemini"
      ? await askGoogleAI(history, env)
      : await askCoarena(history, env);

    const cleanAnswer = (answer || "").trim() || "پاسخی از مدل دریافت نشد.";
    history.push({ role: "assistant", content: cleanAnswer });
    const maxMessages = positiveInt(env.MAX_HISTORY_MESSAGES, DEFAULTS.maxHistoryMessages);
    await env.CHAT_KV.put(historyKey(chatId), JSON.stringify(history.slice(-maxMessages)));
    await sendTelegramMessage(env, chatId, cleanAnswer);
  } catch (error) {
    console.error("AI provider error:", safeError(error));
    await sendTelegramMessage(env, chatId, "در ارتباط با مدل هوش مصنوعی خطایی رخ داد. کمی بعد دوباره تلاش کن.");
  }
}

async function askCoarena(history, env) {
  const baseUrl = (env.COARENA_BASE_URL || DEFAULTS.coarenaBaseUrl).replace(/\/+$/, "");
  const model = env.COARENA_MODEL || DEFAULTS.coarenaModel;
  const messages = [
    { role: "system", content: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT },
    ...history.map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content })),
  ];

  const response = await fetchWithTimeout(baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.COARENA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  }, positiveInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs));

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Coarena HTTP " + response.status + ": " + (data.error?.message || "request failed"));
  return data.choices?.[0]?.message?.content || "";
}

async function askGoogleAI(history, env) {
  const model = env.GOOGLEAI_MODEL || DEFAULTS.googleModel;
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) + ":generateContent";
  const contents = history.map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }],
  }));

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GOOGLEAISTUDIO_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.7 },
    }),
  }, positiveInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs));

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Google AI HTTP " + response.status + ": " + (data.error?.message || "request failed"));
  return (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("\n");
}

async function sendTelegramMessage(env, chatId, text) {
  const limit = positiveInt(env.MAX_TELEGRAM_LENGTH, DEFAULTS.maxTelegramLength);
  const chunks = splitText(String(text), limit);
  for (const chunk of chunks) {
    const response = await fetchWithTimeout(
      "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      },
      15000,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error("Telegram sendMessage HTTP " + response.status + ": " + detail.slice(0, 300));
    }
  }
}

async function getProvider(chatId, env) {
  const saved = await env.CHAT_KV.get(providerKey(chatId));
  const configured = (env.DEFAULT_PROVIDER || DEFAULTS.provider).toLowerCase();
  return saved === "gemini" || saved === "coarena" ? saved : (configured === "gemini" ? "gemini" : "coarena");
}

async function readHistory(chatId, env) {
  const raw = await env.CHAT_KV.get(historyKey(chatId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => ["user", "assistant"].includes(item.role) && typeof item.content === "string")
      : [];
  } catch {
    return [];
  }
}

function splitText(text, limit) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks.length ? chunks : [""];
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("Request timed out"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function historyKey(chatId) { return "chat_" + chatId; }
function providerKey(chatId) { return "provider_" + chatId; }

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
