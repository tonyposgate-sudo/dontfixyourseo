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

const LEVEL_LABEL = { green: 'Good', amber: 'Worth a look', red: 'Needs attention' };
const LEVEL_COLOR = { green: '#1a8a4a', amber: '#b8860b', red: '#c0392b' };
const ROW_TITLES = [
  'Can customers find you?',
  'Do customers understand you?',
  'Do customers trust you?',
  'Can customers take action?',
];

function buildEmailHtml(data, name, site) {
  const greeting = name ? 'Hi ' + escapeHtml(name) + ',' : 'Hi,';
  const rowsHtml = data.rows.map(function (row, i) {
    var level = row[0], note = row[1];
    return '<tr>'
      + '<td style="padding:10px 0;border-bottom:1px solid #eee;font-family:Arial,sans-serif;">'
      + '<div style="font-weight:600;color:#111;">' + escapeHtml(ROW_TITLES[i]) + '</div>'
      + '<div style="color:' + LEVEL_COLOR[level] + ';font-weight:600;font-size:13px;margin:2px 0;">' + LEVEL_LABEL[level] + '</div>'
      + '<div style="color:#444;font-size:14px;">' + escapeHtml(note) + '</div>'
      + '</td></tr>';
  }).join('');

  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222;">'
    + '<p>' + greeting + '</p>'
    + '<p>Here’s the automated report for <strong>' + escapeHtml(site) + '</strong> that you just ran on '
    + '<a href="https://dontfixyourseo.com">DontFixYourSEO.com</a>.</p>'
    + '<h2 style="margin-top:24px;">' + escapeHtml(data.title || '') + '</h2>'
    + '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' + rowsHtml + '</table>'
    + (data.speedNote ? '<p style="color:#444;font-size:14px;">' + escapeHtml(data.speedNote) + '</p>' : '')
    + (data.aiNote && data.aiNote.reason ? '<p style="color:#444;font-size:14px;"><em>' + escapeHtml(data.aiNote.reason) + '</em></p>' : '')
    + '<p style="margin-top:24px;">Want a full human review with specific, prioritised fixes? Just reply to this '
    + 'email and we’ll take a proper look and get back to you.</p>'
    + '<p style="margin-top:24px;color:#888;font-size:12px;">Sent by DontFixYourSEO.com — plain-English website audits for local businesses.</p>'
    + '</div>';
}

function buildEmailText(data, name, site) {
  const greeting = name ? 'Hi ' + name + ',' : 'Hi,';
  const rowsText = data.rows.map(function (row, i) {
    return ROW_TITLES[i] + ' — ' + LEVEL_LABEL[row[0]] + ': ' + row[1];
  }).join('\n');

  return greeting + '\n\n'
    + 'Here’s the automated report for ' + site + ' from DontFixYourSEO.com\n\n'
    + (data.title || '') + '\n\n'
    + rowsText + '\n\n'
    + (data.speedNote ? data.speedNote + '\n\n' : '')
    + (data.aiNote && data.aiNote.reason ? data.aiNote.reason + '\n\n' : '')
    + 'Want a full human review with specific, prioritised fixes? Just reply to this email and we’ll take a proper look.\n\n'
    + '— DontFixYourSEO.com';
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
