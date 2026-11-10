# Orivoclass

An AI platform built on Google's Gemini API. People sign up, create API keys in a dashboard, and add a human-like assistant to their own site. It answers in any language, understands images, creates images from descriptions, writes code, and can build and host whole websites.

## Files
- `server.js` - the server (Node 18+, no dependencies): auth, dashboard API, `/v1/chat`, `/v1/images`, site builder and hosting
- `index.html` - the dashboard (Overview, Playground, Sites, API Keys, Docs, Settings)
- `widget.js` - the embeddable chat widget
- `.env.example` - copy to `.env` and fill in
- `data.json` - the database, created automatically

## Run it
1. Get a Gemini API key: https://aistudio.google.com/apikey
2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY`.
3. `node server.js`
4. Open http://localhost:3000, sign up, create a key, try the Playground and the Sites tab.

## Coding and the site builder
- **Code in chat:** the assistant writes complete, runnable code in code blocks and mentally checks it before answering.
- **Sites tab:** describe a website or web app. The AI writes it, then Orivoclass **checks it automatically** (JavaScript syntax, unbalanced tags and CSS, broken file links, missing element ids, absolute paths, invalid JSON), asks the AI to fix whatever it finds, runs a second **self-review pass** as a strict QA engineer, and checks again. The result tells you honestly whether the checks passed.
- You get a **live link** (`/s/<name>/`), a **live preview**, the **full code** (copy per file or download a `.zip`), and a chat to ask for changes ("make the header blue", "add a pricing section"). You can unpublish a site at any time.
- No AI can promise zero mistakes. These checks catch the common ones, and you can always ask the AI to fix something you see.

### How hosting is kept safe
Hosted sites are served with a Content-Security-Policy sandbox. They run in their own isolated origin, so a site can never read the dashboard, your cookies or your API keys. The side effect is that hosted pages cannot use `localStorage`/cookies (the builder is told to avoid them). Before opening this to the public, serve sites from a separate domain and add abuse reporting.

## How the AI works
- **Smart mode** uses the strongest Gemini model for deep reasoning; **Fast mode** uses a quicker one. Each key picks its own. Coding always uses the smart model.
- The assistant replies in the user's language and dialect, with a natural human tone.
- When a user asks for a picture, the model calls an image tool and Gemini's image model draws it. Users can also send images to be described, read or edited.
- Optional per key: web search for fresh information, custom instructions, image generation on/off.
- Model names are tried in order and fall back automatically if one is unavailable. Override with `GEMINI_SMART_MODEL`, `GEMINI_FAST_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_CODE_MODEL`.

## Add it to a website
```html
<script src="https://YOUR-HOST/widget.js" data-key="orv_..." defer></script>
```
Optional: `data-title`, `data-color`, `data-greeting`, `data-position="left|right"`.

## API
```bash
curl https://YOUR-HOST/v1/chat \
  -H "Authorization: Bearer orv_..." -H "Content-Type: application/json" \
  -d '{"message":"Draw a sunset over Mount Kenya"}'
# -> { "reply": "...", "images": [{ "mimeType": "image/png", "data": "<base64>" }], "sources": [] }

curl https://YOUR-HOST/v1/images \
  -H "Authorization: Bearer orv_..." -H "Content-Type: application/json" \
  -d '{"prompt":"A friendly robot teacher, watercolor"}'
```
For conversations send `messages: [{ "role": "user"|"model", "text": "...", "images": [...] }]`.

## Before going public
- Serve over HTTPS and set `COOKIE_SECURE=1` (and `TRUST_PROXY=1` behind a proxy).
- Keys placed in web pages are visible to visitors, so set "Allowed sites" on each key. Limits: `CHAT_PER_DAY`, `IMAGES_PER_DAY`, `PER_MINUTE`, `BUILDS_PER_DAY`, `MAX_PROJECTS`.
- Builds can take a few minutes for big sites. If you put a reverse proxy in front, the dashboard polls for progress, so long builds do not hit proxy timeouts.
- `data.json` is fine to start; move to a real database as users grow.
- Next: payments with Paystack (plans, usage limits per plan).
