const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, accurate AI assistant. Reply in the same language as the user's latest message. Be clear, practical, and honest about uncertainty.";

const DEFAULTS = {
  provider: "coarena",
  coarenaModel: "gemini-3-8-flash",
  coarenaBaseUrl: "https://coarena.ai/api/v1",
  openrouterModel: "openai/gpt-4o-mini",
  cohereModel: "command-a-03-2025",
  maxHistoryMessages: 20,
  maxTelegramLength: 3900,
  timeoutMs: 55000,
};

const PROVIDERS = {
  openrouter: { title: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
  coarena: { title: "Coarena", envKey: "COARENA_API_KEY" },
  cohere: { title: "Cohere", envKey: "COHERE_API_KEY" },
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
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
      } else {
        const message = update.message || update.edited_message;
        if (message?.chat?.id && message?.from?.id) await handleMessage(message, env);
      }
    } catch (error) {
      console.error("Update processing failed:", safeError(error));
    }

    // Acknowledge valid Telegram updates quickly; errors are logged and surfaced to the user where possible.
    return json({ ok: true });
  },
};

async function handleMessage(message, env) {
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const text = typeof message.text === "string" ? message.text.trim() : "";

  if (!text) {
    if (message.photo || message.document || message.voice || message.audio) {
      await sendTelegramMessage(env, chatId, "در نسخه فعلی فقط پیام متنی پشتیبانی می‌شود. دریافت و تحلیل فایل و تصویر در فاز بعدی اضافه خواهد شد.");
    }
    return;
  }

  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : "";
  const argument = text.split(/\s+/)[1]?.toLowerCase();

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(env, chatId,
      "سلام! به دستیار هوش مصنوعی چندمدلی خوش آمدی.\n" +
      "از دکمه زیر برای انتخاب مدل استفاده کن یا پیام متنی خودت را بفرست.\n\n" +
      "دستورات: /models، /provider، /reset، /help",
      modelKeyboard(await getProvider(chatId, userId, env))
    );
    return;
  }

  if (command === "/models") {
    await sendTelegramMessage(env, chatId, "مدل موردنظر را انتخاب کن:", modelKeyboard(await getProvider(chatId, userId, env)));
    return;
  }

  if (command === "/provider") {
    if (!argument) {
      const active = await getProvider(chatId, userId, env);
      await sendTelegramMessage(env, chatId,
        "مدل فعال: " + PROVIDERS[active].title + "\nبرای تغییر، یکی از مدل‌های زیر را انتخاب کن:",
        modelKeyboard(active)
      );
      return;
    }
    await selectProvider(argument, chatId, userId, env);
    return;
  }

  if (command === "/reset" || command === "/new") {
    if (!env.CHAT_KV) {
      await sendTelegramMessage(env, chatId, "حافظه ربات تنظیم نشده است. مدیر ربات باید KV با نام CHAT_KV را متصل کند.");
      return;
    }
    await env.CHAT_KV.delete(historyKey(chatId, userId));
    await sendTelegramMessage(env, chatId, "حافظه گفتگوی شما پاک شد. می‌توانی گفتگوی جدیدی را شروع کنی.");
    return;
  }

  if (command) {
    await sendTelegramMessage(env, chatId, "دستور ناشناخته است. برای راهنما /help را بفرست.");
    return;
  }

  if (!env.CHAT_KV) {
    await sendTelegramMessage(env, chatId, "حافظه ربات تنظیم نشده است. مدیر ربات باید KV با نام CHAT_KV را متصل کند.");
    return;
  }

  const provider = await getProvider(chatId, userId, env);
  if (!env[PROVIDERS[provider].envKey]) {
    await sendTelegramMessage(env, chatId, "کلید API مدل " + PROVIDERS[provider].title + " روی سرور تنظیم نشده است. از /models مدل دیگری انتخاب کن.");
    return;
  }

  const history = await readHistory(chatId, userId, env);
  history.push({ role: "user", content: text });

  try {
    const answer = await routeToProvider(provider, history, env);
    const cleanAnswer = String(answer || "").trim() || "پاسخی از مدل دریافت نشد.";
    history.push({ role: "assistant", content: cleanAnswer });
    const maxMessages = positiveInt(env.MAX_HISTORY_MESSAGES, DEFAULTS.maxHistoryMessages);
    await env.CHAT_KV.put(historyKey(chatId, userId), JSON.stringify(history.slice(-maxMessages)));
    await sendTelegramMessage(env, chatId, cleanAnswer);
  } catch (error) {
    console.error("AI provider error:", safeError(error));
    await sendTelegramMessage(env, chatId, "در ارتباط با مدل هوش مصنوعی خطایی رخ داد. کمی بعد دوباره تلاش کن یا از /models مدل دیگری انتخاب کن.");
  }
}

async function handleCallbackQuery(query, env) {
  const data = String(query.data || "");
  const [action, requested] = data.split(":");
  const chatId = String(query.message?.chat?.id || "");
  const userId = String(query.from?.id || "");

  if (action !== "provider" || !PROVIDERS[requested] || !chatId || !userId) {
    await answerCallbackQuery(env, query.id, "درخواست نامعتبر است.");
    return;
  }

  const key = env[PROVIDERS[requested].envKey];
  if (!key) {
    await answerCallbackQuery(env, query.id, "کلید API این مدل روی سرور تنظیم نشده است.");
    return;
  }
  if (!env.CHAT_KV) {
    await answerCallbackQuery(env, query.id, "حافظه ربات تنظیم نشده است.");
    return;
  }

  await env.CHAT_KV.put(providerKey(chatId, userId), requested);
  await answerCallbackQuery(env, query.id, "مدل به " + PROVIDERS[requested].title + " تغییر کرد.");

  const messageId = query.message?.message_id;
  if (messageId) {
    await editTelegramMessage(env, chatId, messageId,
      "مدل فعال شما: " + PROVIDERS[requested].title + "\nپیام بعدی با این مدل پردازش می‌شود.",
      modelKeyboard(requested)
    );
  }
}

async function selectProvider(requested, chatId, userId, env) {
  if (!PROVIDERS[requested]) {
    await sendTelegramMessage(env, chatId, "مدل نامعتبر است. از /models برای مشاهده مدل‌های قابل انتخاب استفاده کن.");
    return;
  }
  if (!env[PROVIDERS[requested].envKey]) {
    await sendTelegramMessage(env, chatId, "کلید API مدل " + PROVIDERS[requested].title + " روی سرور تنظیم نشده است.");
    return;
  }
  if (!env.CHAT_KV) {
    await sendTelegramMessage(env, chatId, "حافظه ربات تنظیم نشده است. مدیر ربات باید KV با نام CHAT_KV را متصل کند.");
    return;
  }
  await env.CHAT_KV.put(providerKey(chatId, userId), requested);
  await sendTelegramMessage(env, chatId, "مدل فعال این گفتگو به " + PROVIDERS[requested].title + " تغییر کرد.");
}

function modelKeyboard(active) {
  const label = (id) => (active === id ? "✓ " : "") + PROVIDERS[id].title;
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: label("openrouter"), callback_data: "provider:gemini" },
          { text: label("coarena"), callback_data: "provider:coarena" },
        ],
        [{ text: label("cohere"), callback_data: "provider:cohere" }],
      ],
    },
  };
}

async function routeToProvider(provider, history, env) {
  switch (provider) {
    case "openrouter": return askOpenRouter(history, env);
    case "coarena": return askCoarena(history, env);
    case "cohere": return askCohere(history, env);
    default: throw new Error("Unsupported provider: " + provider);
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

async function askOpenRouter(history, env) {
  const model = env.OPENROUTER_MODEL || DEFAULTS.openrouterModel;
  const messages = [
    { role: "system", content: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT },
    ...history.map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content })),
  ];

  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.OPENROUTER_API_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": env.OPENROUTER_SITE_URL || "https://my-telegram-bot.mahdijavid370.workers.dev",
      "X-Title": env.OPENROUTER_APP_NAME || "Telegram AI Bot",
    },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  }, positiveInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs));

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || data.message || "request failed";
    throw new Error("OpenRouter HTTP " + response.status + ": " + detail);
  }
  return parseOpenRouterResponse(data);
}

async function askCohere(history, env) {
  const model = env.COHERE_MODEL || DEFAULTS.cohereModel;
  const messages = [
    { role: "system", content: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT },
    ...history.map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: item.content })),
  ];

  const response = await fetchWithTimeout("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.COHERE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: 0.7 }),
  }, positiveInt(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs));

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || data.error?.message || "request failed";
    throw new Error("Cohere HTTP " + response.status + ": " + detail);
  }
  return (data.message?.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

async function sendTelegramMessage(env, chatId, text, extra = {}) {
  const limit = positiveInt(env.MAX_TELEGRAM_LENGTH, DEFAULTS.maxTelegramLength);
  const chunks = splitText(String(text), limit);
  for (let index = 0; index < chunks.length; index++) {
    const payload = {
      chat_id: chatId,
      text: chunks[index],
      disable_web_page_preview: true,
      ...(index === 0 ? extra : {}),
    };
    const response = await telegramRequest(env, "sendMessage", payload);
    if (!response.ok) throw new Error("Telegram sendMessage failed: " + JSON.stringify(response.result || {}));
  }
}

async function editTelegramMessage(env, chatId, messageId, text, extra = {}) {
  const response = await telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
  if (!response.ok && !String(response.description || "").includes("message is not modified")) {
    await sendTelegramMessage(env, chatId, text, extra);
  }
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  await telegramRequest(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: String(text).slice(0, 190),
    show_alert: false,
  });
}

async function telegramRequest(env, method, payload) {
  const response = await fetchWithTimeout(
    "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    15000,
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Telegram " + method + " HTTP " + response.status);
  return data;
}

async function getProvider(chatId, userId, env) {
  let saved = env.CHAT_KV ? await env.CHAT_KV.get(providerKey(chatId, userId)) : null;
  // Preserve the previous private-chat provider preference during migration.
  if (!saved && env.CHAT_KV && chatId === userId) {
    saved = await env.CHAT_KV.get("provider_" + chatId);
  }
  const configured = (env.DEFAULT_PROVIDER || DEFAULTS.provider).toLowerCase();
  if (saved === "gemini") saved = "openrouter"; // Migrate the former Gemini selection to its replacement.
  return PROVIDERS[saved] ? saved : (PROVIDERS[configured] ? configured : DEFAULTS.provider);
}

async function readHistory(chatId, userId, env) {
  const raw = await env.CHAT_KV.get(historyKey(chatId, userId));
  if (raw) return parseHistory(raw);

  // Migrate the previous private-chat history format without sharing group history between users.
  if (chatId === userId) {
    const legacy = await env.CHAT_KV.get("chat_" + chatId);
    if (legacy) return parseHistory(legacy);
  }
  return [];
}

function parseHistory(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item) => ["user", "assistant"].includes(item.role) && typeof item.content === "string")
      : [];
  } catch {
    return [];
  }
}

export function splitText(text, limit) {
  const chunks = [];
  let remaining = String(text);
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

export function historyKey(chatId, userId) {
  return "history_" + chatId + "_" + userId;
}

export function providerKey(chatId, userId) {
  return "provider_" + chatId + "_" + userId;
}

export function parseOpenRouterResponse(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n");
  return "";
}

export function parseCohereResponse(data) {
  return (data?.message?.content || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
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

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
