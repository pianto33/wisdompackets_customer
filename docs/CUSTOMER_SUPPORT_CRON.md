# Customer Support — Vercel (100% cloud)

Automatización completa en **`wisdompackets_customer`**. Los crons **solo** corren en este proyecto Vercel.

## Crons (único proyecto activo)

| Endpoint | Schedule (UTC) | Función |
|----------|----------------|---------|
| `/api/customer-support-classify` | `0 * * * *` | IMAP → Gemini → Stripe → Gmail labels → cola Blob |
| `/api/customer-support-respond` | `15 * * * *` | Cola `PENDING_ACTION` → Stripe cancel → Gmail SMTP → labels |

Ambos solo ejecutan entre **09:00–20:59** (`America/Denver`).

> **No** activar los mismos crons en `wisdompackets-webhooks`. Ese repo tenía rutas legacy `/api/cron/customer-support-*` que ya no están en su `vercel.json`.

## Variables de entorno (Vercel)

| Variable | Clasificador | Respond |
|----------|:------------:|:-------:|
| `CRON_SECRET` | ✓ | ✓ |
| `BLOB_READ_WRITE_TOKEN` | ✓ | ✓ |
| `GEMINI_API_KEY` | ✓ | |
| `IMAP_USER` / `IMAP_PASSWORD` / `IMAP_HOST` | ✓ | ✓ (labels) |
| `SMTP_USER` / `SMTP_PASSWORD` (o reutilizar IMAP) | ✓ | ✓ |
| `MAIL_FROM_ADDRESS` | | ✓ |
| `STRIPE_SECRET_KEY` | ✓ | ✓ |
| `ALERT_EMAIL_RECIPIENT` | | ✓ |
| `BETTERSTACK_SOURCE_TOKEN` | ✓ | ✓ |
| `BETTERSTACK_INGESTING_HOST` | ✓ | ✓ |

`BLOB_READ_WRITE_TOKEN` es **obligatorio** en producción (cola `customer-support/queue.json` en Vercel Blob).

## Deploy

```bash
vercel link
vercel --prod
```

Tras el deploy, en Vercel → Settings → Cron Jobs deben aparecer los dos paths.

## Labels Gmail

Ver [GMAIL_LABELS.md](./GMAIL_LABELS.md).

## Better Stack (logs)

Source: **wisdom-packets-customer**

## Ver logs en Vercel

1. [vercel.com](https://vercel.com) → proyecto **wisdompackets-customer**
2. **Logs** → filtrar por `/api/customer-support-classify` o `/api/health`

## Prueba manual

```bash
curl https://wisdompackets-customer.vercel.app/api/health

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://wisdompackets-customer.vercel.app/api/customer-support-classify

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://wisdompackets-customer.vercel.app/api/customer-support-respond
```

## Local (solo desarrollo)

```bash
npm run classify
npm run respond
npm run test-email tu@email.com
```
