# Gmail labels — Customer Support

## Regla operativa

Todo correo a **info@wisdompackets.com** que **no** tenga el label `WP/Clasificado` debe revisarse (leído o no leído).

El clasificador (cron cada hora) busca con:

```text
to:info@wisdompackets.com -label:"WP/Clasificado"
```

## Labels actuales (propuesta implementada)

| Label | Quién lo aplica | Significado |
|-------|-----------------|-------------|
| `WP/Clasificado` | Clasificador | El robot ya analizó el mail |
| `WP/Desuscripción` | Clasificador | Pedido de baja |
| `WP/Desuscripción+Refund` | Clasificador | Baja + reembolso |
| `WP/Otros` | Clasificador | Consultas, spam, feedback, etc. |
| `WP/Revisión-Humana` | Clasificador / Respond (error) | Requiere respuesta manual |
| `WP/Stripe-Found` | Clasificador | Cliente/suscripción localizada en Stripe |
| `WP/Stripe-NotFound` | Clasificador | No hay suscripción activa con ese email |
| `WP/Pendiente-Respuesta` | Clasificador | En cola para el cron respond (:15) |
| `WP/Respondido-Auto` | Respond | Cancelación + email automático OK |
| `WP/Respondido-SinCuenta` | Respond | Email “no encontramos suscripción” |
| `WP/Error` | Respond | Falló Stripe/Resend; revisar alerta |
| `WP/Archivado` | Clasificador | Mail procesado desde INBOX (opcional) |

La carpeta **WisdomPackets Support** ya no se usa por IMAP (fallaba en serverless); la organización es solo con labels `WP/*`.

## Estados en cola JSON (Blob)

| `status` | Significado |
|----------|-------------|
| `PENDING_ACTION` | Esperando cron respond |
| `NEEDS_HUMAN_REVIEW` | `Otros` — solo tags, sin robot de respuesta |
| `PROCESSED_SUCCESS` | Baja automática completada |
| `PROCESSED_NOT_FOUND` | Respondido sin cuenta Stripe |
| `FAILED` | Error — reintento en próximo respond |

## Tags históricos (solo cola, no Gmail)

Antes solo existían en `queue.json`:

- `classification`: Desuscripción | Desuscripción + Refund | Otros
- `stripeTag`: Found | Not-Found
- `status`: incluía `IGNORED` (reemplazado por `NEEDS_HUMAN_REVIEW`)
