/**
 * Contact form handler: validate, store, notify, auto-reply.
 *
 * Ordering is deliberate. The enquiry is persisted BEFORE any email is
 * attempted, and email failures are logged rather than thrown. A law firm
 * losing a lead because an SMTP relay hiccuped is far worse than an enquirer
 * not receiving a confirmation.
 */

const MAX = { name: 120, email: 200, phone: 40, subject: 200, service: 120, message: 8000 };

/**
 * Per-IP rate limit, in-process.
 *
 * Deliberately simple. This is a brochure site behind Cloudflare, so this is a
 * second line of defence against a trivial script, not a serious WAF. It resets
 * on restart, which is acceptable.
 */
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 5 };
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);

  // Keep the map from growing without bound on a long-lived process.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_LIMIT.windowMs)) hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT.max;
}

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Auto-reply copy. Arabic is RTL and gets its own direction on the wrapper. */
const REPLY = {
  en: {
    subject: 'We have received your enquiry — Fakher & Co',
    body: (name: string) => `
      <div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a">
        <p>Dear ${escapeHtml(name)},</p>
        <p>Thank you for contacting Fakher &amp; Co. We have received your enquiry and a member
           of our team will respond within one business day.</p>
        <p>If your matter is urgent, you can reach us directly on
           <a href="tel:+971502057209">+971 50 205 7209</a>.</p>
        <p>Kind regards,<br><strong>Fakher &amp; Co</strong><br>
           Trusted Litigation Specialists<br>Abu Dhabi · Egypt · India</p>
        <p style="font-size:12px;color:#767676;margin-top:24px">
          This is an automated acknowledgement. It does not create a lawyer–client
          relationship, and it is not legal advice.
        </p>
      </div>`,
  },
  ar: {
    subject: 'تم استلام طلبك — مكتب فاخر ومشاركوه',
    body: (name: string) => `
      <div dir="rtl" style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.8;color:#1a1a1a;text-align:right">
        <p>عزيزي/عزيزتي ${escapeHtml(name)},</p>
        <p>شكراً لتواصلك مع مكتب فاخر ومشاركوه. لقد استلمنا طلبك وسيقوم أحد أعضاء
           فريقنا بالرد عليك خلال يوم عمل واحد.</p>
        <p>إذا كان الأمر عاجلاً، يمكنك الاتصال بنا مباشرة على الرقم
           <a href="tel:+971502057209">‎+971 50 205 7209</a>.</p>
        <p>مع خالص التقدير،<br><strong>مكتب فاخر ومشاركوه</strong><br>
           متخصصون في التقاضي<br>أبوظبي · مصر · الهند</p>
        <p style="font-size:12px;color:#767676;margin-top:24px">
          هذا إشعار آلي بالاستلام. لا ينشئ علاقة بين المحامي والموكل، ولا يُعد استشارة قانونية.
        </p>
      </div>`,
  },
};

export default {
  async create(ctx: any) {
    const body = ctx.request.body ?? {};
    const ip = ctx.request.ip ?? 'unknown';

    // 1. Honeypot. A field no human sees; only bots fill it in. Answer 200 so
    //    the bot believes it succeeded and does not retry with a new shape.
    if (clean(body.website, 200)) {
      strapi.log.info(`[contact] honeypot triggered from ${ip}`);
      return ctx.send({ ok: true });
    }

    // 2. Rate limit.
    if (rateLimited(ip)) {
      return ctx.tooManyRequests('Too many submissions. Please try again shortly.');
    }

    // 3. Validate.
    const data = {
      name: clean(body.name, MAX.name),
      email: clean(body.email, MAX.email),
      phone: clean(body.phone, MAX.phone),
      subject: clean(body.subject, MAX.subject),
      service: clean(body.service, MAX.service),
      message: clean(body.message, MAX.message),
      sourcePage: clean(body.sourcePage, 300),
      submittedLocale: clean(body.locale, 5) === 'ar' ? 'ar' : 'en',
      consent: body.consent === true,
      handled: false,
    };

    const missing = (['name', 'email', 'message'] as const).filter((k) => !data[k]);
    if (missing.length) {
      return ctx.badRequest(`Missing required field(s): ${missing.join(', ')}`);
    }
    if (!looksLikeEmail(data.email)) {
      return ctx.badRequest('Please provide a valid email address.');
    }

    // 4. Persist first. Everything after this is best-effort.
    const entry = await strapi.documents('api::contact-submission.contact-submission').create({
      data,
    });

    // 5. Notify the firm.
    const notify = process.env.CONTACT_NOTIFY_EMAIL;
    if (notify) {
      try {
        await strapi.plugin('email').service('email').send({
          to: notify,
          replyTo: data.email,
          subject: `[fakhernco.com] ${data.subject || 'New enquiry'} — ${data.name}`,
          html: `
            <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6">
              <h2 style="margin:0 0 12px">New enquiry</h2>
              <p><strong>Name:</strong> ${escapeHtml(data.name)}<br>
                 <strong>Email:</strong> ${escapeHtml(data.email)}<br>
                 <strong>Phone:</strong> ${escapeHtml(data.phone) || '—'}<br>
                 <strong>Service:</strong> ${escapeHtml(data.service) || '—'}<br>
                 <strong>Page:</strong> ${escapeHtml(data.sourcePage) || '—'}<br>
                 <strong>Language:</strong> ${data.submittedLocale}</p>
              <hr style="border:none;border-top:1px solid #e0e0e0">
              <p style="white-space:pre-wrap">${escapeHtml(data.message)}</p>
            </div>`,
        });
      } catch (err: any) {
        strapi.log.error(`[contact] notification failed for #${entry.documentId}: ${err.message}`);
      }
    } else {
      strapi.log.warn('[contact] CONTACT_NOTIFY_EMAIL is not set — nobody was notified');
    }

    // 6. Auto-reply to the enquirer, in the language they wrote in.
    if (process.env.SMTP_HOST) {
      const copy = REPLY[data.submittedLocale as 'en' | 'ar'];
      try {
        await strapi.plugin('email').service('email').send({
          to: data.email,
          /*
            Replies must reach a human.

            Without this the acknowledgement inherits defaultReplyTo, which is
            SMTP_FROM_EMAIL — noreply@fakhernco.com. A prospective client who
            hits Reply on it, which is the natural thing to do when you have
            just been told someone will be in touch, would send their answer to
            an address nobody reads and that may not accept mail at all. For a
            law firm that is a lost instruction, not a lost email.
          */
          replyTo: notify || undefined,
          subject: copy.subject,
          html: copy.body(data.name),
        });
      } catch (err: any) {
        strapi.log.error(`[contact] auto-reply failed for #${entry.documentId}: ${err.message}`);
      }
    }

    return ctx.send({ ok: true });
  },
};
