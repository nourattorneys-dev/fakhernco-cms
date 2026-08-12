#!/usr/bin/env node
/**
 * Check the email setup on whatever machine you run it on.
 *
 *   npm run verify:email           # check config + connect + authenticate
 *   npm run verify:email -- --send # also send one real test message
 *
 * Run it ON THE SERVER, in the CMS directory, after editing .env. It reads the
 * same variables Strapi does and never prints the password.
 *
 * WHY THIS EXISTS
 * ---------------
 * "The developer gave me email details and I put them in .env" is not the same
 * as "email works". fakhernco.com publishes an SPF record ending in -all, a
 * hard fail, listing only Microsoft 365. Mail sent as noreply@fakhernco.com
 * through any other relay — cPanel's mail server being the usual one to hand —
 * is rejected or filed as spam by the receiving side. The send succeeds. The
 * message never arrives. Nothing in a log says why.
 *
 * So this checks the relay is one the domain actually authorises, not just
 * that the credentials work.
 */
import { createRequire } from 'node:module';
import { promises as dns } from 'node:dns';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');

// Load .env the same way Strapi does, without adding a dependency.
try {
  const env = await readFile(path.join(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    }
  }
} catch {
  console.log('  (no .env in this directory — using the ambient environment)');
}

const SEND = process.argv.includes('--send');
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
let failures = 0;

const V = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_FROM_EMAIL: process.env.SMTP_FROM_EMAIL,
  CONTACT_NOTIFY_EMAIL: process.env.CONTACT_NOTIFY_EMAIL,
};

console.log('\nEmail configuration\n');
for (const [k, v] of Object.entries(V)) {
  if (!v) {
    // The two that silently do nothing rather than erroring.
    if (k === 'CONTACT_NOTIFY_EMAIL') {
      bad(`${k} is NOT set — enquiries save, but NOBODY at the firm is emailed`);
    } else {
      bad(`${k} is NOT set`);
    }
    failures += 1;
  } else if (k === 'SMTP_PASS') {
    ok(`${k} = ${'•'.repeat(Math.min(v.length, 12))} (${v.length} chars, never printed)`);
  } else {
    ok(`${k} = ${v}`);
  }
}

if (failures) {
  console.log(`\n\x1b[31m${failures} value(s) missing.\x1b[0m Email cannot work until they are set.\n`);
  process.exit(1);
}

// ------------------------------------------------- which relay is this, really
const host = V.SMTP_HOST.toLowerCase();
const fromDomain = (V.SMTP_FROM_EMAIL.split('@')[1] ?? '').toLowerCase();
const KNOWN = {
  resend: /resend\.com$/,
  microsoft: /(office365|outlook)\.com$/,
  sendgrid: /sendgrid\.net$/,
  ses: /amazonaws\.com$/,
  mailgun: /mailgun\.org$/,
};
const relay = Object.entries(KNOWN).find(([, re]) => re.test(host))?.[0] ?? 'other';

console.log('\nRelay\n');
if (relay === 'other') {
  warn(`${V.SMTP_HOST} is not a known transactional provider.`);
  warn(`  If this is cPanel's own mail server, sending AS ${V.SMTP_FROM_EMAIL}`);
  warn('  will pass here and still be rejected by the recipient, because the');
  warn('  domain\'s SPF ends in -all and does not list it.');
} else {
  ok(`${relay} (${V.SMTP_HOST})`);
}

if (relay === 'microsoft' && V.SMTP_USER.toLowerCase() !== V.SMTP_FROM_EMAIL.toLowerCase()) {
  bad(`Microsoft 365 requires From to equal the authenticated mailbox.`);
  bad(`  SMTP_USER=${V.SMTP_USER} but SMTP_FROM_EMAIL=${V.SMTP_FROM_EMAIL}`);
  bad('  Sends will fail with 5.7.60 unless SendAs is granted.');
  failures += 1;
}

// ------------------------------------------------------------ SPF sanity check
if (fromDomain) {
  console.log('\nWill the recipient accept it?\n');
  let spf = '';
  try {
    const recs = await dns.resolveTxt(fromDomain);
    spf = recs.map((r) => r.join('')).find((r) => /^v=spf1/i.test(r)) ?? '';
  } catch { /* ignore */ }

  if (!spf) {
    warn(`no SPF record on ${fromDomain}`);
  } else {
    console.log(`      ${spf}`);
    const strict = /-all\s*$/.test(spf);
    const authorised =
      (relay === 'microsoft' && /protection\.outlook\.com/i.test(spf)) ||
      // Resend aligns via DKIM on the root and SPF on the send. subdomain, so
      // the root record deliberately does NOT list it. That is correct, not a
      // gap — DKIM alignment alone satisfies DMARC.
      relay === 'resend' ||
      new RegExp(relay, 'i').test(spf);

    if (relay === 'resend') {
      ok('Resend authenticates by DKIM on the root domain — the root SPF does not need to list it');
      try {
        const dk = await dns.resolveTxt(`resend._domainkey.${fromDomain}`);
        if (dk.length) ok('Resend DKIM key is published');
        else { bad('Resend DKIM key NOT found — the domain is not verified yet'); failures += 1; }
      } catch {
        bad(`no DKIM at resend._domainkey.${fromDomain} — domain not verified in Resend yet`);
        failures += 1;
      }
    } else if (strict && !authorised) {
      bad(`SPF ends in -all (hard fail) and does not authorise ${relay === 'other' ? V.SMTP_HOST : relay}.`);
      bad('  The send will SUCCEED and the message will still be rejected or');
      bad('  spam-filed by the recipient. This is the failure that looks like');
      bad('  it works. Use Resend, or Microsoft 365, or nothing.');
      failures += 1;
    } else if (authorised) {
      ok(`SPF authorises ${relay}`);
    }
  }
}

// ------------------------------------------------------------- live connection
console.log('\nConnection\n');
const port = Number(V.SMTP_PORT);
const transport = nodemailer.createTransport({
  host: V.SMTP_HOST,
  port,
  secure: port === 465,
  requireTLS: true,
  auth: { user: V.SMTP_USER, pass: V.SMTP_PASS },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
});

try {
  await transport.verify();
  ok(`connected to ${V.SMTP_HOST}:${port} and authenticated`);
} catch (err) {
  bad(`could not connect or authenticate: ${err.message}`);
  if (/535|auth/i.test(err.message)) bad('  → the username or password is wrong');
  if (/ETIMEDOUT|ECONNREFUSED/i.test(err.message)) {
    bad('  → nothing listening, or the host firewall blocks outbound SMTP');
  }
  if (/self.signed|certificate/i.test(err.message)) bad('  → TLS certificate problem');
  failures += 1;
}

// ------------------------------------------------------------------ real send
if (SEND && !failures) {
  console.log('\nTest message\n');
  try {
    const info = await transport.sendMail({
      from: V.SMTP_FROM_EMAIL,
      to: V.CONTACT_NOTIFY_EMAIL,
      replyTo: V.CONTACT_NOTIFY_EMAIL,
      subject: '[fakhernco.com] Email configuration test',
      text:
        'If you are reading this, the contact form can reach this inbox.\n\n' +
        'Sent by npm run verify:email -- --send',
    });
    ok(`accepted for delivery: ${info.messageId}`);
    warn(`now CHECK ${V.CONTACT_NOTIFY_EMAIL}, including the junk folder.`);
    warn('  Acceptance here only means the relay took it, not that it arrived.');
  } catch (err) {
    bad(`send failed: ${err.message}`);
    failures += 1;
  }
} else if (SEND) {
  warn('skipped the test send because of the failures above');
}

console.log(
  `\n${failures ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mOK\x1b[0m'} — ${failures} problem(s)` +
    (failures || SEND ? '' : '\n  Re-run with --send to post a real test message.') +
    '\n',
);
process.exit(failures ? 1 : 0);
