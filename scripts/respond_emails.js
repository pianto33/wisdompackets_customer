import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import { enableBetterStackConsoleMirror } from '../lib/customer-support/betterstack.js';
enableBetterStackConsoleMirror();

export { runResponder } from '../lib/customer-support/respond.js';

import { runResponder } from '../lib/customer-support/respond.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runResponder().catch(console.error);
}
