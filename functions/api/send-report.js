// Cloudflare Pages Function — emails the visitor their own copy of the report
// Route: POST /api/send-report   Body: { "url": "example.co.uk", "email": "visitor@example.com", "name": "Optional Name" }
//
// This is purely additive: it runs ALONGSIDE (never instead of) the existing
// Formspree lead-capture flow in index.html, which is completely untouched.
// If anything here fails — RESEND_API_KEY not set yet, the site check fails,
// Resend rejects the send, etc. — it just returns an error JSON and the
// front-end silently ignores it. Nothing about the existing "we'll be in
// touch" flow changes either way.
//
// Requires the RESEND_API_KEY environment variable (Cloudflare Pages ->
// Settings -> Variables and secrets, already added). Without it this
// endpoint simply no-ops rather than erroring loudly.

const FROM_ADDRESS = 'DontFixYourSEO Reports <reports@dontfixyourseo.com>';

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.RESEND_API_KEY) {
    return json({ error: 'Report emailing isn’t configured yet' }, 200);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Send a JSON body like {"url":"...","email":"..."}' }, 400);
  }

  const site = (body.url || '').trim();
  const visitorEmail = (body.email || '').trim();
  const visitorName = (body.name || '').trim();

  if (!site || !visitorEmail) {
    return json({ error: 'Missing url or email' }, 400);
  }

  // Reuse the exact same real checker the homepage already runs, by calling
  // it over HTTP rather than duplicating its scoring logic here. This keeps
  // the report automatically in sync with check.js — nothing to keep in step
  // in two places, and check.js itself is never touched.
  let checkData;
  try {
    const origin = new URL(request.url).origin;
    const checkRes = await fetchWithTimeout(origin + '/api/check', 15000, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: site }),
    });
    checkData = await checkRes.json();
  } catch (e) {
    return json({ error: 'Could not run the website check' }, 200);
  }

  if (!checkData || !checkData.real || !checkData.rows || checkData.rows.length !== 4) {
    return json({ error: (checkData && checkData.error) || 'Could not check that site' }, 200);
  }

  const emailHtml = buildEmailHtml(checkData, visitorName, site);
  const emailText = buildEmailText(checkData, visitorName, site);

  try {
    const sendRes = await fetchWithTimeout('https://api.resend.com/emails', 15000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [visitorEmail],
        subject: 'Your website report — ' + checkData.hostname,
        html: emailHtml,
        text: emailText,
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text().catch(function () { return ''; });
      return json({ error: 'Resend rejected the email', detail: errText }, 200);
    }
  } catch (e) {
    return json({ error: 'Could not send the email' }, 200);
  }

  return json({ sent: true }, 200);
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
  const t = setTimeout(function () { controller.abort(); }, ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Kept in sync with the STATUS_LABEL wording used on the results page
// (index.html) so the emailed report never contradicts what the visitor
// already saw on-site. 'gray'/'Could not verify' is included for
// completeness but never actually reached here — onRequestPost already
// returns early on checkData.error before buildEmailHtml/buildEmailText
// are called, so a whole-site "unavailable" result never gets this far.
const LEVEL_LABEL = { green: 'Passed these checks', amber: 'Worth checking', red: 'Needs attention', gray: 'Could not verify' };
const LEVEL_COLOR = { green: '#1a8a4a', amber: '#b8860b', red: '#c0392b', gray: '#777777' };
const ROW_TITLES = [
  'Can customers find you?',
  'Do customers understand you?',
  'Do customers trust you?',
  'Can customers take action?',
];

function formatCheckedDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  } catch (e) {
    return '';
  }
}

function buildEmailHtml(data, name, site) {
  const greeting = name ? 'Hi ' + escapeHtml(name) + ',' : 'Hi,';
  const checkedDate = formatCheckedDate(data.checkedAt);
  const headline = data.summary || data.title || '';

  const rowsHtml = data.rows.map(function (row, i) {
    var level = row[0], note = row[1];
    return '<tr>'
      + '<td style="padding:10px 0;border-bottom:1px solid #eee;font-family:Arial,sans-serif;">'
      + '<div style="font-weight:600;color:#111;">' + escapeHtml(ROW_TITLES[i]) + '</div>'
      + '<div style="color:' + LEVEL_COLOR[level] + ';font-weight:600;font-size:13px;margin:2px 0;">' + LEVEL_LABEL[level] + '</div>'
      + '<div style="color:#444;font-size:14px;">' + escapeHtml(note) + '</div>'
      + '</td></tr>';
  }).join('');

  const nextStepHtml = data.nextStep
    ? '<table style="width:100%;border-collapse:collapse;margin-top:16px;"><tr><td style="background:#f2f6f4;border:1px solid #dfe7e3;border-radius:6px;padding:14px 16px;font-family:Arial,sans-serif;">'
      + '<div style="font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#555;margin-bottom:4px;">Your next step</div>'
      + '<div style="color:#222;font-size:14px;line-height:1.5;">' + escapeHtml(data.nextStep) + '</div>'
      + '</td></tr></table>'
    : '';

  const scopeNoteHtml = '<p style="color:#888;font-size:12px;margin-top:10px;">This is an automated check of selected website basics — not a full audit or guarantee of search or AI-assistant ranking.</p>';

  const vcHtml = '<table style="width:100%;border-collapse:collapse;margin-top:28px;"><tr><td style="background:#eaf6ee;border:1px solid #cfe9d8;border-radius:8px;padding:18px 20px;font-family:Arial,sans-serif;">'
    + '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#4a6b58;margin-bottom:6px;">You’ve checked the basics. Want a closer look?</div>'
    + '<div style="font-size:16px;font-weight:800;color:#0f2e1d;margin-bottom:8px;">Practical help from a fellow business owner</div>'
    + '<p style="font-size:13.5px;line-height:1.55;color:#233;margin:0 0 10px;">Lee Kelly and his business partner Tony Posgate have built Home Design Products Ltd, Home Design Properties Ltd and Revive My Kitchen together. Recognising that their own marketing and websites needed to evolve helped shape Lee’s approach to Visible Companies—clear findings, practical recommendations and an understandable next step.</p>'
    + '<p style="font-size:13.5px;line-height:1.55;color:#233;margin:0 0 12px;">Paid audits include checks using relevant customer questions across ChatGPT, Perplexity, Gemini and Google AI Overviews. Lee personally reviews each report before delivery.</p>'
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">'
    + '<tr><td style="padding:4px 0;font-size:13px;color:#0f2e1d;"><strong>AI Visibility Snapshot</strong> — £29.95 <span style="color:#556;">— a concise overview of your visibility and the main findings.</span></td></tr>'
    + '<tr><td style="padding:4px 0;font-size:13px;color:#0f2e1d;"><strong>AI Visibility Deep Dive</strong> — £395 <span style="color:#556;">— detailed technical checks, competitor comparison and a prioritised action plan.</span></td></tr>'
    + '<tr><td style="padding:4px 0;font-size:13px;color:#0f2e1d;"><strong>Schema &amp; Citation Pack</strong> — £149 add-on <span style="color:#556;">— prepared website code, a business-listing checklist and installation instructions.</span></td></tr>'
    + '</table>'
    + '<p style="font-size:11.5px;color:#556;margin:0 0 14px;">Website rebuilds and ongoing care are also available where appropriate. Confirm implementation scope and price before ordering.</p>'
    + '<p style="margin:0 0 10px;"><a href="https://visiblecompanies.co.uk/pricing/" style="background:#0f6e3e;color:#ffffff;font-weight:700;font-size:13.5px;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;">Explore services and pricing →</a></p>'
    + '<p style="font-size:12.5px;margin:0 0 10px;">'
    + '<a href="https://visiblecompanies.co.uk/how-it-works/" style="color:#0f6e3e;">How the audit works</a> &nbsp;&middot;&nbsp; '
    + '<a href="https://visiblecompanies.co.uk/about/" style="color:#0f6e3e;">Meet Lee</a> &nbsp;&middot;&nbsp; '
    + '<a href="https://visiblecompanies.co.uk/contact/" style="color:#0f6e3e;">Not sure which service? Ask Lee</a>'
    + '</p>'
    + '<p style="font-size:11px;color:#556;margin:8px 0 0;">No service can guarantee a recommendation or mention in AI-generated answers.</p>'
    + '</td></tr></table>';

  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222;">'
    + '<p>' + greeting + '</p>'
    + '<p>Here’s the automated report for <strong>' + escapeHtml(site) + '</strong> that you just ran on '
    + '<a href="https://dontfixyourseo.com">DontFixYourSEO.com</a>.</p>'
    + '<h2 style="margin-top:24px;margin-bottom:2px;">' + escapeHtml(headline) + '</h2>'
    + (checkedDate ? '<p style="color:#888;font-size:12px;margin:0 0 8px;">Checked ' + escapeHtml(checkedDate) + '</p>' : '')
    + '<p style="color:#888;font-size:12px;margin:0 0 10px;">This is a snapshot of four basics only. Even when most checks here pass, a fuller audit can often find more to improve.</p>'
    + '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' + rowsHtml + '</table>'
    + (data.speedNote ? '<p style="color:#444;font-size:14px;">' + escapeHtml(data.speedNote) + '</p>' : '')
    + (data.aiNote && data.aiNote.reason ? '<p style="color:#444;font-size:14px;"><em>' + escapeHtml(data.aiNote.reason) + '</em></p>' : '')
    + nextStepHtml
    + scopeNoteHtml
    + '<p style="margin-top:20px;">Want a full human review with specific, prioritised fixes? Just reply to this '
    + 'email and we’ll take a proper look and get back to you.</p>'
    + vcHtml
    + '<p style="margin-top:24px;color:#888;font-size:12px;">Sent by DontFixYourSEO.com — plain-English website audits for local businesses.</p>'
    + '</div>';
}

function buildEmailText(data, name, site) {
  const greeting = name ? 'Hi ' + name + ',' : 'Hi,';
  const checkedDate = formatCheckedDate(data.checkedAt);
  const headline = data.summary || data.title || '';
  const rowsText = data.rows.map(function (row, i) {
    return ROW_TITLES[i] + ' — ' + LEVEL_LABEL[row[0]] + ': ' + row[1];
  }).join('\n');

  const vcText = 'YOU’VE CHECKED THE BASICS. WANT A CLOSER LOOK?\n'
    + 'Practical help from a fellow business owner\n\n'
    + 'Lee Kelly and his business partner Tony Posgate have built Home Design Products Ltd, '
    + 'Home Design Properties Ltd and Revive My Kitchen together. Recognising that their own '
    + 'marketing and websites needed to evolve helped shape Lee’s approach to Visible '
    + 'Companies—clear findings, practical recommendations and an understandable next step.\n\n'
    + 'Paid audits include checks using relevant customer questions across ChatGPT, Perplexity, '
    + 'Gemini and Google AI Overviews. Lee personally reviews each report before delivery.\n\n'
    + 'AI Visibility Snapshot — £29.95 — a concise overview of your visibility and the main findings.\n'
    + 'AI Visibility Deep Dive — £395 — detailed technical checks, competitor comparison and a prioritised action plan.\n'
    + 'Schema & Citation Pack — £149 add-on — prepared website code, a business-listing checklist and installation instructions.\n\n'
    + 'Website rebuilds and ongoing care are also available where appropriate. Confirm implementation scope and price before ordering.\n\n'
    + 'Explore services and pricing: https://visiblecompanies.co.uk/pricing/\n'
    + 'How the audit works: https://visiblecompanies.co.uk/how-it-works/\n'
    + 'Meet Lee: https://visiblecompanies.co.uk/about/\n'
    + 'Not sure which service? Ask Lee: https://visiblecompanies.co.uk/contact/\n\n'
    + 'No service can guarantee a recommendation or mention in AI-generated answers.';

  return greeting + '\n\n'
    + 'Here’s the automated report for ' + site + ' from DontFixYourSEO.com\n\n'
    + headline + (checkedDate ? ' (checked ' + checkedDate + ')' : '') + '\n'
    + 'This is a snapshot of four basics only. Even when most checks here pass, a fuller audit can often find more to improve.\n\n'
    + rowsText + '\n\n'
    + (data.speedNote ? data.speedNote + '\n\n' : '')
    + (data.aiNote && data.aiNote.reason ? data.aiNote.reason + '\n\n' : '')
    + (data.nextStep ? 'YOUR NEXT STEP\n' + data.nextStep + '\n\n' : '')
    + 'This is an automated check of selected website basics — not a full audit or guarantee of search or AI-assistant ranking.\n\n'
    + 'Want a full human review with specific, prioritised fixes? Just reply to this email and we’ll take a proper look.\n\n'
    + vcText + '\n\n'
    + '— DontFixYourSEO.com';
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
