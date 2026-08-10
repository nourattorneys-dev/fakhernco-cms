import type { Core } from '@strapi/strapi';

const allowedMediaTypes = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.*',
  'text/plain',
  'text/csv',
];

const deniedExecutableTypes = [
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-mach-binary',
];

const config = ({ env }: Core.Config.Shared.ConfigParams): Core.Config.Plugin => ({
  /**
   * Bilingual English / Arabic.
   *
   * Enabled before the first content import, deliberately. Retrofitting
   * `pluginOptions.i18n.localized` onto populated content types means
   * rewriting every entry, so the locales exist from day one even though the
   * Arabic content arrives later.
   *
   * `en` is the default locale; `ar` is created on first boot by src/index.ts.
   */
  i18n: {
    enabled: true,
  },

  'users-permissions': {
    config: {
      jwtManagement: 'refresh',
      sessions: {
        httpOnly: true,
      },
    },
  },

  /**
   * SMTP email via nodemailer. Configured for Resend.
   *
   * Strapi's default `sendmail` provider cannot reach an external SMTP relay,
   * so contact-form notifications and auto-replies would silently never send.
   *
   * WHY NOT THE OBVIOUS TWO
   * fakhernco.com's MX points at Microsoft 365 and its SPF ends in `-all`:
   *
   *   v=spf1 include:spf.protection.outlook.com
   *          include:spf-de.emailsignatures365.com -all
   *
   * That is a hard fail. It instructs receiving servers to REJECT mail
   * claiming to be from this domain that did not come via Microsoft.
   *
   *   - cPanel's own mail server is not in that list, so auto-replies sent
   *     through it would be rejected or spam-filed. For a law firm, an
   *     auto-reply landing in a prospective client's junk folder is worse
   *     than sending none.
   *   - Microsoft 365 SMTP is SPF-aligned, but basic SMTP AUTH is disabled by
   *     default on modern tenants and Microsoft has been retiring it. The
   *     endpoint advertises AUTH LOGIN; whether a given mailbox may use it is
   *     a per-tenant flag. Building the contact form on a credential type the
   *     vendor is removing is a slow-motion outage.
   *
   * Resend authenticates the From address with DKIM on the root domain, and
   * puts its own SPF and return-path on a `send.` subdomain — so
   * noreply@fakhernco.com is deliverable without rewriting the root SPF that
   * the firm's real email depends on. Credentials are an API key that can be
   * revoked without touching anyone's mailbox.
   *
   * ONE THING THAT MUST NOT HAPPEN DURING SETUP: no MX record on the ROOT
   * domain. The root MX is Microsoft 365 and is how the firm receives all of
   * its mail. Resend's MX belongs on the `send.` subdomain only.
   *
   * SMTP_USER is the literal string "resend"; SMTP_PASS is the API key.
   */
  email: {
    config: {
      provider: 'nodemailer',
      providerOptions: {
        host: env('SMTP_HOST'),
        port: env.int('SMTP_PORT', 587),
        // Port 465 = implicit TLS; anything else (587) = STARTTLS.
        secure: env.int('SMTP_PORT', 587) === 465,
        auth: {
          user: env('SMTP_USER'),
          pass: env('SMTP_PASS'),
        },
      },
      settings: {
        defaultFrom: env('SMTP_FROM_EMAIL', env('SMTP_USER')),
        defaultReplyTo: env('SMTP_FROM_EMAIL', env('SMTP_USER')),
      },
    },
  },

  upload: {
    config: {
      security: {
        allowedTypes: allowedMediaTypes,
        deniedTypes: deniedExecutableTypes,
      },
    },
  },
});

export default config;
