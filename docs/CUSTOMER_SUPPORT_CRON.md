# Customer Support — Vercel (100% cloud)

Automatización completa en este repositorio (**wisdompackets_customer**). No requiere crontab local.

## Crons

| Endpoint | Schedule (UTC) | Función |
|----------|----------------|---------|
| `/api/customer-support-classify` | `0 * * * *` | IMAP → Gemini → Stripe → Gmail labels → cola Blob |
| `/api/customer-support-respond` | `15 * * * *` | Cola `PENDING_ACTION` → Stripe cancel → Resend → Gmail labels |

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
| `BETTERSTACK_SOURCE_TOKEN` | ✓ | ✓ |
| `BETTERSTACK_INGESTING_HOST` | ✓ | ✓ |

`BLOB_READ_WRITE_TOKEN` es **obligatorio** en producción (cola `customer-support/queue.json` en Vercel Blob).

Sin este token verás `EROFS: read-only file system` en Better Stack — el cron no puede guardar la cola.

Crear token: Vercel → Storage → Blob → copiar `BLOB_READ_WRITE_TOKEN` al proyecto **wisdompackets-customer** → Redeploy.

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

- Cada `console.log` / `warn` / `error` del clasificador y respondedor se replica a Better Stack.
- Cada `logRun()` envía un evento estructurado: `customer_support.IMAP_SYNC.SUCCESS`, etc.

Prueba local:

```bash
# En .env: BETTERSTACK_SOURCE_TOKEN y BETTERSTACK_INGESTING_HOST
npm run betterstack-ping
```

En Vercel: agregar las mismas variables en **Environment Variables** del proyecto.

## Ver logs en Vercel

1. [vercel.com](https://vercel.com) → proyecto **wisdompackets-customer**
2. **Logs** (tab superior) o **Deployments** → último deploy → **Functions**
3. Filtrar por `/api/customer-support-classify` o `/api/health`

Cada invocación ahora escribe `[customer-support-cron] classify invoked` con el estado de env vars (`hasBlob`, `betterStack`, etc.), **también si está fuera de horario**.

## Horario del cron

Solo procesa IMAP/Stripe entre **09:00–21:00 hora Denver** (`America/Denver`).  
Fuera de esa ventana responde `skipped: outside_business_hours` pero **sí genera logs**.

## Prueba manual

```bash
# Siempre genera log (sin auth)
curl https://wisdompackets-customer.vercel.app/api/health

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://wisdompackets-customer.vercel.app/api/customer-support-classify

curl -H "Authorization: Bearer $CRON_SECRET" \
  https://wisdompackets-customer.vercel.app/api/customer-support-respond
```

## Local (solo desarrollo)

```bash
cd customer_support
npm run classify   # opcional
npm run respond    # opcional
```

En producción no hace falta correr nada en la Mac.
