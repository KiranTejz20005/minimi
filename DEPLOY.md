# Deploying: backend on Render, frontend on Vercel

The backend (API + agent) and the frontend (landing page + chat UI) deploy separately. Do it in this order, because each side needs the other's URL:

1. Backend on Render → you get `https://<api>.onrender.com`
2. Frontend on Vercel, pointed at that URL → you get `https://<app>.vercel.app`
3. Tell the backend about the frontend URL (CORS)

You need: the repo on GitHub, an LLM key (NVIDIA NIM or Anthropic), and a Tavily key (optional but recommended).

---

## 1. Backend → Render

The repo includes a Blueprint ([render.yaml](render.yaml)), so this is mostly clicking.

1. Push the repo to GitHub.
2. Render dashboard → **New → Blueprint** → connect the repo → select it. Render reads `render.yaml` and proposes a web service named `minimi-api`.
3. It asks for the three secrets (marked `sync: false`):
   - `NVIDIA_API_KEY` (or leave it blank and add `ANTHROPIC_API_KEY` under Environment afterwards)
   - `TAVILY_API_KEY`
   - `CORS_ORIGIN`: put a placeholder like `https://placeholder.vercel.app` for now; you set the real value in step 3.
4. **Apply**. First build takes a few minutes.
5. Check it: open `https://<api>.onrender.com/health`. You should see `{"ok":true,"hasLlm":true,"hasSearch":true,...}`. If `hasLlm` is `false`, the LLM key is missing or wrong.

Prefer manual setup over the Blueprint? New → **Web Service** → repo, then:

| Field | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm run start:prod` |
| Health check path | `/health` |
| Environment | `NODE_VERSION=22`, `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, `CORS_ORIGIN`, plus your keys |

Render supplies `PORT` itself; the server reads it.

**Free plan caveats.** The service sleeps after ~15 min idle (the first request afterwards takes about a minute to wake it), and its disk is **wiped on every restart or redeploy**, so chat history and the memory database are lost. For history that survives, use a paid plan, add a Disk mounted at `/var/data`, and set `DB_PATH=/var/data/agent.db` (the commented `disk:` block in `render.yaml`).

## 2. Frontend → Vercel

1. Vercel dashboard → **Add New → Project** → import the same repo.
2. Leave **Root Directory** as the repo root. The settings come from [vercel.json](vercel.json) (build `npm run build:vercel`, output `dist-web`); if Vercel shows a framework preset, choose **Other**.
3. Under **Environment Variables** add:

   | Name | Value |
   |---|---|
   | `API_URL` | `https://<api>.onrender.com` (the Render URL from step 1; no trailing slash, no path) |

4. **Deploy**. When it finishes you get `https://<app>.vercel.app`: the landing page is at `/`, the chat UI at `/app`.

`API_URL` is baked into the JavaScript at **build time**. If you change it later, you must **redeploy** (Deployments → ⋯ → Redeploy); editing the variable alone does nothing.

## 3. Connect them (CORS)

Back in Render → your service → **Environment** → set

```
CORS_ORIGIN=https://<app>.vercel.app
```

Several origins (for example a custom domain too) go comma-separated, with no path and no trailing slash. Render redeploys automatically when you save.

## 4. Verify

- `https://<app>.vercel.app/app` loads and the sidebar appears.
- Send a message; the answer streams in.
- Browser DevTools → Console has no `CORS` errors.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Console: `blocked by CORS policy` | `CORS_ORIGIN` on Render doesn't exactly match the browser's origin (scheme + host, no trailing path). Vercel **preview** URLs differ from the production URL and aren't allowed unless you add them. |
| UI loads but every request fails / "Network error" | `API_URL` was wrong or set after the build. Fix it and **redeploy** the Vercel project. |
| First message hangs ~1 min, then works | Render free plan waking from sleep. |
| History disappears | Render free plan has no persistent disk (see above). |
| Everything returns `401` | `ACCESS_TOKEN` is set on Render. Remove it for this split setup (see Security). |
| Vercel build fails with `API_URL must be set` | Add the variable for the Production (and Preview) environment, then redeploy. |

## Security: read this before sharing the URL

In a split deployment the browser can't use the server's HTTP Basic-auth gate, so **the API is publicly reachable**. What protects it today:

- CORS only stops *other websites' browsers*, not direct callers. It is not authentication.
- A per-IP rate limit (`RATE_LIMIT_PER_MIN`, default 30 chat requests/minute).

What that means in practice: anyone who finds the URL can spend your LLM and Tavily quota, and anyone can read, add or delete conversations (there are no user accounts). The Integrations screen also lets a visitor **replace or clear the Tavily key**. That is fine for a demo or evaluation link; for anything longer-lived, add real authentication first, or keep the single-server deployment (`ACCESS_TOKEN` set), which does gate everything.
