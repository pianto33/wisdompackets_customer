# Seguridad: evitar cancelaciones o reembolsos “porque sí”

El LLM **solo clasifica**. Las acciones destructivas pasan por `action-guard.js`.

## Capas de defensa

| Capa | Qué hace |
|------|----------|
| 1. Prompt conservador | Gemini duda → `Otros` |
| 2. `evaluateAutomatedAction` | Tras clasificar: confianza mínima + palabras clave en el mail |
| 3. Cola `NEEDS_HUMAN_REVIEW` | Si falla el guard, no entra a `PENDING_ACTION` |
| 4. `assertStripeCancelAllowed` | El respondedor vuelve a validar antes de `stripe.subscriptions.cancel` |
| 5. Alerta email | Si el respondedor bloquea, avisa a `ALERT_EMAIL_RECIPIENT` |

## Reembolsos de dinero

**El robot no ejecuta `stripe.refunds.create`.**  
`Desuscripción + Refund` solo cancela la suscripción y envía un mail con enlace al recibo; el reembolso lo hacés vos en Stripe si corresponde.

## Variables de entorno

| Variable | Default | Efecto |
|----------|---------|--------|
| `STRIPE_AUTO_CANCEL_ENABLED` | `true` | `false` = nunca cancela en Stripe (modo auditoría) |
| `AUTO_CANCEL_MIN_CONFIDENCE` | `0.88` | Confianza mínima de Gemini para auto-cancel |

## Palabras que debe contener el mail (regex)

**Baja:** cancelar, unsubscribe, dar de baja, no quiero la suscripción, etc.

**Reembolso (además de baja):** reembolso, devolución, refund, money back, etc.

Si Gemini dice “Desuscripción” pero el texto no tiene esas frases → `WP/Revisión-Humana`, sin cancelar.

## Modo “solo etiquetar” (recomendado para probar)

```env
STRIPE_AUTO_CANCEL_ENABLED=false
```

Clasifica y etiqueta en Gmail, pero **cero** cancelaciones en Stripe hasta que lo actives.
