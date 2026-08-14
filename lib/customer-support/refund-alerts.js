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
      return `[STRIPE] Bot cancelará + intentará auto-refund (tope 5 bot / 12 total) — ${who}`;
    }
    return `[INFO] Pide refund, sin Stripe — bot envía "no encontrada" — ${who}`;
  }

  return `[REEMBOLSO] Revisar devolución en Stripe — ${who}`;
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
      return 'El bot <strong>cancelará la suscripción</strong>, enviará mail con link al recibo e <strong>intentará auto-refund</strong> del último pago (≤30 días) si no se alcanzó el tope 5 bot / 12 totales en 24h.';
    }
    return 'El bot enviará <strong>"Suscripción no encontrada"</strong>. Si el cliente igual pide devolución de un cargo, buscá el pago en Stripe y respondé manualmente.';
  }

  return 'Pedido de baja + reembolso detectado.';
}

/**
 * Alerta post-respond (sin cooldown): resultado del auto-refund.
 * @param {{
 *   fromEmail: string,
 *   subject?: string,
 *   outcome: 'executed'|'cap_bot'|'cap_total'|'policy'|'disabled'|'error',
 *   detail?: string,
 *   refundId?: string,
 *   chargeId?: string,
 *   botCount?: number,
 *   totalCount?: number,
 * }} input
 */
export async function notifyAutoRefundOutcome(input) {
  if (!isEmailConfigured()) {
    return { sent: false, reason: 'missing_email' };
  }

  const {
    fromEmail,
    subject,
    outcome,
    detail,
    refundId,
    chargeId,
    botCount,
    totalCount,
  } = input;

  const titles = {
    executed: `[INFO] Auto-refund OK — ${fromEmail}`,
    cap_bot: `[ACCIÓN] Refund pendiente — tope bot 24h — ${fromEmail}`,
    cap_total: `[ACCIÓN] Refund pendiente — tope total 24h — ${fromEmail}`,
    policy: `[ACCIÓN] Refund no auto (política) — ${fromEmail}`,
    disabled: `[INFO] Auto-refund desactivado — ${fromEmail}`,
    error: `[ALERTA] Falló auto-refund — ${fromEmail}`,
  };

  const bodies = {
    executed: 'El bot ejecutó el reembolso del último pago en Stripe.',
    cap_bot:
      'Cancelación + mail enviados. <strong>No se reembolsó</strong>: se alcanzó el tope de refunds del bot en 24h. Hacé el refund manual en Stripe.',
    cap_total:
      'Cancelación + mail enviados. <strong>No se reembolsó</strong>: se alcanzó el tope total de refunds (bot+manual) en 24h. Hacé el refund manual en Stripe.',
    policy:
      'Cancelación + mail enviados. <strong>No se reembolsó</strong> por política (sin cargo / >30 días / no último). Revisá en Stripe.',
    disabled: 'Auto-refund desactivado por env. Cancelación + mail enviados; evaluá refund manual.',
    error: `Falló el auto-refund: ${detail || 'error desconocido'}. Revisá Stripe.`,
  };

  try {
    await sendAlertEmail({
      to: alertRecipient,
      subject: titles[outcome] || titles.error,
      html: `
        <h2>Auto-refund — resultado</h2>
        <p>${bodies[outcome] || bodies.error}</p>
        <ul>
          <li><strong>Cliente:</strong> ${fromEmail}</li>
          <li><strong>Asunto:</strong> ${subject || '(sin asunto)'}</li>
          <li><strong>Outcome:</strong> ${outcome}</li>
          ${refundId ? `<li><strong>Refund:</strong> ${refundId}</li>` : ''}
          ${chargeId ? `<li><strong>Charge:</strong> ${chargeId}</li>` : ''}
          ${botCount != null ? `<li><strong>Bot refunds 24h:</strong> ${botCount}</li>` : ''}
          ${totalCount != null ? `<li><strong>Total refunds 24h:</strong> ${totalCount}</li>` : ''}
          ${detail ? `<li><strong>Detalle:</strong> ${String(detail).replace(/</g, '&lt;')}</li>` : ''}
        </ul>
      `,
    });
    return { sent: true };
  } catch (err) {
    console.error('[refund-alert] notifyAutoRefundOutcome failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Aviso al clasificar: pedido de reembolso (el respond intentará auto-refund si política + tope OK).
 * Una sola vez por cliente/24h — no se repite en respond (ahí usa notifyAutoRefundOutcome).
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
          <li><strong>¿Procesará el bot solo?:</strong> ${isAuto ? 'Sí (cancelación + email; auto-refund si política + tope OK)' : 'No — revisión humana en Gmail (WP/Revisión-Humana)'}</li>
        </ul>
        <p><strong>Extracto del mail:</strong></p>
        <pre style="background:#f4f4f4;padding:12px;border-radius:8px;">${(bodySnippet || '').replace(/</g, '&lt;')}</pre>
        <p>Acción sugerida: entrá a Stripe → Customers → buscar <code>${fromEmail}</code>.</p>
        <p>También podés filtrar en Gmail: <code>label:WP/Desuscripción+Refund</code></p>
      `,
    });
    return { sent: true };
  } catch (err) {
    console.error('[refund-alert] Falló envío de alerta:', err.message);
    return { sent: false, reason: err.message };
  }
}
