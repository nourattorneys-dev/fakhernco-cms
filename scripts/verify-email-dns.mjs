#!/usr/bin/env node
/**
 * Check the email DNS for fakhernco.com.
 *
 *   npm run verify:email-dns
 *
 * Run it BEFORE touching DNS to record the baseline, and again after adding
 * Resend's records.
 *
 * THE CHECK THAT MATTERS
 * ----------------------
 * An MX record on the ROOT domain. The root MX is Microsoft 365 and is how the
 * firm receives every email it gets — client instructions, court
 * correspondence, everything. Resend's verification screen shows an MX record,
 * and pasting it at the root instead of on `send.` would silently redirect all
 * inbound mail away from Microsoft. That is the single most damaging mistake
 * available in this whole migration, and it is two clicks away in cPanel.
 *
 * Everything else here is a warning. That one is a hard failure.
 */
import { promises as dnsDefault } from 'node:dns';
// The PROMISE-based Resolver. `node:dns`'s Resolver is callback-based, and its
// methods reject with ERR_INVALID_ARG_TYPE when awaited — which the catch-all
// helpers below reported as "record missing", i.e. a correctly configured
// domain looking completely broken.
import { Resolver } from 'node:dns/promises';

const DOMAIN = process.env.MAIL_DOMAIN ?? 'fakhernco.com';
const SUB = `send.${DOMAIN}`;

/**
 * Ask the domain's OWN nameservers, not whatever resolver this machine uses.
 *
 * This script is run at exactly the moment records are being added, and public
 * resolvers cache NEGATIVE answers — "no TXT here" is remembered for minutes
 * after the record appears. That made a correctly configured domain report
 * four missing records, which is worse than useless when the whole point is to
 * tell someone whether they got it right.
 */
let dns = dnsDefault;
try {
  const ns = await dnsDefault.resolveNs(DOMAIN);
  const ips = (await Promise.all(ns.map((h) => dnsDefault.resolve4(h).catch(() => [])))).flat();
  if (ips.length) {
    const r = new Resolver();
    r.setServers(ips);
    dns = r;
    console.log(`  (asking ${ns[0]} directly)`);
  }
} catch {
  // No authoritative lookup available — fall back to the system resolver and
  // accept that a freshly added record may not show yet.
}

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

let failures = 0;
let warnings = 0;

/*
  ENOTFOUND and ENODATA genuinely mean "no such record". Anything else is a
  lookup that FAILED, and reporting that as an absent record is how this script
  once told a correctly configured domain its inbound mail was broken. Real
  errors are surfaced, not swallowed.
*/
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NOTFOUND']);
async function lookup(fn, host, label) {
  try {
    return await fn(host);
  } catch (err) {
    if (NO_RECORD.has(err.code)) return [];
    console.log(`  \x1b[33m?\x1b[0m ${label} lookup for ${host} failed: ${err.code ?? err.message}`);
    lookupFailures += 1;
    return [];
  }
}
let lookupFailures = 0;
const mx = (h) => lookup((x) => dns.resolveMx(x), h, 'MX');
const txt = async (h) => (await lookup((x) => dns.resolveTxt(x), h, 'TXT')).map((r) => r.join(''));

console.log(`\nEmail DNS for ${DOMAIN}\n`);

// ---------------------------------------------------------------- root MX
console.log('Root domain — must keep receiving at Microsoft 365');
const rootMx = await mx(DOMAIN);
if (!rootMx.length) {
  bad('no MX on the root domain — inbound mail is BROKEN');
  failures += 1;
} else {
  const foreign = rootMx.filter((r) => !/outlook\.com|protection\.outlook/i.test(r.exchange));
  for (const r of rootMx) console.log(`      ${r.priority} ${r.exchange}`);
  if (foreign.length) {
    bad(`ROOT MX POINTS SOMEWHERE THAT IS NOT MICROSOFT: ${foreign.map((f) => f.exchange).join(', ')}`);
    bad('   If this was Resend\'s MX, remove it NOW and put it on send. instead.');
    bad('   Every email sent to the firm is going to the wrong place.');
    failures += 1;
  } else {
    ok('root MX is Microsoft 365, unchanged');
  }
}

// --------------------------------------------------------------- root SPF
const rootSpf = (await txt(DOMAIN)).filter((r) => /^v=spf1/i.test(r));
if (rootSpf.length > 1) {
  bad(`${rootSpf.length} SPF records on the root — more than one is invalid and fails ALL of them`);
  failures += 1;
} else if (!rootSpf.length) {
  bad('no SPF on the root domain');
  failures += 1;
} else {
  const rec = rootSpf[0];
  console.log(`      ${rec}`);
  if (/-all\s*$/.test(rec)) ok('SPF ends in -all (hard fail), as it should');
  else if (/~all\s*$/.test(rec)) {
    warn('SPF ends in ~all (soft fail) — it was -all; was this weakened?');
    warnings += 1;
  }
  // Resend does not need to be in the root SPF: its envelope sender lives on
  // the send. subdomain, and the From header is authenticated by DKIM. If
  // somebody added it here, the root SPF was edited unnecessarily.
  if (/resend|amazonses/i.test(rec)) {
    warn('root SPF mentions Resend/SES — not required, and it spends a DNS lookup');
    warnings += 1;
  }
  const lookups = (rec.match(/\b(include:|a:|mx:|exists:|redirect=|ptr\b)/gi) ?? []).length;
  if (lookups >= 9) { bad(`~${lookups} direct SPF lookups, limit is 10`); failures += 1; }
  else if (lookups >= 7) { warn(`~${lookups} direct SPF lookups (limit 10, includes nest)`); warnings += 1; }
  else ok(`~${lookups} direct SPF lookups, well inside the limit of 10`);
}

// ------------------------------------------------------------ send. subdomain
console.log(`\n${SUB} — where Resend's records belong`);
const subMx = await mx(SUB);
if (!subMx.length) {
  warn('no MX yet — expected before Resend is set up');
  warnings += 1;
} else {
  for (const r of subMx) console.log(`      ${r.priority} ${r.exchange}`);
  if (subMx.some((r) => /amazonses|resend/i.test(r.exchange))) ok('Resend feedback MX present, on the subdomain');
  else { warn('an MX is here but does not look like Resend'); warnings += 1; }
}

const subSpf = (await txt(SUB)).filter((r) => /^v=spf1/i.test(r));
if (!subSpf.length) { warn('no SPF on the subdomain yet'); warnings += 1; }
else {
  console.log(`      ${subSpf[0]}`);
  if (/amazonses|resend/i.test(subSpf[0])) ok('subdomain SPF authorises Resend');
  else { warn('subdomain SPF does not mention Resend'); warnings += 1; }
}

// ------------------------------------------------------------------- DKIM
console.log('\nDKIM — what actually authenticates noreply@' + DOMAIN);
let dkimFound = false;
for (const sel of ['resend', 'resend._domainkey', 'send']) {
  const host = sel.includes('_domainkey') ? `${sel}.${DOMAIN}` : `${sel}._domainkey.${DOMAIN}`;
  const rec = await txt(host);
  if (rec.length && rec.some((r) => /p=/.test(r))) {
    ok(`${host} present (${rec.join('').length} chars)`);
    dkimFound = true;
  }
}
if (!dkimFound) { warn('no Resend DKIM key found yet'); warnings += 1; }

// ------------------------------------------------------------------ DMARC
const dmarc = (await txt(`_dmarc.${DOMAIN}`)).filter((r) => /^v=DMARC1/i.test(r));
console.log('\nDMARC');
if (!dmarc.length) {
  warn('no DMARC record. Optional, but if you add one start at p=none and watch');
  warn('   the reports for a fortnight — going straight to p=reject can bin the');
  warn('   firm\'s own mail from anything not yet aligned.');
  warnings += 1;
} else {
  console.log(`      ${dmarc[0]}`);
  ok('DMARC present');
}

if (lookupFailures) {
  console.log(
    `\n  \x1b[33m${lookupFailures} lookup(s) errored.\x1b[0m Those are NOT reported as missing records —` +
      `\n  re-run before believing anything above them.`,
  );
}

console.log(
  `\n${failures ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mOK\x1b[0m'} — ${failures} failure(s), ${warnings} warning(s)\n`,
);
process.exit(failures ? 1 : 0);
