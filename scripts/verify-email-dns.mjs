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
import { promises as dns } from 'node:dns';

const DOMAIN = process.env.MAIL_DOMAIN ?? 'fakhernco.com';
const SUB = `send.${DOMAIN}`;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);

let failures = 0;
let warnings = 0;

const mx = async (h) => { try { return await dns.resolveMx(h); } catch { return []; } };
const txt = async (h) => {
  try { return (await dns.resolveTxt(h)).map((r) => r.join('')); } catch { return []; }
};

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

console.log(
  `\n${failures ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32mOK\x1b[0m'} — ${failures} failure(s), ${warnings} warning(s)\n`,
);
process.exit(failures ? 1 : 0);
