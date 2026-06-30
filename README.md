# FinFluency — Deploy to Vercel (installable PWA)

```
index.html             <- the app (PWA-enabled)
manifest.webmanifest   <- app name, icons, colors
sw.js                  <- service worker (offline + installable)
icons/                 <- app icons (192, 512, apple-touch)
api/financials.js      <- data proxy: SEC EDGAR first, AI fallback
README.md              <- this file
```

## Data lookup
- **Primary: SEC EDGAR** — official, free, no API key, every US filer. Real reported figures.
- **Fallback: Anthropic web search** — only for non-US tickers, and only if you set a key.
- **Last resort:** built-in verified sample, so it never breaks.

You can deploy with **no API key** and get real data for the entire US market.

## Deploy
1. ~~Set a real contact email in `api/financials.js`~~ — done (`dan.wain1@gmail.com`).
2. Put all files in a GitHub repo — keep `financials.js` inside `api/`, `icons/` intact, and `vercel.json` at the root.
3. **Vercel → Add New → Project → Import** that repo → **Deploy** (no build settings needed — it's a static site + serverless function, auto-detected).
4. (Optional) Add env var `ANTHROPIC_API_KEY` to enable the non-US fallback, then redeploy.

Progress (XP, level, streak, Vault) now saves automatically to each user's device via `localStorage`; a **Reset all progress** button sits at the bottom of the Path screen.

CLI alternative: `npm i -g vercel`, then `vercel --prod` from this folder.

---

## It's now an installable app (PWA)
Once it's live on your Vercel URL (HTTPS), anyone can install it to their home screen —
no App Store, no download, instant updates whenever you redeploy.

**iPhone / iPad (Safari):** open the URL → Share button → **Add to Home Screen** → Add.
**Android (Chrome):** open the URL → menu (⋮) → **Install app** (or "Add to Home screen").

It then launches full-screen with the wizard-Finn icon, like a native app, and the
curriculum works offline (the live Company Challenge needs a connection).

### Roll it out to the team
Just send reps the Vercel URL with the one-line install instruction above. To make it
cleaner, you can later add a custom domain in Vercel (e.g. finfluency.yourcompany.com) and,
if you want it private, turn on Vercel password protection or simple auth.

---

## Notes
- After you change the app and redeploy, bump `finfluency-v1` to `finfluency-v2` in `sw.js`
  so users pick up the new version (the service worker caches the old one otherwise).
- EDGAR field coverage varies by company; the quiz only asks what the data supports.
- Pulled figures are real filings, but verify against the source before client use.
