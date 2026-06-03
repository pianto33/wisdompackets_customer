# Customer Support — Vercel (100% cloud)

Automatización completa en este repositorio (**wisdompackets_customer**). No requiere crontab local.

## Crons

| Endpoint | Schedule (UTC) | Función |
|----------|----------------|---------|
| `/api/cron/customer-support-classify` | `0 * * * *` | IMAP → Gemini → Stripe → Gmail labels → cola Blob |
| `/api/cron/customer-support-respond` | `15 * * * *` | Cola `PENDING_ACTION` → Stripe cancel → Resend → Gmail labels |

Ambos solo ejecutan entre **09:00–20:59** (`America/Denver`).

## Variables de entorno (Vercel)

| Variable | Clasificador | Respond |
|----------|:------------:|:-------:|
| `CRON_SECRET` | ✓ | ✓ |
| `BLOB_READ_WRITE_TOKEN` | ✓ | ✓ |
| `GEMINI_API_KEY` | ✓ | |
| `IMAP_USER` / `IMAP_PASSWORD` / `IMAP_HOST` | ✓ | ✓ (labels) |
| `STRIPE_SECRET_KEY` | ✓ | ✓ |
| `RESEND_API_KEY` | | ✓ |
| `RESEND_FROM_EMAIL` | | ✓ |
| `ALERT_EMAIL_RECIPIENT` | | ✓ |

`BLOB_READ_WRITE_TOKEN` es **obligatorio** en producción (cola `customer-support/queue.json` en Vercel Blob).

## Deploy

```bash
vercel link
vercel --prod
```

Tras el deploy, en Vercel → Settings → Cron Jobs deben aparecer los dos paths.

## Labels Gmail

Ver [GMAIL_LABELS.md](./GMAIL_LABELS.md).

## Prueba manual

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<tu-dominio>/api/cron/customer-support-classify

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<tu-dominio>/api/cron/customer-support-respond
```

## Local (solo desarrollo)

```bash
cd customer_support
npm run classify   # opcional
npm run respond    # opcional
```

En producción no hace falta correr nada en la Mac.
