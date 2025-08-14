// Cloudflare Worker: SignalWire SMS → Gemini → LaML/XML (Gemini-only)
// Features:
// - ?dry=1           : skip Gemini, return canned reply (routing sanity check)
// - ?mode=json       : return JSON instead of XML (great for Postman)
// - Gemini retries   : up to 3 attempts on 503 "overloaded" with backoff
// - 12s timeout      : via AbortController 
// - SMS-safe output  : clamp + ASCII sanitizer
// - Clear logging    : see exact Gemini errors in Worker Logs

function xmlResponse(xml, status = 200) {
  return new Response(xml, {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

async function readFormBody(request) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function clamp(s, n = 800) {
  if (!s) return "Sorry, I couldn't generate a response.";
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

function sanitizeForSms(s) {
  if (!s) return s;
  const map = {
    "\u2018":"'", "\u2019":"'", "\u201C":'"', "\u201D":'"',
    "\u2013":"-", "\u2014":"-", "\u2026":"...", "\u00A0":" "
  };
  s = s.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0]/g, m => map[m] || " ");
  return clamp(s, 800);
}

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemPrompt() {
  return `
You are an SMS IT Helpdesk assistant.
Primary goal: answer the user's question directly with practical, step-by-step guidance.
Do NOT label messages as phishing or scams unless explicitly asked.
Ask one clarifying question only if essential to proceed.
Keep replies under ~800 characters. Avoid links unless the user asks.
Use plain, friendly language suitable for SMS.
`.trim();
}

function userPrompt(fromNumber, body, meta) {
  return `Incoming SMS Helpdesk Request:
- From: ${fromNumber}
- To: ${meta.to}
- Message: ${body}

If it's troubleshooting, give concrete steps. If it's an info request, answer directly.
Offer one clear next step or a single clarifying question if needed.`.trim();
}

// ---------------- Gemini ----------------
async function callGeminiOnce(apiKey, userMessage, systemMessage, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort("timeout"), timeoutMs);

  // Try the -latest alias; swap to "gemini-1.5-flash" if you prefer
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" +
    encodeURIComponent(apiKey);

  const payload = {
    systemInstruction: { parts: [{ text: systemMessage }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 192 } // slightly lower to help under load
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(t);
    throw new Error(`Gemini fetch error: ${e && e.message ? e.message : String(e)}`);
  }
  clearTimeout(t);

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "<unreadable>");
    // e.g., "Gemini HTTP 503: {...}" or "Gemini HTTP 401: {...}"
    throw new Error(`Gemini HTTP ${res.status}: ${bodyText}`);
  }

  const data = await res.json().catch(e => {
    throw new Error(`Gemini JSON parse error: ${e && e.message ? e.message : String(e)}`);
  });

  const text =
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
    "Sorry, I couldn't generate a response.";
  return text;
}

async function askGeminiWithRetry(apiKey, userMessage, systemMessage, { retries = 2 } = {}) {
  // attempts = retries + 1 (e.g., retries=2 -> up to 3 total calls)
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await callGeminiOnce(apiKey, userMessage, systemMessage);
      return text;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.warn(`Gemini attempt ${attempt + 1} failed: ${msg}`);
      // Retry only on 503 overloads or timeouts
      const isOverload = /Gemini HTTP 503/i.test(msg) || /timeout/i.test(msg);
      if (!isOverload || attempt === retries) throw e;
      // simple backoff: 1s, 2s, ...
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  // Should never hit here
  throw new Error("Gemini retry loop exited unexpectedly");
}

// ---------------- Main Worker ----------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check for GET /
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const form = await readFormBody(request);
    const from = form.From || form.from || "";
    const to   = form.To   || form.to   || "";
    const body = (form.Body || form.body || "").trim();

    const dry  = url.searchParams.get("dry") === "1";     // skip Gemini
    const mode = url.searchParams.get("mode") || "xml";   // "xml" | "json"

    if (!body) {
      const msg = "Got your webhook, but the message body was empty.";
      if (mode === "json") return Response.json({ ok: true, reply: msg });
      return xmlResponse(`<Response><Message>${msg}</Message></Response>`);
    }

    const sys = systemPrompt();
    const usr = userPrompt(from, body, { to });

    let aiText;
    if (dry) {
      aiText = `Dry-run OK. Echo: "${body.slice(0, 140)}"`;
    } else {
      try {
        const key = env.GEMINI_API_KEY;
        if (!key) throw new Error("Missing GEMINI_API_KEY secret.");
        aiText = await askGeminiWithRetry(key, usr, sys, { retries: 2 });
      } catch (e) {
        console.error("Gemini error:", e);
        aiText = "I’m having trouble reaching the AI right now. Try again shortly.";
      }
    }

    const finalText = sanitizeForSms(aiText);
    // Log so you can always see the reply even if SMS can’t be delivered during trial
    console.log(JSON.stringify({ from, to, userBody: body, aiReply: finalText }, null, 2));

    if (mode === "json") {
      return Response.json({ ok: true, from, to, userBody: body, aiReply: finalText });
    }
    return xmlResponse(`<Response><Message>${escapeXml(finalText)}</Message></Response>`);
  },
};
