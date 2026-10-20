/**
 * Outbound mail for registration, password reset, and email change.
 * With no SMTP_HOST the message is logged in development and skipped otherwise.
 */
import {createTransport} from 'nodemailer';
import type {Config} from './config';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function createMailer(config: Config): Mailer {
  if (!config.smtp.host) {
    return {
      async send(to, subject, text) {
        if (config.devLogSecrets) {
          console.log(`[mail] to=${to} subject=${subject}\n${text}`);
        } else {
          console.log(`[mail] SMTP is not configured; skipped message to ${to}`);
        }
      },
    };
  }
  const transport = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: config.smtp.user ? {user: config.smtp.user, pass: config.smtp.pass} : undefined,
  });
  return {
    async send(to, subject, text) {
      await transport.sendMail({from: config.smtp.from, to, subject, text});
    },
  };
}
