// Regression tests for the results-summary and next-step logic added to
// functions/api/check.js (summariseRows / nextStepFor) for the Visible
// Companies handover: the summary text must always match the ACTUAL counts
// of green/amber/red rows, never the separate qualitative `title`, and the
// next step must prioritise red findings before amber ones.
//
// Same base64-data-url import trick as check.contact-detection.test.mjs —
// see that file for why (no package.json in this repo, deliberately).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checkJsPath = path.join(__dirname, '..', 'functions', 'api', 'check.js');
const source = readFileSync(checkJsPath, 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
const { summariseRows, nextStepFor, buildResult } = await import(dataUrl);

function rowsOf(levels) {
  return levels.map((level) => [level, 'note']);
}

test('summariseRows: all four green', () => {
  assert.equal(
    summariseRows(rowsOf(['green', 'green', 'green', 'green'])),
    'Your homepage passed these four basic checks.'
  );
});

test('summariseRows: three green, one amber', () => {
  assert.equal(
    summariseRows(rowsOf(['green', 'green', 'amber', 'green'])),
    'Three checks passed. One area is worth checking.'
  );
});

test('summariseRows: three green, one red', () => {
  assert.equal(
    summariseRows(rowsOf(['red', 'green', 'green', 'green'])),
    'Three checks passed. One area needs attention.'
  );
});

test('summariseRows: mixed combination states accurate counts, not a canned phrase', () => {
  const text = summariseRows(rowsOf(['green', 'green', 'amber', 'red']));
  assert.match(text, /two checks passed/i);
  assert.match(text, /one area worth checking/i);
  assert.match(text, /one area needs attention/i);
});

test('summariseRows: all red', () => {
  const text = summariseRows(rowsOf(['red', 'red', 'red', 'red']));
  assert.match(text, /four areas need attention/i);
  assert.doesNotMatch(text, /checks? passed/i);
});

test('nextStepFor: red takes priority over amber, and picks the FIRST red row', () => {
  // red is row 3 (Act), amber is row 1 (Understand) — red should win and
  // should be that row's specific text, not a generic amber one.
  const step = nextStepFor(rowsOf(['green', 'amber', 'green', 'red']));
  assert.match(step, /contact page|email address|telephone number|enquiry form/i);
});

test('nextStepFor: earlier red row wins over a later red row', () => {
  const step = nextStepFor(rowsOf(['green', 'red', 'green', 'red']));
  // Row 1 (index 1, "Do customers understand you?") should win over row 3.
  assert.match(step, /homepage description/i);
});

test('nextStepFor: amber only, no red present', () => {
  const step = nextStepFor(rowsOf(['green', 'green', 'green', 'amber']));
  assert.match(step, /contact page|email address|telephone number|enquiry form/i);
});

test('nextStepFor: all green says no changes are indicated', () => {
  const step = nextStepFor(rowsOf(['green', 'green', 'green', 'green']));
  assert.equal(step, 'No changes are indicated by these basic checks. A deeper review is optional.');
});

test('buildResult: response includes checkedAt, summary and nextStep fields', () => {
  const signals = {
    title: 'Example business', titleLength: 16,
    metaDesc: 'A description that is a perfectly reasonable length for this test to pass easily.',
    metaDescLength: 84,
    viewport: true, canonical: true, h1Count: 1,
    hasLocalBusinessSchema: true, hasReviewSchema: false, hasFaqSchema: true, addressHint: true,
    phonePresent: true, mailtoLink: true, telLink: true, contactFormPresent: true, internalContactLinkPresent: true,
    https: true, robotsPresent: true, sitemapPresent: true, llmsTxtPresent: false,
  };
  const result = buildResult(signals, null, null, 'example.co.uk');
  assert.equal(typeof result.checkedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(result.checkedAt)), 'checkedAt should be a valid ISO date string');
  assert.equal(result.summary, 'Your homepage passed these four basic checks.');
  assert.equal(result.nextStep, 'No changes are indicated by these basic checks. A deeper review is optional.');
});
