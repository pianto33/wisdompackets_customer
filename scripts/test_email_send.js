/**
 * Prueba de envío saliente vía Gmail SMTP.
 * Uso:
 *   node scripts/test_email_send.js [destino@email.com]
 *   node scripts/test_email_send.js [destino] [message-id-del-mail-original]
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildReplySubject,
  isEmailConfigured,
  sendSupportEmail,
} from '../lib/customer-support/mail-sender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const to = process.argv[2] || process.env.ALERT_EMAIL_RECIPIENT || 'pianto33.tp@gmail.com';
const inReplyTo = process.argv[3] || process.env.TEST_IN_REPLY_TO || null;
const originalSubject = process.env.TEST_ORIGINAL_SUBJECT || 'Consulta soporte WisdomPackets';

if (!isEmailConfigured()) {
  console.error('Email no configurado. Revisá SMTP_USER/SMTP_PASSWORD o IMAP_USER/IMAP_PASSWORD en .env');
  process.exit(1);
}

console.log('Provider: gmail');
console.log(`Enviando test a ${to}...`);
if (inReplyTo) console.log(`Threading In-Reply-To: ${inReplyTo}`);

const result = await sendSupportEmail({
  to,
  subject: buildReplySubject(originalSubject),
  html: `
    <p>Respuesta de prueba del bot de soporte WisdomPackets.</p>
    <p>Si configuraste el Message-ID original, esto debería aparecer en el <strong>mismo hilo</strong> en Gmail.</p>
    <p>Timestamp: ${new Date().toISOString()}</p>
  `,
  inReplyTo,
});

console.log('OK:', result);
