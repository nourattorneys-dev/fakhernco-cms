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
   * SMTP email via nodemailer.
   *
   * Strapi's default `sendmail` provider cannot reach an external SMTP relay,
   * so contact-form notifications and auto-replies would silently never send.
   * fakhernco.com's MX points at Microsoft 365, so SMTP_HOST is normally
   * smtp.office365.com on port 587 with an app credential.
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
