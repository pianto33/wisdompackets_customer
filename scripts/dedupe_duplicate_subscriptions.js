/**
 * Detecta emails con 2+ suscripciones billable (active / trialing / past_due)
 * y cancela las duplicadas conservando la mejor candidata.
 *
 * Regla de conservación:
 * 1. Con payment method
 * 2. Mejor estado: active > trialing > past_due
 * 3. Empate → la más antigua
 *
 * Uso:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/dedupe_duplicate_subscriptions.js
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/dedupe_duplicate_subscriptions.js --dry-run
 */
import "dotenv/config";
import Stripe from "stripe";

const BILLABLE = new Set(["active", "trialing", "past_due"]);
const dryRun = process.argv.includes("--dry-run");

const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_PRIVATE_KEY;
if (!stripeKey) {
  console.error("Falta STRIPE_SECRET_KEY o STRIPE_PRIVATE_KEY");
  process.exit(1);
}

const stripe = new Stripe(stripeKey);

const STATUS_PRIORITY = { active: 3, trialing: 2, past_due: 1 };

function keepScore(sub) {
  const hasPm = sub.default_payment_method ? 1 : 0;
  const statusScore = STATUS_PRIORITY[sub.status] ?? 0;
  return hasPm * 100 + statusScore * 10 - sub.created;
}

async function listAllSubscriptions(status) {
  const subs = [];
  for await (const sub of stripe.subscriptions.list({ status, limit: 100 }).autoPagingIter()) {
    subs.push(sub);
  }
  return subs;
}

async function customerEmail(customerId) {
  const c = await stripe.customers.retrieve(customerId);
  if ("deleted" in c && c.deleted) return null;
  return c.email || null;
}

async function main() {
  console.log(dryRun ? "DRY RUN — no se cancelará nada" : "LIVE — se cancelarán duplicados");

  const byEmail = new Map();

  for (const status of BILLABLE) {
    const subs = await listAllSubscriptions(status);
    for (const sub of subs) {
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const email = await customerEmail(customerId);
      if (!email) continue;
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(sub);
    }
  }

  let dupEmails = 0;
  let canceled = 0;

  for (const [email, subs] of byEmail) {
    if (subs.length < 2) continue;
    dupEmails++;

    const sorted = [...subs].sort((a, b) => keepScore(b) - keepScore(a));
    const keep = sorted[0];
    const toCancel = sorted.slice(1);

    console.log(`\n${email}: ${subs.length} subs billable → conservar ${keep.id} (${keep.status})`);
    for (const sub of toCancel) {
      console.log(`  cancelar ${sub.id} (${sub.status})`);
      if (!dryRun) {
        await stripe.subscriptions.cancel(sub.id);
        canceled++;
      }
    }
  }

  console.log(`\nEmails con duplicados: ${dupEmails}`);
  console.log(dryRun ? `Se cancelarían: ${canceled}` : `Canceladas: ${canceled}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
