/**
 * Prueba de conexión con Better Stack (source wisdom-packets-customer).
 * Uso: npm run betterstack-ping
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { betterStack } from '../lib/customer-support/betterstack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

if (!betterStack.isEnabled()) {
  console.error('Falta BETTERSTACK_SOURCE_TOKEN en .env');
  process.exit(1);
}

await betterStack.info('Hello from wisdompackets-customer — ping OK', {
  source: 'betterstack-ping',
  host: process.env.BETTERSTACK_INGESTING_HOST,
});

console.log('Log enviado. Revisá el source wisdom-packets-customer en Better Stack.');
