# Deploying DontFixYourSEO.com to Cloudflare Pages (with the real website checker)

This folder is the whole site. Two pieces:

- `index.html` — the page itself (same one you've already been previewing).
- `functions/api/check.js` — a small piece of server code that does a **real** check of whatever website address someone types in, instead of the random illustrative demo.

**Nothing breaks if you skip the setup below.** If the check tool ever can't reach `functions/api/check.js`, it automatically falls back to the same illustrative demo you've been testing — visitors never see an error, they just see the old placeholder result. So you can deploy now and add the extras later, in your own time.

---

## Step 1 — Get the site live (required)

Cloudflare Pages has two ways to upload a site. **You need the Git-connected way**, not the drag-and-drop one — drag-and-drop doesn't support the `functions` folder, which means the real checker would never run (it'd just always show the illustrative demo, forever).

1. Put this folder in a GitHub repository (if you don't already have one, GitHub's own "upload files" button in a new repo works fine — you don't need to use git from a terminal).
2. In the Cloudflare dashboard, go to **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
3. Pick the repository you just created.
4. Build settings: leave the build command blank and set the output directory to `/` (this is a plain HTML site, nothing needs building).
5. Click **Save and Deploy**.

Cloudflare gives you a free `something.pages.dev` address immediately. Once you're happy, you can point your real `dontfixyourseo.com` domain at it from the same project's **Custom domains** tab.

At this point the site is live and fully working — enquiries go to Formspree exactly as they do in the preview, and the check tool shows the illustrative demo (same as now). Everything below is optional and can be done whenever you're ready.

---

## Step 2 — Turn on the real website checker (optional, free)

This is what makes the check tool look at the actual site someone types in — real title, real contact details, real Google-style trust signals — instead of a canned example. No extra account needed on your end beyond what you already have.

**It already works with zero setup for most of it.** The moment the site is deployed via Git (Step 1), `functions/api/check.js` starts running automatically and does real checks — page title, description, headings, structured business/review data, contact details, robots.txt/sitemap.xml. You'll see the check tool's footnote change from *"Illustrative preview…"* to *"Real check of [site] — based on what we could automatically find on the page."*

The two extras below just make that real check *better* — they're both optional.

### Optional extra A — real mobile speed score (Google PageSpeed Insights)

Free, no card needed.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and sign in with any Google account.
2. Create a new project (top-left project picker → New Project → any name, e.g. "DontFixYourSEO").
3. Search for **"PageSpeed Insights API"** in the top search bar and click **Enable**.
4. Go to **APIs & Services → Credentials → Create Credentials → API key**. Copy the key it gives you.
5. In Cloudflare, open your Pages project → **Settings → Variables and Secrets → Add**. Name: `PAGESPEED_API_KEY`. Value: paste the key. Tick **Encrypt**. Save.
6. Redeploy (Cloudflare usually does this automatically after a settings change — if not, hit "Retry deployment" on the latest deployment).

From then on, real checks include an actual mobile speed score from Google.

### Optional extra B — an AI-written line on "AI search readiness" (Claude API)

This is the one genuinely subjective part of the check — is the page written in a way an AI assistant like ChatGPT or Claude could actually understand and recommend. Everything else on this list is a plain yes/no check a script can do; this one needs an LLM to actually read the page.

**This one isn't free** — it's a normal pay-as-you-go API, roughly fractions of a cent per check at the volumes a small local site would see, but it does need a card on file.

1. Go to [console.anthropic.com](https://console.anthropic.com/) and create an account.
2. Add billing details and create an API key under **API Keys**.
3. In Cloudflare, same as above: **Settings → Variables and Secrets → Add**. Name: `ANTHROPIC_API_KEY`. Value: your key. Tick **Encrypt**. Save. Redeploy.

If you'd rather not do this one, skip it — the check tool works fine without it, just without that one AI-written sentence.

---

## How to check it's working

Once deployed, open the live site, type in a real website address (your own is a good test — try `homedesignproducts.co.uk`), and click **Check My Website**. Look at the small line under the four results:

- **"Illustrative preview…"** → the real checker isn't running yet (Step 1 not using Git deploy, or `functions/api/check.js` didn't deploy) — everything still works, it's just the placeholder.
- **"Real check of [site] — based on what we could automatically find…"** → it's working. If you also set up the PageSpeed key, you'll see a speed score in that same line; with the Claude key, you'll also see a one-line AI-search comment.

---

## What "real" actually checks

No API key needed for any of this — it's just reading the page's own code:

- Does the site have a sitemap.xml, robots.txt, and use HTTPS
- Page title and meta description present and sensible length
- A proper heading structure
- Structured business/review data (the "schema.org" markup that helps Google and AI tools understand who you are)
- A findable phone number, contact link, or contact form
- Whether the page is set up for mobile (viewport tag)

This is genuinely useful, but it's not the same as the full plain-English report you review and send yourself — that's still the manual, human part of the process, same as you've planned. Think of this as a smarter, honest first impression instead of a random one.
