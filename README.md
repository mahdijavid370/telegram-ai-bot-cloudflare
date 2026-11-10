# ربات هوش مصنوعی تلگرام روی Cloudflare Workers

قالب آماده و قابل‌تکثیر برای ساخت ربات تلگرام با سه ارائه‌دهنده هوش مصنوعی:

- **Coarena** از طریق API سازگار با OpenAI
- **OpenRouter** از طریق OpenRouter API
- **Cohere رسمی** از طریق Cohere Chat API v2

ربات روی Cloudflare Workers اجرا می‌شود و تاریخچه مکالمه هر چت را در Cloudflare KV نگه می‌دارد. برای راه‌اندازی، هر شخص باید توکن تلگرام و کلیدهای API خودش را وارد کند؛ هیچ کلید واقعی نباید داخل مخزن GitHub قرار بگیرد.

## امکانات

- وب‌هوک تلگرام روی Cloudflare Workers
- انتخاب ارائه‌دهنده برای هر گفتگو با دستور **/provider** یا منوی دکمه‌ای
- پشتیبانی از OpenRouter، Coarena و Cohere رسمی
- نگهداری تاریخچه جداگانه برای هر chat ID
- دستورات **/start** و **/reset**
- تقسیم پاسخ‌های بلند به پیام‌های قابل ارسال در تلگرام
- بررسی سلامت سرویس در مسیرهای **/** و **/health**
- محافظت اختیاری وب‌هوک با **TELEGRAM_WEBHOOK_SECRET**
- بدون نیاز به سرور دائمی یا دیتابیس خارجی

## شروع سریع

### ۱) ساخت نسخه شخصی از قالب

در بالای صفحه مخزن روی **Use this template** و سپس **Create a new repository** کلیک کن. نام و سطح دسترسی مخزن جدید را انتخاب کن.

### ۲) ساخت ربات تلگرام

1. در تلگرام به [@BotFather](https://t.me/BotFather) برو.
2. دستور **/newbot** را اجرا کن.
3. نام و username ربات را تعیین کن.
4. مقدار Bot Token را در جای امن نگه دار. آن را در GitHub یا داخل کد قرار نده.

### ۳) ساخت KV در Cloudflare

1. وارد [Cloudflare Dashboard](https://dash.cloudflare.com/) شو.
2. از بخش **Storage & databases → Workers KV** یک Namespace بساز.
3. نام پیشنهادی: **CHAT_KV**.
4. شناسه Namespace را کپی کن.
5. در فایل **wrangler.jsonc** مقدار **REPLACE_WITH_YOUR_KV_NAMESPACE_ID** را با شناسه واقعی جایگزین کن.

Binding باید دقیقاً **CHAT_KV** باشد؛ کد از همین نام استفاده می‌کند.

### ۴) آماده‌سازی پروژه و Deploy

نیازمندی‌ها: Node.js نسخه LTS و npm.

    git clone https://github.com/USERNAME/telegram-ai-bot-cloudflare.git
    cd telegram-ai-bot-cloudflare
    npm install
    npx wrangler login
    npm run deploy

به‌جای **USERNAME** نام حساب GitHub خودت را قرار بده. اگر مخزن را با نام دیگری ساخته‌ای، آدرس clone را مطابق آن تغییر بده.

پس از Deploy، آدرس Worker شبیه این خواهد بود:

    https://telegram-ai-bot.YOUR_SUBDOMAIN.workers.dev

### ۵) ثبت Secrets و متغیرها

کلیدها را به‌صورت Secret ثبت کن؛ مقدار واقعی آن‌ها را در فایل‌های پروژه یا GitHub ننویس.

    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put COARENA_API_KEY
    npx wrangler secret put OPENROUTER_API_KEY
    npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

هر فرمان مقدار را به‌صورت تعاملی دریافت می‌کند. اگر از یک ارائه‌دهنده استفاده نمی‌کنی، Secret مربوط به آن را ثبت نکن؛ اما برای فعال‌کردن آن ارائه‌دهنده در ربات، کلیدش لازم است.

متغیرهای غیرمحرمانه را در بخش **Workers & Pages → Worker → Settings → Variables and Secrets** تعریف کن:

| نام | مقدار پیش‌فرض | توضیح |
|---|---|---|
| **DEFAULT_PROVIDER** | **coarena** | ارائه‌دهنده پیش‌فرض: **coarena** یا **openrouter** |
| **COARENA_BASE_URL** | **https://coarena.ai/api/v1** | آدرس API |
| **COARENA_MODEL** | **gemini-3-8-flash** | شناسه مدل در Coarena |
| **OPENROUTER_MODEL** | **openai/gpt-4o-mini** | شناسه مدل در OpenRouter |
| **MAX_HISTORY_MESSAGES** | **20** | حداکثر تعداد پیام‌های ذخیره‌شده |
| **MAX_TELEGRAM_LENGTH** | **3900** | اندازه هر بخش پیام ارسالی |
| **AI_TIMEOUT_MS** | **55000** | مهلت پاسخ API بر حسب میلی‌ثانیه |
| **SYSTEM_PROMPT** | متن پیش‌فرض کد | دستور سیستمی مدل |

برای OpenRouter از [OpenRouter](https://openrouter.ai/keys) کلید API بساز. برای Coarena نیز کلید را از حساب خودت دریافت کن. دسترسی، نام مدل و سهمیه هر سرویس تابع شرایط همان ارائه‌دهنده است.

پس از تغییر متغیرهای Worker، در صورت نیاز Deploy جدید انجام بده:

    npm run deploy

### ۶) اتصال Webhook تلگرام

پس از Deploy، آدرس Worker و Secret وب‌هوک را در دستور زیر قرار بده. مقدار **WORKER_URL** باید آدرس کامل Worker باشد و **WEBHOOK_SECRET** دقیقاً همان مقداری باشد که برای Secret تلگرام ثبت کرده‌ای.

    curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
      -H "Content-Type: application/json" \
      -d '{"url":"<WORKER_URL>","secret_token":"<WEBHOOK_SECRET>"}'

نمونه پاسخ موفق تلگرام شامل **"ok":true** است. اگر Secret وب‌هوک را تنظیم نکرده‌ای، فیلد **secret_token** را از درخواست حذف کن.

برای بررسی وضعیت:

    curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"

### ۷) آزمایش ربات

1. در مرورگر آدرس **<WORKER_URL>/health** را باز کن؛ باید JSON شامل **"ok":true** ببینی.
2. به ربات تلگرام پیام **/start** بده.
3. یک پیام عادی ارسال کن.
4. با **/provider** ارائه‌دهنده فعال را ببین.
5. با **/provider openrouter** یا **/provider coarena** ارائه‌دهنده را برای همان گفتگو عوض کن.
6. با **/reset** تاریخچه همان گفتگو را پاک کن.

## متغیرهای محرمانه و غیرمحرمانه

| نام | نوع | ضروری |
|---|---|---|
| **TELEGRAM_BOT_TOKEN** | Secret | بله |
| **TELEGRAM_WEBHOOK_SECRET** | Secret | اختیاری، ولی توصیه‌شده |
| **COARENA_API_KEY** | Secret | فقط برای استفاده از Coarena |
| **OPENROUTER_API_KEY** | Secret | فقط برای استفاده از OpenRouter |

در محیط Cloudflare، KV باید با نام **CHAT_KV** به Worker متصل باشد.

## توسعه محلی

    cp .dev.vars.example .dev.vars

مقادیر واقعی را فقط در فایل محلی **.dev.vars** وارد کن. این فایل در **.gitignore** قرار دارد. سپس:

    npm run dev

برای اجرای محلی باید Namespace واقعی KV در **wrangler.jsonc** تنظیم شده باشد یا یک Namespace آزمایشی جداگانه بسازی.

## عیب‌یابی

- **ربات پاسخ نمی‌دهد:** خروجی **getWebhookInfo**، لاگ‌های **npx wrangler tail** و آدرس Worker را بررسی کن.
- **Unauthorized از وب‌هوک:** مقدار **TELEGRAM_WEBHOOK_SECRET** باید دقیقاً با **secret_token** هنگام ثبت Webhook یکسان باشد.
- **خطای API:** اعتبار کلید، نام مدل، سهمیه و آدرس API ارائه‌دهنده را بررسی کن.
- **خطای KV:** وجود Namespace و Binding با نام دقیق **CHAT_KV** را بررسی کن.
- **مدل قابل انتخاب نیست:** Secret مربوط به همان ارائه‌دهنده باید در Cloudflare ثبت شده باشد.

## نکات امنیتی

- هر نصب باید Bot Token، API Keyها و KV مستقل داشته باشد.
- هیچ Secret واقعی را در GitHub، فایل نمونه، اسکرین‌شات عمومی یا پیام‌های خطا قرار نده.
- اگر کلیدی اشتباهاً منتشر شد، آن را فوراً از پنل ارائه‌دهنده باطل و جایگزین کن.
- ربات فقط متن پیام‌های تلگرام را پردازش می‌کند؛ فایل و تصویر در این نسخه پیاده‌سازی نشده‌اند.
- تاریخچه با کلید مبتنی بر chat ID ذخیره می‌شود؛ سیاست نگهداری و حذف داده را متناسب با نیاز خود تنظیم کن.

## ساختار فایل‌ها

    telegram-ai-bot-cloudflare/
    ├── index.js
    ├── wrangler.jsonc
    ├── package.json
    ├── .dev.vars.example
    ├── .gitignore
    ├── README.md
    ├── LICENSE
    └── SECURITY.md

## مجوز

این پروژه تحت مجوز MIT منتشر شده است. جزئیات در فایل **LICENSE** آمده است.


## نسخه چندمدلی (فاز اول)

این نسخه سه ارائه‌دهنده مستقل دارد:

- **OpenRouter** از طریق OpenRouter
- **Coarena** از طریق API سازگار با OpenAI (اتصال قبلی حفظ شده است)
- **Cohere رسمی** از طریق API نسخه ۲ در `https://api.cohere.com/v2/chat`

### قابلیت‌های فاز اول

- انتخاب مدل از طریق دکمه‌های Inline تلگرام یا دستور `/models`
- ذخیره مدل انتخابی برای هر کاربر در هر گفتگو
- تاریخچه جداگانه برای هر کاربر؛ در گروه‌ها تاریخچه کاربران از یکدیگر جدا است
- دستورات `/start`، `/help`، `/models`، `/provider`، `/reset` و `/new`
- مهاجرت خودکار تاریخچه و انتخاب Provider قبلی در چت خصوصی
- محدودسازی طول پاسخ تلگرام و Timeout درخواست‌های API

### Secrets و Variables جدید

به‌عنوان Secret اضافه کن:

    npx wrangler secret put COHERE_API_KEY

متغیرهای غیرمحرمانه:

| نام | مقدار پیش‌فرض | توضیح |
|---|---|---|
| `COHERE_MODEL` | `command-a-03-2025` | مدل چت Cohere |

اگر کلید Cohere ثبت نشود، گزینه آن در منو نمایش داده می‌شود اما انتخاب آن با پیام خطای روشن رد می‌شود. OpenRouter و Coarena مستقل از Cohere کار می‌کنند.

### تست‌ها

    npm test

تست‌های واحد، جداسازی کلیدهای حافظه، تقسیم پیام تلگرام و تبدیل پاسخ Cohere را بررسی می‌کنند. تست اتصال زنده به سرویس‌ها نیازمند API Key واقعی است و در CI عمومی اجرا نمی‌شود.

### نکته درباره KV و هم‌زمانی

در این فاز Cloudflare KV حفظ شده تا نصب فعلی بدون تغییر Binding ادامه پیدا کند. KV برای داده‌های کم‌تغییر و هم‌زمانی بالا یک دیتابیس تراکنشی نیست؛ برای بار هم‌زمان بالا، مرحله بعد باید صف‌بندی گفتگو یا Durable Objects اضافه کند.
