import { isEmailConfigured, sendAlertEmail } from './mail-sender.js';
import { getQueue } from './queue-store.js';

const alertRecipient = process.env.ALERT_EMAIL_RECIPIENT || 'pianto33.tp@gmail.com';

const REFUND_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function recentlyAlertedSameCustomer(fromEmail, queue) {
  const normalized = (fromEmail || '').trim().toLowerCase();
  const cutoff = Date.now() - REFUND_ALERT_COOLDOWN_MS;
  return queue.some(
    (item) =>
      item.fromEmail?.trim().toLowerCase() === normalized &&
      item.classification === 'Desuscripción + Refund' &&
      item.receivedAt &&
      new Date(item.receivedAt).getTime() > cutoff
  );
}

/**
 * Asunto explícito: qué hay que hacer y por qué llegó la alerta.
 */
export function buildRefundAlertSubject({ fromEmail, queueStatus, stripeTag }) {
  const who = fromEmail || 'cliente';

  if (queueStatus === 'NEEDS_HUMAN_REVIEW') {
    if (stripeTag === 'Found') {
      return `[ACCIÓN REQUERIDA] Cancelar/reembolsar en Stripe — ${who}`;
    }
    return `[ACCIÓN REQUERIDA] Pide refund sin cuenta Stripe — ${who}`;
  }

  if (queueStatus === 'PENDING_ACTION') {
    if (stripeTag === 'Found') {
      return `[STRIPE] Bot cancelará solo — evaluar reembolso después — ${who}`;
    }
    return `[INFO] Pide refund, sin Stripe — bot envía "no encontrada" — ${who}`;
  }

  return `[REEMBOLSO] Revisar devolución manual en Stripe — ${who}`;
}

function buildActionSummary({ queueStatus, stripeTag }) {
  if (queueStatus === 'NEEDS_HUMAN_REVIEW') {
    if (stripeTag === 'Found') {
      return 'El bot <strong>no puede actuar solo</strong> (action-guard o clasificación bloqueada). Tenés que cancelar la suscripción y/o reembolsar en Stripe manualmente, y responder al cliente si hace falta.';
    }
    return 'El cliente pide reembolso pero <strong>no hay suscripción activa</strong> con ese email en Stripe. Revisá el mail en Gmail, buscá el cargo por otros emails/tarjeta y respondé al cliente.';
  }

  if (queueStatus === 'PENDING_ACTION') {
    if (stripeTag === 'Found') {
      return 'El bot <strong>cancelará la suscripción</strong> y enviará mail con link al recibo. Esta alerta es porque el sistema <strong>no devuelve plata automáticamente</strong>: evaluá si hay que hacer <strong>refund manual en Stripe</strong>.';
    }
    return 'El bot enviará <strong>"Suscripción no encontrada"</strong>. Si el cliente igual pide devolución de un cargo, buscá el pago en Stripe y respondé manualmente.';
  }

  return 'Pedido de baja + reembolso detectado. El sistema no ejecuta refunds automáticos en Stripe.';
}

/**
 * Aviso al operador: hay un pedido de reembolso (el robot NO devuelve plata en Stripe).
 * Se envía una sola vez por cliente/24h al clasificar — no se repite en el cron respond.
 */
export async function notifyRefundRequest({
  fromEmail,
  subject,
  confidence,
  queueStatus,
  stripeTag,
  bodySnippet,
  scenario,
}) {
  if (!isEmailConfigured()) {
    console.warn('[refund-alert] Email not configured — no se envió mail de alerta de reembolso');
    return { sent: false, reason: 'missing_email' };
  }

  const queue = await getQueue();
  if (recentlyAlertedSameCustomer(fromEmail, queue)) {
    console.log(`[refund-alert] skip duplicate for ${fromEmail} (already alerted in last 24h)`);
    return { sent: false, reason: 'duplicate_within_24h' };
  }

  const confidencePct = ((confidence ?? 0) * 100).toFixed(0);
  const isAuto = queueStatus === 'PENDING_ACTION';

  console.log(
    `[refund-alert] Pedido de reembolso detectado — ${fromEmail} | escenario=${scenario} | auto=${isAuto}`
  );

  try {
    const alertSubject = buildRefundAlertSubject({ fromEmail, queueStatus, stripeTag });
    const actionSummary = buildActionSummary({ queueStatus, stripeTag });

    await sendAlertEmail({
      to: alertRecipient,
      subject: alertSubject,
      html: `
        <h2>Pedido de cancelación + reembolso</h2>
        <p style="background:#fff3cd;border-left:4px solid #ffc107;padding:12px 16px;border-radius:4px;">
          <strong>Qué necesitamos de vos:</strong> ${actionSummary}
        </p>
        <p>El clasificador detectó <strong>Desuscripción + Refund</strong> en un mail entrante a soporte.</p>
        <ul>
          <li><strong>Cliente:</strong> ${fromEmail}</li>
          <li><strong>Asunto:</strong> ${subject || '(sin asunto)'}</li>
          <li><strong>Confianza Gemini:</strong> ${confidencePct}%</li>
          <li><strong>Escenario:</strong> ${scenario}</li>
          <li><strong>Estado cola:</strong> ${queueStatus}</li>
          <li><strong>Stripe:</strong> ${stripeTag}</li>
          <li><strong>¿Procesará el bot solo?:</strong> ${isAuto ? 'Sí (cancelación + email con link recibo)' : 'No — revisión humana en Gmail (WP/Revisión-Humana)'}</li>
        </ul>
        <p><strong>Extracto del mail:</strong></p>
        <pre style="background:#f4f4f4;padding:12px;border-radius:8px;">${(bodySnippet || '').replace(/</g, '&lt;')}</pre>
        <p>Acción sugerida: entrá a Stripe → Customers → buscar <code>${fromEmail}</code> → evaluar reembolso del último cargo si corresponde.</p>
        <p>También podés filtrar en Gmail: <code>label:WP/Desuscripción+Refund</code></p>
      `,
    });
    return { sent: true };
  } catch (err) {
    console.error('[refund-alert] Falló envío de alerta:', err.message);
    return { sent: false, reason: err.message };
  }
}
