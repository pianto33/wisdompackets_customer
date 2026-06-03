import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import { enableBetterStackConsoleMirror } from '../lib/customer-support/betterstack.js';
enableBetterStackConsoleMirror();

export {
  getQueue,
  saveQueue,
  logRun,
  processEmail,
  runClassifier,
} from '../lib/customer-support/classify.js';

import { runClassifier } from '../lib/customer-support/classify.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runClassifier().catch(console.error);
}
