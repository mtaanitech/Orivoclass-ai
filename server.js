// Orivoclass - AI platform server. Zero dependencies, Node 18+.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

/* ======================= Config ======================= */
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const env = process.env;
const GEMINI_KEY = env.GEMINI_API_KEY;
const PORT = Number(env.PORT) || 3000;
const CHAT_PER_DAY = Number(env.CHAT_PER_DAY) || 1000; // chat requests per key per day
const IMAGES_PER_DAY = Number(env.IMAGES_PER_DAY) || 50; // generated images per key per day
const PER_MINUTE = Number(env.PER_MINUTE) || 20; // requests per key per minute
const MAX_KEYS_PER_USER = 10;
const SECURE_COOKIE = env.COOKIE_SECURE === "1"; // set when serving over HTTPS
const TRUST_PROXY = env.TRUST_PROXY === "1"; // set when behind a reverse proxy
const SMALL_BODY = 200_000;
const BIG_BODY = 12_000_000; // chat requests may carry base64 images
const BUILDS_PER_DAY = Number(env.BUILDS_PER_DAY) || 30; // site builds per user per day
const MAX_PROJECTS = Number(env.MAX_PROJECTS) || 20; // hosted sites per user
const SITE_MAX_FILES = 20;
const SITE_MAX_BYTES = 1_000_000;
const BUILDER_REVIEW = env.BUILDER_REVIEW !== "0"; // extra self-review pass after every build
const SITE_EXT = new Set(["html", "css", "js", "mjs", "json", "svg", "txt", "md", "xml"]);

const unique = (a) => [...new Set(a.filter(Boolean))];
// The first entry that works is remembered; later entries are fallbacks if a model name is unavailable.
const MODELS = {
  smart: unique([env.GEMINI_SMART_MODEL, "gemini-4-argon", "gemini-3.1-pro-preview", "gemini-2.5-pro"]),
  fast: unique([env.GEMINI_FAST_MODEL, "gemini-3.8-flash", "gemini-2.5-flash"]),
  image: unique([env.GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image", "gemini-2.5-flash-image"]),
};
MODELS.code = unique([env.GEMINI_CODE_MODEL, ...MODELS.smart]); // coding always uses the strongest model
const workingModel = {};

const BASE_PROMPT = `You are Orivoclass, a brilliant, warm and genuinely helpful AI assistant. Today's date is {{DATE}}.

How you think: reason carefully before answering. Be accurate, complete and practical. For hard problems (math, code, analysis, planning) work step by step internally and give a clear, correct result. If you are not sure, say so honestly instead of guessing. Never invent facts, links or citations.

How you speak: talk like a thoughtful, friendly human, not like a robot. Be natural and conversational, skip stiff boilerplate and needless disclaimers, and match the user's energy (short and casual for casual messages, detailed and structured for serious ones). Always reply in the language the user writes in, in any language in the world, and mirror their dialect, slang and register (for example Swahili, Sheng, Arabic dialects, Hinglish, Spanish, French, Chinese, Japanese). If they switch language, switch with them. If they ask for a translation or a specific language, do that. If someone sincerely asks whether you are an AI, answer honestly.

Images: if the user asks you to draw, create, design, generate, illustrate or edit a picture, photo, logo, poster, icon, diagram or any visual, call the generate_image tool with a rich, detailed English prompt (subject, style, composition, lighting, colors, mood, and any exact text that must appear). If the user attached images and wants them edited or used as a reference, set use_attached_images to true. Do not call the tool for ordinary questions. After the image is made, reply with one short, natural sentence in the user's language. You can also look at images the user sends and describe, read or analyze them.

Coding: when asked for code, work like a senior engineer who never ships a bug. Think the problem through first, then write complete, runnable code with no placeholders, using current stable APIs and idioms, inside fenced code blocks (triple backticks) that name the language. Before you answer, mentally run the code: check imports, names, types, edge cases, error handling and off-by-one mistakes. Keep solutions simple and readable. Briefly say how to run and test it. When debugging, find the root cause and show the exact fix. If you are not sure that an API, version or behavior is right, say so plainly instead of guessing. Ask a question only when a missing detail truly blocks you; otherwise make sensible assumptions and state them.`;

const IMAGE_TOOL = {
  name: "generate_image",
  description:
    "Generate or edit an image. Use when the user wants a picture, photo, logo, poster, illustration, icon, diagram or any visual created or edited. Do not use for ordinary text questions.",
  parameters: {
    type: "OBJECT",
    properties: {
      prompt: {
        type: "STRING",
        description: "Detailed English description of the image: subject, style, composition, lighting, colors, mood, and any text that must appear.",
      },
      use_attached_images: {
        type: "BOOLEAN",
        description: "True if the user attached image(s) that should be edited or used as reference.",
      },
    },
    required: ["prompt"],
  },
};

/* ======================= Tiny JSON database ======================= */
const DB_FILE = path.join(__dirname, "data.json");
let db = { users: [], keys: [], sessions: {}, logs: [], projects: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch {}
for (const k of db.keys) { // migrate keys created by older versions
  k.model ||= "smart"; k.images ??= true; k.webSearch ??= false;
  k.usage ||= {}; k.totals ||= { chat: k.requests || 0, image: 0, errors: 0 };
}
let saveTimer = null;
const flush = () => { clearTimeout(saveTimer); saveTimer = null; fs.writeFileSync(DB_FILE, JSON.stringify(db)); };
const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 300); };
process.on("SIGINT", () => { flush(); process.exit(0); });
process.on("SIGTERM", () => { flush(); process.exit(0); });

const uid = () => crypto.randomBytes(8).toString("hex");
const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (k, d = today()) => k.usage[d] || { chat: 0, image: 0 };

/* ======================= HTTP helpers ======================= */
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff" };
function send(res, code, obj, extra = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...SEC_HEADERS, ...extra });
  res.end(JSON.stringify(obj));
}
function clientError(status, message) { return Object.assign(new Error(message), { client: true, status }); }
function readBody(req, limit = SMALL_BODY) {
  return new Promise((ok, no) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { no(clientError(413, "Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { const s = Buffer.concat(chunks).toString("utf8"); ok(s ? JSON.parse(s) : {}); }
      catch { no(clientError(400, "Invalid JSON")); }
    });
    req.on("error", no);
  });
}
function errorStatus(e) {
  if (e.client) return e.status;
  if (e.provider) return e.status === 429 ? 503 : 502;
  return 500;
}
function friendlyError(e) {
  if (e.provider && e.status === 429) return "The AI service is busy right now. Please try again in a moment.";
  if (e.provider && (e.status === 401 || e.status === 403)) return "The server's Gemini API key was rejected. Check GEMINI_API_KEY.";
  return e.message || "Something went wrong";
}
const clientIp = (req) =>
  (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

/* ======================= Auth ======================= */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
function verifyPw(user, pw) {
  const a = Buffer.from(hashPw(String(pw || ""), user.salt)), b = Buffer.from(user.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sessionToken(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)orv_session=([a-f0-9]+)/);
  return m ? m[1] : null;
}
function sessionUser(req) {
  const t = sessionToken(req), id = t && db.sessions[t];
  return id ? db.users.find((u) => u.id === id) || null : null;
}
function startSession(user) {
  const tok = crypto.randomBytes(24).toString("hex");
  db.sessions[tok] = user.id; save();
  return { "Set-Cookie": `orv_session=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SECURE_COOKIE ? "; Secure" : ""}` };
}
const authHits = new Map();
function authThrottled(ip) { // 10 attempts per 10 minutes per IP
  const now = Date.now(), arr = (authHits.get(ip) || []).filter((t) => now - t < 600000);
  arr.push(now); authHits.set(ip, arr);
  return arr.length > 10;
}

/* ======================= Keys & usage ======================= */
const cleanOrigins = (arr) =>
  (Array.isArray(arr) ? arr : String(arr || "").split(","))
    .map((o) => String(o).trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean).slice(0, 20);
const newKeyString = () => "orv_" + crypto.randomBytes(24).toString("base64url");
function publicKey(k) {
  const d = dayOf(k);
  return {
    id: k.id, name: k.name, key: k.key, systemPrompt: k.systemPrompt, origins: k.origins,
    model: k.model, images: k.images, webSearch: k.webSearch, created: k.created,
    totals: k.totals, today: d,
  };
}
function applyKeySettings(k, b) {
  if (b.name !== undefined) k.name = String(b.name).trim().slice(0, 60) || "My site";
  if (b.systemPrompt !== undefined) k.systemPrompt = String(b.systemPrompt).slice(0, 4000);
  if (b.origins !== undefined) k.origins = cleanOrigins(b.origins);
  if (b.model !== undefined) k.model = b.model === "fast" ? "fast" : "smart";
  if (b.images !== undefined) k.images = !!b.images;
  if (b.webSearch !== undefined) k.webSearch = !!b.webSearch;
}
function record(key, { type, ok, ms, source, count = 1 }) {
  const day = today();
  if (ok) {
    key.usage[day] ||= { chat: 0, image: 0 };
    key.usage[day][type] += count;
    key.totals[type] += count;
  } else key.totals.errors++;
  const cutoff = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
  for (const d of Object.keys(key.usage)) if (d < cutoff) delete key.usage[d];
  db.logs.push({ t: Date.now(), userId: key.userId, keyId: key.id, keyName: key.name, type, ok, ms, source, count });
  if (db.logs.length > 2000) db.logs.splice(0, db.logs.length - 2000);
  save();
}
const hits = new Map();
function rateLimited(id) {
  const now = Date.now(), arr = (hits.get(id) || []).filter((t) => now - t < 60000);
  const limited = arr.length >= PER_MINUTE;
  if (!limited) arr.push(now);
  hits.set(id, arr);
  return limited;
}

/* ======================= Gemini ======================= */
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Calls Gemini with the first model of the given kind that exists; remembers the one that worked.
async function callGemini(kind, payload, timeoutMs = 240000) {
  const list = unique([workingModel[kind], ...MODELS[kind]]);
  let lastErr;
  for (const model of list) {
    let res, data;
    try {
      res = await fetch(geminiUrl(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      throw Object.assign(new Error("Could not reach the Gemini API: " + e.message), { provider: true, status: 502 });
    }
    if (res.ok) { workingModel[kind] = model; return { data, model }; }
    const msg = data.error?.message || res.statusText || "Gemini API error";
    lastErr = Object.assign(new Error(msg), { provider: true, status: res.status });
    if (res.status === 404 || /not found|is not supported|unknown model/i.test(msg)) continue; // try next model name
    throw lastErr;
  }
  throw lastErr;
}

const MIME_OK = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);
function sanitizeMessages(raw) {
  const msgs = (Array.isArray(raw) ? raw : [])
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      role: m.role === "user" ? "user" : "model",
      text: typeof m.text === "string" ? m.text.slice(0, 12000) : "",
      images: (Array.isArray(m.images) ? m.images : [])
        .filter((i) => i && MIME_OK.has(i.mimeType) && typeof i.data === "string" && /^[A-Za-z0-9+/=]+$/.test(i.data) && i.data.length < 6_000_000)
        .slice(0, 4),
    }))
    .filter((m) => m.text.trim() || m.images.length)
    .slice(-24);
  let budget = 6; // keep only the 6 most recent images overall
  for (let i = msgs.length - 1; i >= 0; i--) {
    msgs[i].images = msgs[i].images.slice(0, budget);
    budget -= msgs[i].images.length;
  }
  return msgs.filter((m) => m.text.trim() || m.images.length);
}
const toParts = (m) => [
  ...m.images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })),
  ...(m.text ? [{ text: m.text }] : []),
];
const buildSystem = (key) =>
  BASE_PROMPT.replace("{{DATE}}", today()) +
  (key.systemPrompt ? "\n\nInstructions from the owner of this assistant (follow them):\n" + key.systemPrompt : "") +
  (key.images ? "" : "\n\nImage generation is disabled here. If asked to create an image, politely explain you can't do that in this chat.");

async function generateImage(prompt, refs = []) {
  const parts = [...refs.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: String(prompt).slice(0, 4000) }];
  const { data } = await callGemini("image", { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } });
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
  const inl = part && (part.inlineData || part.inline_data);
  if (!inl) throw new Error("The image model returned no image (the prompt may have been blocked).");
  return { mimeType: inl.mimeType || inl.mime_type || "image/png", data: inl.data };
}

// Main chat brain: answers questions, can look at images, search the web and generate images via tool calling.
async function runChat(key, rawMessages, modelOverride) {
  const msgs = sanitizeMessages(rawMessages);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user")
    throw clientError(400, 'Send { "message": "..." } or { "messages": [{ "role": "user"|"model", "text": "..." }] } ending with a user message');
  const kind = (modelOverride || key.model) === "fast" ? "fast" : "smart";
  const lastUser = msgs[msgs.length - 1];
  const contents = msgs.map((m) => ({ role: m.role, parts: toParts(m) }));
  let tools = [];
  if (key.images) tools.push({ functionDeclarations: [IMAGE_TOOL] });
  if (key.webSearch) tools.push({ googleSearch: {} });

  const images = []; let sources = [], model = "";
  for (let round = 0; round < 3; round++) {
    const payload = {
      systemInstruction: { parts: [{ text: buildSystem(key) }] },
      contents,
      generationConfig: { temperature: 0.7 },
    };
    if (tools.length) payload.tools = tools;
    let out;
    try { out = await callGemini(kind, payload); }
    catch (e) {
      if (e.provider && e.status === 400 && tools.length > 1) { // tools can't be combined on this model: keep image tool only
        tools = [tools[0]]; payload.tools = tools; out = await callGemini(kind, payload);
      } else throw e;
    }
    model = out.model;
    const cand = out.data.candidates?.[0];
    const parts = cand?.content?.parts || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    const chunks = cand?.groundingMetadata?.groundingChunks || [];
    for (const c of chunks) if (c.web?.uri && !sources.some((s) => s.uri === c.web.uri)) sources.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const blocked = out.data.promptFeedback?.blockReason;
      return { reply: text || (blocked ? "Sorry, I can't help with that request." : "Sorry, I couldn't come up with an answer. Please try again."), images, sources: sources.slice(0, 8), model };
    }
    contents.push({ role: "model", parts }); // keep the model turn exactly as returned (includes thought signatures)
    const responses = [];
    for (const p of calls) {
      const { name, args = {} } = p.functionCall;
      let response;
      if (name !== "generate_image") response = { error: "Unknown tool" };
      else if (images.length >= 2) response = { error: "Image limit for one message reached" };
      else if (dayOf(key).image + images.length >= IMAGES_PER_DAY) response = { error: "The daily image limit has been reached. Tell the user to try again tomorrow." };
      else {
        try {
          images.push(await generateImage(args.prompt, args.use_attached_images ? lastUser.images : []));
          response = { result: "Image generated successfully and is now shown to the user." };
        } catch (e) { response = { error: "Image generation failed: " + e.message }; }
      }
      responses.push({ functionResponse: { name, response } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return { reply: "Here you go.", images, sources: sources.slice(0, 8), model };
}

/* ======================= Public API (/v1/*) ======================= */
function authenticateKey(req, res) {
  const origin = (req.headers.origin || "").toLowerCase();
  const cors = { "Access-Control-Allow-Origin": req.headers.origin || "*", Vary: "Origin" };
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const key = db.keys.find((k) => !k.revoked && k.key === token);
  if (!key) { send(res, 401, { error: "Invalid or revoked API key" }, cors); return {}; }
  if (key.origins.length && origin && !key.origins.includes(origin)) { send(res, 403, { error: "This site is not allowed to use this key" }, cors); return {}; }
  if (!GEMINI_KEY) { send(res, 500, { error: "The server has no GEMINI_API_KEY configured" }, cors); return {}; }
  if (rateLimited(key.id)) { send(res, 429, { error: "Too many requests, slow down" }, cors); return {}; }
  return { key, cors };
}

async function handleChat(req, res, source = "api", sessionKey = null, bodyIn = null) {
  const auth = sessionKey ? { key: sessionKey, cors: {} } : authenticateKey(req, res);
  const { key, cors } = auth;
  if (!key) return;
  const t0 = Date.now();
  try {
    const body = bodyIn || (await readBody(req, BIG_BODY));
    if (dayOf(key).chat >= CHAT_PER_DAY) return send(res, 429, { error: "Daily chat limit reached for this key" }, cors);
    const messages = Array.isArray(body.messages) ? body.messages : body.message ? [{ role: "user", text: String(body.message), images: body.images }] : [];
    const out = await runChat(key, messages, body.model);
    record(key, { type: "chat", ok: true, ms: Date.now() - t0, source });
    if (out.images.length) record(key, { type: "image", ok: true, ms: Date.now() - t0, source, count: out.images.length });
    send(res, 200, out, cors);
  } catch (e) {
    if (!e.client) record(key, { type: "chat", ok: false, ms: Date.now() - t0, source });
    send(res, errorStatus(e), { error: friendlyError(e) }, cors);
  }
}

async function handleImages(req, res) {
  const { key, cors } = authenticateKey(req, res);
  if (!key) return;
  const t0 = Date.now();
  try {
    if (!key.images) return send(res, 403, { error: "Image generation is disabled for this key" }, cors);
    if (dayOf(key).image >= IMAGES_PER_DAY) return send(res, 429, { error: "Daily image limit reached for this key" }, cors);
    const body = await readBody(req, BIG_BODY);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return send(res, 400, { error: 'Send { "prompt": "describe the image" }' }, cors);
    const refs = sanitizeMessages([{ role: "user", text: "x", images: body.images }])[0]?.images || [];
    const image = await generateImage(prompt, refs);
    record(key, { type: "image", ok: true, ms: Date.now() - t0, source: "api" });
    send(res, 200, { images: [image] }, cors);
  } catch (e) {
    if (!e.client) record(key, { type: "image", ok: false, ms: Date.now() - t0, source: "api" });
    send(res, errorStatus(e), { error: friendlyError(e) }, cors);
  }
}

/* ======================= Site builder (the AI writes the code, Orivoclass hosts it) ======================= */
const CODE_SYSTEM = [
  "You are Orivoclass Builder, a senior full-stack engineer and product designer. You build complete, polished websites and web apps as static files (HTML, CSS, JavaScript) that Orivoclass hosts for the user.",
  "",
  "CORRECTNESS RULES (the most important part of your job):",
  "1. Write complete, working code. Never use placeholders, TODOs, ellipses, or comments such as 'rest of the code here'. Every file you return must be the ENTIRE file.",
  "2. Before answering, mentally run the code. Every function and variable must be defined, every id and class used in JavaScript must exist in the HTML, every referenced file must exist, and every tag, bracket and quote must be closed. Check for typos.",
  "3. Use relative paths only (style.css, script.js, pages/about.html). Never start a path with a slash, because the site is served from a sub-path.",
  "4. No build tools, no Node or server code, no npm. Plain HTML, CSS and JavaScript. Libraries only from https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net/npm, always with an exact version number.",
  "5. The page runs inside a sandboxed frame: do not rely on localStorage, sessionStorage or cookies (keep state in memory, or wrap storage access in try/catch). Handle forms in JavaScript. Only call external APIs the user asked for.",
  "6. Handle errors and edge cases: empty input, failed requests, very small screens. Prefer simple, robust solutions over clever ones.",
  "7. When editing an existing project, keep everything that already works, change only what was asked, and return only the files that change (each one complete).",
  "",
  "QUALITY RULES:",
  "- Modern, beautiful, responsive, mobile-first design with a cohesive color palette, good typography, spacing and subtle animations. Semantic HTML and accessible (labels, alt text, focus states, good contrast).",
  "- Write real, specific content that fits the user's topic. No lorem ipsum. Write the visible text in the same language the user wrote their request in, unless they ask otherwise.",
  "- Do not hotlink images you cannot be sure exist. Use inline SVG, CSS gradients, emoji or data URIs instead.",
  "- Structure: index.html is the entry point. Use style.css and script.js for anything larger than a small page. Lowercase file names. At most 12 files and under 1 MB in total. Allowed file types: html, css, js, json, svg, txt, md.",
  "",
  "SAFETY: do not build pages that impersonate a real company, bank, government or person, pages that collect passwords or payment card details, or fake receipts, reviews or records. If asked, return no files and explain briefly and kindly in the message.",
  "",
  "OUTPUT: reply with JSON only. 'message' is a short, friendly reply in the user's language saying what you built or changed, plus one or two ideas for next steps. 'files' lists the files to create or replace (path + complete content). 'deleted' lists paths to delete (usually empty).",
].join("\n");

const BUILD_SCHEMA = {
  type: "OBJECT",
  properties: {
    message: { type: "STRING" },
    files: { type: "ARRAY", items: { type: "OBJECT", properties: { path: { type: "STRING" }, content: { type: "STRING" } }, required: ["path", "content"] } },
    deleted: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["message", "files"],
};

const MIME = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", svg: "image/svg+xml", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", xml: "application/xml; charset=utf-8",
};

function cleanPath(p) {
  const s = String(p || "").trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._\/-]{0,79}$/.test(s) || s.includes("..") || s.includes("//") || s.endsWith("/")) return null;
  return SITE_EXT.has(s.split(".").pop()) && s.includes(".") ? s : null;
}
function parseJsonLoose(raw) {
  const tries = [raw, raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, ""), raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)];
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === "object") return v; } catch {} }
  return null;
}

// One call to the coding model. Retries once if the answer is cut off or is not valid JSON.
async function generateCode(contents) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    const { data } = await callGemini("code", {
      systemInstruction: { parts: [{ text: CODE_SYSTEM }] },
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 20000, responseMimeType: "application/json", responseSchema: BUILD_SCHEMA },
    }, 600000);
    const cand = data.candidates?.[0];
    const raw = (cand?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    const v = raw && parseJsonLoose(raw);
    if (v && Array.isArray(v.files)) {
      return {
        raw,
        message: String(v.message || "").slice(0, 2000),
        files: v.files.filter((f) => f && typeof f === "object"),
        deleted: Array.isArray(v.deleted) ? v.deleted.map(String) : [],
      };
    }
    lastErr = new Error(cand?.finishReason === "MAX_TOKENS"
      ? "The answer was too long and got cut off. Ask for a smaller site, or build it in steps."
      : "The AI returned an incomplete answer. Please try again.");
  }
  throw lastErr;
}

// ---- Automatic checks: catch the common mistakes before the user ever sees them ----
function jsSyntaxError(where, code) {
  if (/^\s*(import|export)\s/m.test(code)) return null; // ES module syntax cannot be checked as a classic script
  try { new vm.Script(code, { filename: where }); return null; }
  catch (e) { const line = String(e.stack || "").match(/^[^\n]*?:(\d+)\n/); return `${e.message}${line ? " (line " + line[1] + ")" : ""}`; }
}
const cssBalance = (where, code, issues) => {
  const css = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const open = (css.match(/\{/g) || []).length, close = (css.match(/\}/g) || []).length;
  if (open !== close) issues.push(`${where} has unbalanced CSS braces (${open} "{" vs ${close} "}").`);
};
const BALANCED_TAGS = ["div", "section", "main", "header", "footer", "nav", "article", "aside", "ul", "ol", "table", "form", "button", "a", "span", "select", "textarea", "head", "body", "html"];

function verifyProject(files) {
  const issues = [], paths = Object.keys(files), scripts = [];
  if (!files["index.html"]) issues.push("There is no index.html. The entry point must be named index.html.");
  for (const p of paths) {
    const c = files[p], ext = p.split(".").pop();
    if (ext === "json") { try { JSON.parse(c); } catch (e) { issues.push(`${p} is not valid JSON: ${e.message}`); } }
    else if (ext === "css") cssBalance(p, c, issues);
    else if (ext === "js" || ext === "mjs") scripts.push({ where: p, code: c });
    else if (ext === "html") {
      const noComments = c.replace(/<!--[\s\S]*?-->/g, "");
      if (!/^\s*<!doctype html/i.test(c)) issues.push(`${p} must start with <!doctype html>.`);
      if (!/<meta[^>]+name=["']viewport["']/i.test(c)) issues.push(`${p} is missing <meta name="viewport" content="width=device-width, initial-scale=1">.`);
      if (!/<title>[\s\S]*?\S[\s\S]*?<\/title>/i.test(c)) issues.push(`${p} is missing a <title>.`);
      let n = 0;
      for (const m of noComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = m[1];
        if (/\bsrc\s*=/i.test(attrs) || !m[2].trim()) continue;
        const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
        if (type && !/javascript|ecmascript/i.test(type)) continue; // module, json, importmap...
        scripts.push({ where: `${p} (inline script #${++n})`, code: m[2] });
      }
      for (const m of noComments.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssBalance(`${p} (<style>)`, m[1], issues);
      const markup = noComments.replace(/<script\b[\s\S]*?<\/script>/gi, "<script></script>").replace(/<style\b[\s\S]*?<\/style>/gi, "<style></style>");
      for (const tag of BALANCED_TAGS) {
        const open = (markup.match(new RegExp("<" + tag + "(?=[\\s>/])", "gi")) || []).length;
        const close = (markup.match(new RegExp("</" + tag + "\\s*>", "gi")) || []).length;
        if (open !== close) issues.push(`${p} has unbalanced <${tag}> tags (${open} opening vs ${close} closing).`);
      }
      const ids = new Map();
      for (const m of markup.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) ids.set(m[1], (ids.get(m[1]) || 0) + 1);
      for (const [id, k] of ids) if (k > 1) issues.push(`${p} uses id "${id}" ${k} times. Ids must be unique.`);
      const dir = require("path").posix.dirname(p);
      for (const m of noComments.matchAll(/\b(?:src|href|action|poster)\s*=\s*(["'])(.*?)\1/gi)) {
        const ref = m[2].trim();
        if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
        if (ref.startsWith("/")) { issues.push(`${p} uses the absolute path "${ref}". Use a relative path (no leading slash) because the site is served from a sub-path.`); continue; }
        const clean = ref.replace(/[?#].*$/, "");
        if (!clean || clean === "." || clean.endsWith("/")) continue;
        const target = require("path").posix.normalize(require("path").posix.join(dir, clean));
        if (!(target in files)) issues.push(`${p} references "${ref}" but no such file exists in the project.`);
      }
    }
  }
  for (const s of scripts) { const err = jsSyntaxError(s.where, s.code); if (err) issues.push(`JavaScript syntax error in ${s.where}: ${err}`); }
  // JavaScript must only look up element ids that exist somewhere.
  const allText = paths.filter((p) => /\.(html|js|mjs)$/.test(p)).map((p) => files[p]).join("\n");
  const defined = new Set();
  for (const re of [/\bid\s*=\s*\\?["']([\w-]+)\\?["']/g, /\.id\s*=\s*["'`]([\w-]+)["'`]/g, /setAttribute\(\s*["']id["']\s*,\s*["']([\w-]+)["']/g, /\bid:\s*["']([\w-]+)["']/g])
    for (const m of allText.matchAll(re)) defined.add(m[1]);
  const used = new Set();
  for (const s of scripts) {
    for (const m of s.code.matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)) used.add(m[1]);
    for (const m of s.code.matchAll(/querySelector(?:All)?\(\s*["']#([\w-]+)["']\s*\)/g)) used.add(m[1]);
  }
  for (const id of used) if (!defined.has(id)) issues.push(`JavaScript looks for an element with id "${id}" but no element in the project has that id.`);
  return issues;
}

// Apply the AI's file changes to a working copy. Returns problems the AI should fix.
function applyChanges(working, out, changed) {
  const problems = [];
  for (const f of out.files) {
    const p = cleanPath(f.path);
    if (!p) { problems.push(`The file path "${String(f.path).slice(0, 60)}" is not allowed. Use lowercase names such as index.html, style.css, script.js (allowed types: html, css, js, json, svg, txt, md).`); continue; }
    if (typeof f.content !== "string" || !f.content.trim()) { problems.push(`The file ${p} is empty. Return its complete content.`); continue; }
    working[p] = f.content; changed.add(p);
  }
  for (const d of out.deleted) { const p = cleanPath(d); if (p && p in working) { delete working[p]; changed.add(p); } }
  const sz = siteSize(working);
  if (sz.count > SITE_MAX_FILES) problems.push(`There are too many files (${sz.count}). The maximum is ${SITE_MAX_FILES}. Merge files.`);
  if (sz.bytes > SITE_MAX_BYTES) problems.push(`The project is too large (${Math.round(sz.bytes / 1024)} KB). The maximum is ${Math.round(SITE_MAX_BYTES / 1024)} KB. Make it smaller.`);
  return problems;
}
const siteSize = (files) => ({ count: Object.keys(files).length, bytes: Object.values(files).reduce((s, c) => s + Buffer.byteLength(c), 0) });
const projectContext = (files) => Object.keys(files).length
  ? "Current project files:\n\n" + Object.entries(files).map(([p, c]) => `--- FILE: ${p} ---\n${c}`).join("\n\n")
  : "This is a new project with no files yet.";

const jobs = new Map();
setInterval(() => { for (const [id, j] of jobs) if (Date.now() - j.started > 3600000) jobs.delete(id); }, 600000).unref();
function buildQuota(user) {
  if (!user.builds || user.builds.date !== today()) user.builds = { date: today(), count: 0 };
  return user.builds;
}
function canBuild(user, project) {
  const running = [...jobs.values()].filter((j) => j.status === "running");
  if (project && running.some((j) => j.projectId === project.id)) return { status: 409, error: "This site is already being built. Wait for it to finish." };
  if (running.filter((j) => j.userId === user.id).length >= 2) return { status: 429, error: "You already have 2 builds running. Wait for one to finish." };
  if (buildQuota(user).count >= BUILDS_PER_DAY) return { status: 429, error: `Daily build limit reached (${BUILDS_PER_DAY}). Try again tomorrow.` };
  return null;
}
function startBuild(user, project, instruction) {
  const job = { id: uid(), userId: user.id, projectId: project.id, status: "running", step: "Starting...", started: Date.now() };
  jobs.set(job.id, job);
  buildQuota(user).count++; save();
  executeBuild(job, user, project, instruction).catch(() => {});
  return job;
}

async function executeBuild(job, user, project, instruction) {
  const step = (s) => { job.step = s; };
  try {
    const before = project.files, working = { ...before }, changed = new Set();
    const hist = project.history.slice(-10).map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
    while (hist.length && hist[0].role !== "user") hist.shift();
    const contents = [...hist, { role: "user", parts: [{ text: projectContext(before) + "\n\nUser request:\n" + instruction }] }];
    const turn = async (userText) => {
      if (userText) contents.push({ role: "user", parts: [{ text: userText }] });
      const out = await generateCode(contents);
      contents.push({ role: "model", parts: [{ text: out.raw }] });
      return { out, problems: applyChanges(working, out, changed) };
    };

    step("Writing the code...");
    let { out, problems } = await turn();
    const message = out.message || "Done.";

    if (changed.size) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const issues = [...problems, ...verifyProject(working)];
        if (!issues.length) break;
        step(`Fixing ${issues.length} problem${issues.length > 1 ? "s" : ""} found by the automatic checks...`);
        ({ problems } = await turn("Automatic checks found these problems:\n- " + issues.join("\n- ") + "\n\nFix every one of them. Return only the files that change, each one complete."));
      }
      if (BUILDER_REVIEW) {
        step("Reviewing the code for bugs...");
        ({ problems } = await turn("Now act as a strict code reviewer and QA engineer. Re-read ALL of the code line by line. Look for bugs, runtime errors, undefined variables or functions, ids and classes that do not match, broken logic, missing edge cases, layout problems on small phones, accessibility problems, and anything incomplete. If you find problems, return the corrected complete files (only those that change). If everything is correct, return an empty files array."));
        const issues = [...problems, ...verifyProject(working)];
        if (issues.length) {
          step("Final fixes...");
          ({ problems } = await turn("Automatic checks found these problems:\n- " + issues.join("\n- ") + "\n\nFix every one of them. Return only the files that change, each one complete."));
        }
      }
    }

    if (!Object.keys(working).length) { // nothing was built (for example the request was declined): do not keep an empty site
      db.projects = db.projects.filter((p) => p !== project);
      buildQuota(user).count = Math.max(0, buildQuota(user).count - 1); save();
      job.result = { message, changed: [], verified: false, issues: [], removed: true };
      job.status = "done";
      return;
    }
    const finalIssues = changed.size ? [...problems, ...verifyProject(working)] : [];
    const sz = siteSize(working);
    if (sz.count > SITE_MAX_FILES || sz.bytes > SITE_MAX_BYTES) throw clientError(400, "The generated site is too large. Ask for something smaller.");
    const changedList = [...changed].filter((p) => before[p] !== working[p]);
    project.files = working;
    project.history.push({ role: "user", text: instruction.slice(0, 4000) }, { role: "model", text: message });
    project.history = project.history.slice(-30);
    project.updated = Date.now(); save();
    job.result = { message, changed: changedList, verified: changed.size > 0 && finalIssues.length === 0, issues: finalIssues };
    job.status = "done";
  } catch (e) {
    buildQuota(user).count = Math.max(0, buildQuota(user).count - 1);
    if (!Object.keys(project.files).length && !project.history.length) db.projects = db.projects.filter((p) => p !== project);
    save();
    job.status = "error"; job.error = friendlyError(e);
  }
}

// ---- Hosting: sites are served from /s/<slug>/ inside a CSP sandbox (no cookies, no access to the dashboard) ----
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox";
function notFoundPage(res) {
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><body style="font-family:system-ui;text-align:center;padding:4rem 1rem"><h1>Site not found</h1><p>This site does not exist or is not published.</p></body>');
}
function serveProject(res, project, rest, isPreview) {
  let p;
  try { p = decodeURIComponent(rest || "/").replace(/^\/+/, ""); } catch { return notFoundPage(res); }
  if (!p || p.endsWith("/")) p += "index.html";
  const content = project.files[p.toLowerCase()];
  if (content === undefined) return notFoundPage(res);
  res.writeHead(200, {
    "Content-Type": MIME[p.split(".").pop().toLowerCase()] || "text/plain; charset=utf-8",
    "Content-Security-Policy": SANDBOX_CSP, "Referrer-Policy": "no-referrer",
    "Cache-Control": isPreview ? "no-store" : "no-cache", ...SEC_HEADERS,
  });
  res.end(content);
}

const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 28).replace(/^-|-$/g, "") || "site";
function uniqueSlug(name) {
  let slug;
  do { slug = slugify(name) + "-" + crypto.randomBytes(2).toString("hex"); } while (db.projects.some((p) => p.slug === slug));
  return slug;
}
const projectSummary = (p) => ({ id: p.id, name: p.name, slug: p.slug, url: `/s/${p.slug}/`, published: p.published, files: Object.keys(p.files).length, created: p.created, updated: p.updated });
const PREVIEW_SECRET = crypto.randomBytes(32);
const previewToken = (id) => crypto.createHmac("sha256", PREVIEW_SECRET).update(id).digest("hex").slice(0, 24);
const projectView = (p) => ({ ...projectSummary(p), preview: `/p/${p.id}/${previewToken(p.id)}/`, files: p.files, messages: p.history });

// Minimal ZIP writer (stored, no compression) so users can download their code without any dependency.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [name, content] of Object.entries(files)) {
    const nb = Buffer.from(name), data = Buffer.from(content, "utf8"), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cen = Buffer.concat(central), end = Buffer.alloc(22), n = central.length / 2;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cen.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cen, end]);
}

/* ======================= Dashboard API (/auth/*, /api/*) ======================= */
function buildStats(user) {
  const keys = db.keys.filter((k) => k.userId === user.id && !k.revoked);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ date, chat: keys.reduce((s, k) => s + dayOf(k, date).chat, 0), image: keys.reduce((s, k) => s + dayOf(k, date).image, 0) });
  }
  const sum = (f) => keys.reduce((s, k) => s + f(k), 0);
  return {
    days,
    totals: { chat: sum((k) => k.totals.chat), image: sum((k) => k.totals.image), errors: sum((k) => k.totals.errors), keys: keys.length, sites: db.projects.filter((p) => p.userId === user.id).length },
    today: { chat: sum((k) => dayOf(k).chat), image: sum((k) => dayOf(k).image) },
    perKey: keys.map((k) => ({ id: k.id, name: k.name, chat: k.totals.chat, image: k.totals.image, errors: k.totals.errors })),
    recent: db.logs.filter((l) => l.userId === user.id).slice(-25).reverse(),
  };
}
const configInfo = () => ({
  chatPerDay: CHAT_PER_DAY, imagesPerDay: IMAGES_PER_DAY, perMinute: PER_MINUTE, buildsPerDay: BUILDS_PER_DAY,
  geminiConfigured: !!GEMINI_KEY,
  models: { smart: workingModel.smart || MODELS.smart[0], fast: workingModel.fast || MODELS.fast[0], image: workingModel.image || MODELS.image[0] },
});

async function dashboardApi(req, res, url, ip) {
  const isRead = req.method === "GET";
  if (!isRead && !(req.headers["content-type"] || "").includes("application/json")) return send(res, 415, { error: "Use Content-Type: application/json" });
  const heavy = url === "/api/playground";
  const b = isRead || req.method === "DELETE" ? {} : await readBody(req, heavy ? BIG_BODY : SMALL_BODY);

  if (url === "/auth/signup" && req.method === "POST") {
    if (authThrottled(ip)) return send(res, 429, { error: "Too many attempts. Try again later." });
    const email = String(b.email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { error: "Enter a valid email address" });
    if (String(b.password || "").length < 8) return send(res, 400, { error: "Password must be at least 8 characters" });
    if (db.users.some((u) => u.email === email)) return send(res, 400, { error: "This email is already registered" });
    const salt = crypto.randomBytes(16).toString("hex");
    const user = { id: uid(), email, salt, hash: hashPw(b.password, salt), created: Date.now() };
    db.users.push(user);
    return send(res, 200, { email }, startSession(user));
  }
  if (url === "/auth/login" && req.method === "POST") {
    if (authThrottled(ip)) return send(res, 429, { error: "Too many attempts. Try again later." });
    const user = db.users.find((u) => u.email === String(b.email || "").trim().toLowerCase());
    if (!user || !verifyPw(user, b.password)) return send(res, 401, { error: "Incorrect email or password" });
    return send(res, 200, { email: user.email }, startSession(user));
  }
  if (url === "/auth/logout" && req.method === "POST") {
    const t = sessionToken(req);
    if (t) { delete db.sessions[t]; save(); }
    return send(res, 200, { ok: true }, { "Set-Cookie": "orv_session=; Path=/; Max-Age=0" });
  }

  const user = sessionUser(req);
  if (!user) return send(res, 401, { error: "Please sign in" });
  const myKey = (id) => db.keys.find((k) => k.id === id && k.userId === user.id && !k.revoked);

  if (url === "/auth/me") return send(res, 200, { email: user.email, created: user.created });
  if (url === "/auth/password" && req.method === "POST") {
    if (!verifyPw(user, b.current)) return send(res, 400, { error: "Current password is incorrect" });
    if (String(b.next || "").length < 8) return send(res, 400, { error: "New password must be at least 8 characters" });
    user.salt = crypto.randomBytes(16).toString("hex"); user.hash = hashPw(b.next, user.salt); save();
    return send(res, 200, { ok: true });
  }
  if (url === "/auth/delete" && req.method === "POST") {
    if (!verifyPw(user, b.password)) return send(res, 400, { error: "Password is incorrect" });
    db.keys = db.keys.filter((k) => k.userId !== user.id);
    db.users = db.users.filter((u) => u.id !== user.id);
    for (const t of Object.keys(db.sessions)) if (db.sessions[t] === user.id) delete db.sessions[t];
    db.logs = db.logs.filter((l) => l.userId !== user.id);
    db.projects = db.projects.filter((p) => p.userId !== user.id); save();
    return send(res, 200, { ok: true }, { "Set-Cookie": "orv_session=; Path=/; Max-Age=0" });
  }

  if (url === "/api/config") return send(res, 200, configInfo());
  if (url === "/api/stats") return send(res, 200, buildStats(user));
  if (url === "/api/keys" && req.method === "GET")
    return send(res, 200, { keys: db.keys.filter((k) => k.userId === user.id && !k.revoked).map(publicKey) });
  if (url === "/api/keys" && req.method === "POST") {
    if (db.keys.filter((k) => k.userId === user.id && !k.revoked).length >= MAX_KEYS_PER_USER)
      return send(res, 400, { error: `You can have at most ${MAX_KEYS_PER_USER} keys` });
    const k = { id: uid(), userId: user.id, key: newKeyString(), name: "My site", systemPrompt: "", origins: [], model: "smart", images: true, webSearch: false, usage: {}, totals: { chat: 0, image: 0, errors: 0 }, created: Date.now(), revoked: false };
    applyKeySettings(k, b);
    db.keys.push(k); save();
    return send(res, 200, { key: publicKey(k) });
  }

  if (url === "/api/playground" && req.method === "POST") {
    const key = myKey(b.keyId);
    if (!key) return send(res, 404, { error: "Select an API key first" });
    if (!GEMINI_KEY) return send(res, 500, { error: "The server has no GEMINI_API_KEY configured" });
    return handleChat(req, res, "playground", key, b);
  }

  // ---- Site builder ----
  const mine = () => db.projects.filter((p) => p.userId === user.id);
  if (url === "/api/projects" && req.method === "GET")
    return send(res, 200, { projects: mine().sort((a, b) => b.updated - a.updated).map(projectSummary), buildsLeft: Math.max(0, BUILDS_PER_DAY - buildQuota(user).count) });
  if (url === "/api/projects" && req.method === "POST") {
    const prompt = String(b.prompt || "").trim().slice(0, 8000);
    if (!prompt) return send(res, 400, { error: "Describe the site you want" });
    if (!GEMINI_KEY) return send(res, 500, { error: "The server has no GEMINI_API_KEY configured" });
    if (mine().length >= MAX_PROJECTS) return send(res, 400, { error: `You can have at most ${MAX_PROJECTS} sites. Delete one first.` });
    const block = canBuild(user);
    if (block) return send(res, block.status, { error: block.error });
    const name = String(b.name || "").trim().slice(0, 60) || prompt.slice(0, 40);
    const project = { id: uid(), userId: user.id, name, slug: uniqueSlug(name), files: {}, history: [], published: true, created: Date.now(), updated: Date.now() };
    db.projects.push(project);
    const job = startBuild(user, project, prompt);
    return send(res, 200, { project: projectSummary(project), jobId: job.id });
  }
  const pm = url.match(/^\/api\/projects\/([a-f0-9]+)(?:\/(build|download))?$/);
  if (pm) {
    const p = mine().find((x) => x.id === pm[1]);
    if (!p) return send(res, 404, { error: "Site not found" });
    if (pm[2] === "download" && req.method === "GET") {
      if (!Object.keys(p.files).length) return send(res, 400, { error: "This site has no files yet" });
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${p.slug}.zip"`, ...SEC_HEADERS });
      return res.end(makeZip(p.files));
    }
    if (pm[2] === "build" && req.method === "POST") {
      const prompt = String(b.prompt || "").trim().slice(0, 8000);
      if (!prompt) return send(res, 400, { error: "Tell me what to change" });
      if (!GEMINI_KEY) return send(res, 500, { error: "The server has no GEMINI_API_KEY configured" });
      const block = canBuild(user, p);
      if (block) return send(res, block.status, { error: block.error });
      return send(res, 200, { jobId: startBuild(user, p, prompt).id });
    }
    if (!pm[2] && req.method === "GET") return send(res, 200, { project: projectView(p) });
    if (!pm[2] && req.method === "PATCH") {
      if (b.name !== undefined) p.name = String(b.name).trim().slice(0, 60) || p.name;
      if (b.published !== undefined) p.published = !!b.published;
      save();
      return send(res, 200, { project: projectSummary(p) });
    }
    if (!pm[2] && req.method === "DELETE") { db.projects = db.projects.filter((x) => x !== p); save(); return send(res, 200, { ok: true }); }
  }
  const jm = url.match(/^\/api\/jobs\/([a-f0-9]+)$/);
  if (jm) {
    const j = jobs.get(jm[1]);
    if (!j || j.userId !== user.id) return send(res, 404, { error: "Job not found" });
    return send(res, 200, { status: j.status, step: j.step, error: j.error, result: j.result });
  }

  const m = url.match(/^\/api\/keys\/([a-f0-9]+)(\/rotate)?$/);
  if (m) {
    const k = myKey(m[1]);
    if (!k) return send(res, 404, { error: "Key not found" });
    if (m[2] && req.method === "POST") { k.key = newKeyString(); save(); return send(res, 200, { key: publicKey(k) }); }
    if (req.method === "DELETE") { k.revoked = true; save(); return send(res, 200, { ok: true }); }
    if (req.method === "PATCH") { applyKeySettings(k, b); save(); return send(res, 200, { key: publicKey(k) }); }
  }
  send(res, 404, { error: "Not found" });
}

/* ======================= Server ======================= */
const file = (name) => fs.readFileSync(path.join(__dirname, name));
http
  .createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    try {
      if (req.method === "OPTIONS" && url.startsWith("/v1/")) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": req.headers.origin || "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Max-Age": "86400",
        });
        return res.end();
      }
      if (req.method === "POST" && url === "/v1/chat") return await handleChat(req, res);
      if (req.method === "POST" && url === "/v1/images") return await handleImages(req, res);
      const sm = url.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/); // published sites
      if (sm && (req.method === "GET" || req.method === "HEAD")) {
        const p = db.projects.find((x) => x.slug === sm[1] && x.published);
        if (!p) return notFoundPage(res);
        if (!sm[2]) { res.writeHead(301, { Location: `/s/${p.slug}/` }); return res.end(); }
        return serveProject(res, p, sm[2], false);
      }
      // Owner preview (works for unpublished sites). The link carries a secret token because the sandboxed frame cannot send cookies.
      const pv = url.match(/^\/p\/([a-f0-9]+)\/([a-f0-9]{24})(\/.*)?$/);
      if (pv && (req.method === "GET" || req.method === "HEAD")) {
        const p = db.projects.find((x) => x.id === pv[1]);
        const a = Buffer.from(pv[2]), c = Buffer.from(p ? previewToken(p.id) : "0".repeat(24));
        if (!p || a.length !== c.length || !crypto.timingSafeEqual(a, c)) return notFoundPage(res);
        if (!pv[3]) { res.writeHead(301, { Location: `/p/${p.id}/${pv[2]}/` }); return res.end(); }
        return serveProject(res, p, pv[3], true);
      }
      if (url === "/widget.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300", ...SEC_HEADERS });
        return res.end(file("widget.js"));
      }
      if (url.startsWith("/auth/") || url.startsWith("/api/")) return await dashboardApi(req, res, url, clientIp(req));
      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", ...SEC_HEADERS });
        return res.end(file("index.html"));
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent) send(res, errorStatus(e), { error: friendlyError(e) });
    }
  })
  .listen(PORT, () => {
    console.log(`Orivoclass is running on http://localhost:${PORT}`);
    if (!GEMINI_KEY) console.log("Warning: GEMINI_API_KEY is not set. Add it to .env to enable the AI.");
  });
