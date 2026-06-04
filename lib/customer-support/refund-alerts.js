import { Resend } from 'resend';

const alertRecipient = process.env.ALERT_EMAIL_RECIPIENT || 'pianto33.tp@gmail.com';
const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@wisdompackets.com';

/**
 * Aviso al operador: hay un pedido de reembolso (el robot NO devuelve plata en Stripe).
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
  if (!process.env.RESEND_API_KEY) {
    console.warn('[refund-alert] RESEND_API_KEY missing — no se envió mail de alerta de reembolso');
    return { sent: false, reason: 'missing_resend' };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const confidencePct = ((confidence ?? 0) * 100).toFixed(0);
  const isAuto = queueStatus === 'PENDING_ACTION';

  console.log(
    `[refund-alert] Pedido de reembolso detectado — ${fromEmail} | escenario=${scenario} | auto=${isAuto}`
  );

  try {
    await resend.emails.send({
      from: `WisdomPackets Alerts <${fromEmail}>`,
      to: alertRecipient,
      subject: `[REEMBOLSO] ${fromEmail} — revisar devolución manual en Stripe`,
      html: `
        <h2>Pedido de cancelación + reembolso</h2>
        <p>El clasificador detectó <strong>Desuscripción + Refund</strong>. El sistema <strong>no</strong> ejecuta reembolsos automáticos en Stripe; solo puede cancelar la suscripción y enviar mail al cliente.</p>
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
