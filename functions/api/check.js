

// Cloudflare Pages Function — real website check
// Route: POST /api/check   Body: { "url": "example.co.uk" }
//
// Works with ZERO configuration: fetches the site itself plus robots.txt /
// sitemap.xml / llms.txt, and scores it on real, rule-based signals mapped
// onto the same four questions used on the page (find / understand / trust /
// act). Two optional upgrades, enabled only if you add the matching
// environment variable in the Cloudflare Pages project settings:
//
//   PAGESPEED_API_KEY   -> adds real Core Web Vitals / mobile-speed scoring
//                          via Google's PageSpeed Insights API (free).
//   ANTHROPIC_API_KEY   -> adds one AI-written sentence judging whether an
//                          AI search assistant (ChatGPT, Claude, etc.) could
//                          understand and recommend the business from the
//                          page content.
//
// Neither key is required for this to return real, non-random results.

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Send a JSON body like {"url":"yourbusiness.co.uk"}' }, 400);
  }

  let targetUrl = (body.url || '').trim();
  if (!targetUrl) return json({ error: 'No URL provided' }, 400);
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return json({ error: 'That doesn’t look like a valid website address' }, 400);
  }

  const origin = parsed.origin;

  // Fetch the page itself (this is the one fetch we really need).
  let html = '';
  let fetchOk = false;
  try {
    const pageRes = await fetchWithTimeout(targetUrl, 9000);
    fetchOk = pageRes.ok;
    if (pageRes.ok) html = await pageRes.text();
  } catch (e) {
    // fall through — fetchOk stays false, we still return a (limited) result
  }

  if (!fetchOk) {
    return json({
      error: 'Could not load that website',
      message: 'We couldn’t reach ' + parsed.hostname + '. Double-check the address and that the site is live.',
      real: true,
    }, 200);
  }

  // Secondary fetches — best-effort, never block the result on these.
  const [robotsRes, sitemapRes, llmsRes] = await Promise.all([
    fetchWithTimeout(origin + '/robots.txt', 5000).catch(() => null),
    fetchWithTimeout(origin + '/sitemap.xml', 5000).catch(() => null),
    fetchWithTimeout(origin + '/llms.txt', 5000).catch(() => null),
  ]);

  const signals = analyzeHtml(html, origin);
  signals.https = parsed.protocol === 'https:';
  signals.robotsPresent = !!(robotsRes && robotsRes.ok);
  signals.sitemapPresent = !!(sitemapRes && sitemapRes.ok);
  signals.llmsTxtPresent = !!(llmsRes && llmsRes.ok);

  // Optional: real page-speed / mobile data.
  let pageSpeed = null;
  if (env.PAGESPEED_API_KEY) {
    pageSpeed = await fetchPageSpeed(targetUrl, env.PAGESPEED_API_KEY).catch(() => null);
  }

  // Optional: one AI-written sentence on AI-search readiness.
  let aiNote = null;
  if (env.ANTHROPIC_API_KEY) {
    aiNote = await scoreWithClaude(html, parsed.hostname, env.ANTHROPIC_API_KEY).catch(() => null);
  }

  const result = buildResult(signals, pageSpeed, aiNote, parsed.hostname);
  return json(result, 200);
}

// ---------- helpers ----------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function fetchWithTimeout(url, ms, options) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'DontFixYourSEO-Checker/1.0 (+https://dontfixyourseo.com)', ...(options && options.headers) },
    });
  } finally {
    clearTimeout(t);
  }
}

// Recognised same-site route slugs for a dedicated contact/enquiry page.
// Matched against the LAST path segment only (so /contact, /en/contact,
// /pages/contact-us.html, etc. all match) — deliberately NOT matched against
// arbitrary substrings of the path or against surrounding page text, so an
// unrelated page merely mentioning "contact" or "support" cannot qualify.
const CONTACT_PATH_SLUGS = new Set([
  'contact', 'contact-us', 'contactus', 'contact_us',
  'support',
  'get-in-touch', 'getintouch', 'get_in_touch',
  'enquire', 'enquiry', 'enquiries', 'inquire', 'inquiry', 'inquiries',
  'book', 'booking',
  'consultation', 'consultations',
  'request-a-quote', 'requestaquote', 'request_a_quote',
]);

// Does this page link to a dedicated contact/enquiry page on the SAME site?
// e.g. <a href="/contact">Contact & Support</a> on the homepage.
//
// This is deliberately conservative and link-based only (no surrounding-text
// matching, no substring matching): a genuine <a href> is required, it must
// resolve (relative or absolute) to the site's own origin, and its final
// path segment must be an exact match against CONTACT_PATH_SLUGS. That's
// enough to recognise normal contact-page architecture without being fooled
// by "#" placeholders, javascript: handlers, or ordinary copy that merely
// mentions the word "contact"/"support" near an unrelated link.
export function hasInternalContactLink(html, origin) {
  if (!origin) return false;

  let originHost;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch (e) {
    return false;
  }

  const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(html))) {
    const rawHref = (m[1] || '').trim();
    if (!rawHref || rawHref.startsWith('#')) continue; // no destination / same-page anchor
    if (/^(javascript|mailto|tel):/i.test(rawHref)) continue; // handled separately, or not navigable

    let resolved;
    try {
      resolved = new URL(rawHref, origin);
    } catch (e) {
      continue; // malformed href — skip rather than fail the whole check
    }

    if (resolved.hostname.toLowerCase() !== originHost) continue; // off-site link

    const segments = resolved.pathname.split('/').filter(Boolean);
    if (!segments.length) continue; // links back to the homepage itself don't count

    const slug = segments[segments.length - 1]
      .toLowerCase()
      .replace(/\.(html?|php|aspx?|jsp)$/i, ''); // ignore a trailing file extension

    if (CONTACT_PATH_SLUGS.has(slug)) return true;
  }
  return false;
}

// Pull real, checkable signals out of the raw HTML. No API key needed —
// this is the core of what makes results genuine rather than illustrative.
// `origin` (e.g. "https://example.co.uk") is optional but needed to resolve
// relative links for the internal-contact-page check below; when omitted,
// that one signal is simply skipped rather than throwing.
export function analyzeHtml(html, origin) {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const textOnly = stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };

  const title = get(/<title[^>]*>([^<]*)<\/title>/i);
  const metaDesc = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || get(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const ogTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;

  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]);
  const schemaTypes = [];
  jsonLdBlocks.forEach((block) => {
    try {
      const data = JSON.parse(block);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      items.forEach((item) => {
        if (item && item['@type']) {
          const t = item['@type'];
          (Array.isArray(t) ? t : [t]).forEach((tt) => schemaTypes.push(String(tt)));
        }
      });
    } catch (e) { /* ignore malformed JSON-LD */ }
  });

  const hasLocalBusinessSchema = schemaTypes.some((t) => /LocalBusiness|Organization|Store|HomeAndConstructionBusiness|ProfessionalService/i.test(t));
  const hasReviewSchema = schemaTypes.some((t) => /Review|AggregateRating/i.test(t));
  const hasFaqSchema = schemaTypes.some((t) => /FAQPage/i.test(t));

  const phonePresent = /(\+?\d[\d\s().-]{7,}\d)/.test(textOnly) || /href=["']tel:/i.test(html);
  const mailtoLink = /href=["']mailto:/i.test(html);
  const telLink = /href=["']tel:/i.test(html);
  const contactFormPresent = /<form[\s\S]*?<\/form>/i.test(html);
  const addressHint = /\b(street|st\.|road|rd\.|avenue|ave\.|lane|drive|way)\b/i.test(textOnly);
  const internalContactLinkPresent = hasInternalContactLink(html, origin);

  return {
    title, titleLength: title ? title.length : 0,
    metaDesc, metaDescLength: metaDesc ? metaDesc.length : 0,
    viewport, canonical, ogTitle, h1Count,
    schemaTypes, hasLocalBusinessSchema, hasReviewSchema, hasFaqSchema,
    phonePresent, mailtoLink, telLink, contactFormPresent, addressHint,
    internalContactLinkPresent,
  };
}

async function fetchPageSpeed(url, apiKey) {
  const api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + '?url=' + encodeURIComponent(url)
    + '&key=' + apiKey
    + '&strategy=mobile&category=performance&category=seo&category=accessibility';
  const res = await fetchWithTimeout(api, 20000);
  if (!res.ok) return null;
  const data = await res.json();
  const lr = data.lighthouseResult;
  if (!lr || !lr.categories) return null;
  const pct = (c) => (lr.categories[c] && typeof lr.categories[c].score === 'number')
    ? Math.round(lr.categories[c].score * 100) : null;
  return {
    performance: pct('performance'),
    seo: pct('seo'),
    accessibility: pct('accessibility'),
  };
}

async function scoreWithClaude(html, hostname, apiKey) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  if (!text) return null;

  const prompt = 'You are assessing whether a small local business website (' + hostname + ') is easy '
    + 'for an AI search assistant (like ChatGPT or Claude) to understand and recommend to a customer. '
    + 'Based only on the extracted page text below, reply with ONLY a JSON object, no other text: '
    + '{"score":"green"|"amber"|"red","reason":"one short plain-English sentence, max 20 words"}. '
    + 'Page text:\n\n' + text;

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', 20000, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const raw = data && data.content && data.content[0] && data.content[0].text;
  if (!raw) return null;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    if (parsed && parsed.score) return parsed;
  } catch (e) { /* ignore — aiNote stays unused */ }
  return null;
}

// Turn real signals into the same shape the page's front-end already
// expects: an overall badge + 4 rows (find / understand / trust / act).
// Exported (additively — call sites elsewhere in this file are unaffected)
// so it can be unit-tested directly against synthetic signal objects.
export function buildResult(s, pageSpeed, aiNote, hostname) {
  const rows = [];

  // 1) Can customers find you?
  {
    const points = [];
    let level = 'green';
    if (!s.canonical) points.push('no canonical link tag');
    if (!s.sitemapPresent) points.push('no sitemap.xml found');
    if (!s.robotsPresent) points.push('no robots.txt found');
    if (!s.https) points.push('site isn’t on HTTPS');
    if (points.length >= 2) level = 'red';
    else if (points.length === 1) level = 'amber';
    const note = points.length
      ? points.join(', ')
      : (s.llmsTxtPresent ? 'sitemap and robots.txt in place, even has an llms.txt' : 'sitemap and robots.txt are in place');
    rows.push([level, capitalize(note)]);
  }

  // 2) Do customers understand you?
  {
    const points = [];
    let level = 'green';
    if (!s.title || s.titleLength < 10) points.push('page title is missing or too short');
    if (!s.metaDesc) points.push('no meta description');
    else if (s.metaDescLength < 50 || s.metaDescLength > 165) points.push('meta description isn’t a useful length');
    if (s.h1Count === 0) points.push('no main heading (H1) found');
    if (points.length >= 2) level = 'red';
    else if (points.length === 1) level = 'amber';
    const note = points.length ? points.join(', ') : 'clear title, description and headings in place';
    rows.push([level, capitalize(note)]);
  }

  // 3) Do customers trust you?
  {
    const points = [];
    let level = 'amber'; // trust signals are inherently harder to fully verify automatically
    if (s.hasLocalBusinessSchema) points.push('business details are machine-readable (schema.org)');
    if (s.hasReviewSchema) points.push('review markup found');
    if (s.hasFaqSchema) points.push('FAQ markup found');
    if (s.addressHint) points.push('an address appears on the page');
    const goodCount = points.length;
    if (goodCount >= 2) level = 'green';
    else if (goodCount === 0) level = 'red';
    const note = points.length ? points.join(', ') : 'no structured business, review or address info found';
    rows.push([level, capitalize(note)]);
  }

  // 4) Can customers take action?
  {
    const contactCount = [s.phonePresent, s.mailtoLink || s.telLink, s.contactFormPresent, s.internalContactLinkPresent].filter(Boolean).length;
    let level = 'red';
    if (contactCount >= 2) level = 'green';
    else if (contactCount === 1) level = 'amber';
    const bits = [];
    if (s.phonePresent) bits.push('a phone number');
    if (s.mailtoLink || s.telLink) bits.push('a clickable contact link');
    if (s.contactFormPresent) bits.push('a contact form');
    if (s.internalContactLinkPresent) bits.push('a link to a dedicated contact page');
    let note = bits.length ? 'Found ' + bits.join(', ') : 'No phone, contact link or form found on the page';
    if (!s.viewport) note += (bits.length ? ' — but no mobile viewport tag, check it works on phones' : ' (and no mobile viewport tag either)');
    rows.push([level, note]);
  }

  // Fold in PageSpeed, if we have it, by nudging row 4 (action/speed) and adding context.
  let speedNote = null;
  if (pageSpeed && typeof pageSpeed.performance === 'number') {
    speedNote = 'Mobile speed score: ' + pageSpeed.performance + '/100 (Google PageSpeed)';
    if (pageSpeed.performance < 50 && rows[3][0] === 'green') rows[3][0] = 'amber';
  }

  const levelScore = { green: 2, amber: 1, red: 0 };
  const avg = rows.reduce((sum, r) => sum + levelScore[r[0]], 0) / rows.length;
  let overall = 'amber';
  let badgeChar = '!';
  let title;
  if (avg >= 1.6) { overall = 'green'; badgeChar = '✓'; title = 'Solid foundations, only small tweaks needed'; }
  else if (avg <= 0.7) { overall = 'red'; badgeChar = '!'; title = 'A few things are likely costing you enquiries'; }
  else { title = 'Good foundations, a couple of quick wins'; }

  return {
    real: true,
    hostname,
    overall,
    badgeChar,
    title,
    rows,
    pageSpeed,
    speedNote,
    aiNote: aiNote && aiNote.reason ? aiNote : null,
    checkedAt: new Date().toISOString(),
    summary: summariseRows(rows),
    nextStep: nextStepFor(rows),
  };
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

const NUMBER_WORDS = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
function numberWord(n) {
  return NUMBER_WORDS[n] || String(n);
}

// Builds an accurate one-line summary purely from the actual counts of
// green/amber/red rows — never from the qualitative `title` above, so the
// wording always matches what was actually found. Exported so it can be
// tested directly against synthetic row combinations (all-green, mixed
// counts, etc.) without needing a live fetch.
export function summariseRows(rows) {
  const total = rows.length;
  const counts = { green: 0, amber: 0, red: 0 };
  rows.forEach((r) => { counts[r[0]] = (counts[r[0]] || 0) + 1; });

  if (counts.green === total) {
    return 'Your homepage passed these ' + numberWord(total) + ' basic checks.';
  }
  if (counts.green === total - 1 && counts.amber === 1) {
    return capitalize(numberWord(counts.green)) + ' checks passed. One area is worth checking.';
  }
  if (counts.green === total - 1 && counts.red === 1) {
    return capitalize(numberWord(counts.green)) + ' checks passed. One area needs attention.';
  }

  // Any other mix: state accurate counts for whichever levels are actually present.
  const parts = [];
  if (counts.green) parts.push(numberWord(counts.green) + (counts.green === 1 ? ' check passed' : ' checks passed'));
  if (counts.amber) parts.push(numberWord(counts.amber) + (counts.amber === 1 ? ' area worth checking' : ' areas worth checking'));
  if (counts.red) parts.push(numberWord(counts.red) + (counts.red === 1 ? ' area needs attention' : ' areas need attention'));
  if (!parts.length) return 'No results to summarise.';
  return capitalize(parts.join(', ')) + '.';
}

// Row-topic next-step text, used only when that row is the one chosen below.
// Deliberately practical and non-presumptuous: no automatic "rebuild your
// site" or "buy schema" recommendation — just what to go and check.
const NEXT_STEP_BY_ROW = [
  'Check that your site shows up in Google for your business name, and that a sitemap and robots.txt are in place — these help search engines and AI tools find your site.',
  'Review your homepage description so it clearly summarises your business.',
  'Check that clear business details, reviews or photos are easy to find on your homepage — these help visitors trust the business quickly.',
  'Check that visitors can easily reach a working contact page, email address, telephone number or enquiry form.',
];

// Picks ONE next step from the actual findings: the first red row (in row
// order), else the first amber row, else — if everything passed — says so
// plainly rather than inventing work. Exported for the same testing reason
// as summariseRows above.
export function nextStepFor(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'red') return NEXT_STEP_BY_ROW[i] || 'Check this area manually before making changes.';
  }
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === 'amber') return NEXT_STEP_BY_ROW[i] || 'Check this area manually before making changes.';
  }
  return 'No changes are indicated by these basic checks. A deeper review is optional.';
}
