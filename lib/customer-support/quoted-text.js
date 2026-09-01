/**
 * Separating what the customer just wrote from the thread they quoted.
 *
 * Intent has to be read off the new text only. A reply that just says "thanks"
 * still quotes the original "cancel my subscription", so matching keywords on
 * the whole body re-triggers a cancellation that already happened.
 */

/** Line openers Gmail and Outlook put above the quoted thread, per language. */
const QUOTE_MARKERS = [
  'On .+ wrote:',
  'El .+ escribió:',
  'Le .+ a écrit:',
  'Am .+ schrieb:',
  'Il .+ ha scritto:',
  'Op .+ schreef',
  'Dne .+ napsal',
  'W dniu .+ napisał',
  'Em .+ escreveu:',
  '.+ ezt írta \\(időpont:',
  'De: ',
  'From: ',
  '-{2,}\\s*(?:Original Message|Ursprüngliche Nachricht|Mensaje original|อีเมลต้นฉบับ)',
  '-----Original Message-----',
  '_{5,}',
];

const QUOTE_SPLIT = new RegExp(`\\n(?:${QUOTE_MARKERS.join('|')})`, 'i');

/**
 * @param {string} subject
 * @param {string} body
 * @returns {string} subject plus the unquoted part of the body
 */
export function extractOwnPart(subject, body) {
  const raw = `${subject || ''}\n${body || ''}`;
  return raw
    .replace(/^re:\s*/i, '')
    .split(QUOTE_SPLIT)[0]
    .replace(/^>.*$/gm, '')
    .trim();
}
