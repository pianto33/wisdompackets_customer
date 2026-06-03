# 📐 Arquitectura Técnica: Automatización de Soporte

Este documento detalla el diseño de la arquitectura y el flujo de datos del sistema de soporte al cliente automatizado de **WisdomPackets**.

## 🔀 Flujo de Datos General

El sistema opera bajo una arquitectura de **Cola Desacoplada (Decoupled Queue)**, lo que asegura que si una de las APIs externas (IMAP, Stripe, Resend o Gemini) falla temporalmente, las acciones pendientes no se pierdan y se reintenten en la siguiente ejecución.

```
+---------------+     IMAP     +----------------------+     Gemini API
| Casilla Email | ------------>| scripts/             | <------------> [Clasificación]
| (info@)       |              |   classify_emails.js |
+---------------+              +----------------------+
                                          |
                                          | Stripe API (Customer/Sub search)
                                          v
                               +----------------------+
                               |  activity_logs/      | (Cola persistente local)
                               |    queue.json        |
                               +----------------------+
                                          |
                                          | Read pending actions
                                          v
+---------------+     Resend   +----------------------+     Stripe API
| Respuestas    | <------------| scripts/             | <------------> [Cancelar Suscripción]
| al Cliente    |              |   respond_emails.js  |
+---------------+              +----------------------+
                                          |
                                          | Alert in case of Stripe failure
                                          v
                                   [pianto33.tp@gmail.com]
```

---

## 💾 Estructura y Esquemas de Base de Datos Local

### 1. Cola de Trabajo (`activity_logs/queue.json`)
Es una base de datos en archivo plano JSON estructurado de la siguiente forma:

* **`id`** (`string`): ID único del correo electrónico (Message-ID de IMAP). Evita el procesamiento duplicado (idempotencia).
* **`receivedAt`** (`string` - ISO Timestamp): Fecha y hora en la que el correo llegó a la bandeja de entrada.
* **`fromEmail`** (`string`): Dirección de correo del remitente.
* **`subject`** (`string`): Asunto del correo.
* **`bodySnippet`** (`string`): Primeros 150 caracteres del cuerpo del correo para trazabilidad y depuración rápida.
* **`classification`** (`string`): Determinado semánticamente por Gemini. Puede ser:
  * `"Desuscripción"`
  * `"Desuscripción + Refund"`
  * `"Otros"` (se marca como `NEEDS_HUMAN_REVIEW` + labels Gmail `WP/Otros` y `WP/Revisión-Humana`).
* **`stripeTag`** (`string`): Tag de control. Puede ser:
  * `"Found"`: Si localizamos al cliente y su suscripción en Stripe.
  * `"Not-Found"`: Si el correo no tiene un registro activo en Stripe.
* **`stripeCustomerId`** (`string` | `null`): ID de cliente en Stripe si se encuentra.
* **`stripeSubscriptionId`** (`string` | `null`): ID de suscripción activa en Stripe si se encuentra.
* **`status`** (`string`): Estado del flujo de atención. Valores posibles:
  * `"PENDING_ACTION"`: Listo para ser procesado por el respondedor.
  * `"NEEDS_HUMAN_REVIEW"`: Clasificado en `"Otros"`, no requiere acción del robot.
  * `"PROCESSED_SUCCESS"`: Cancelación exitosa en Stripe y correo enviado.
  * `"PROCESSED_NOT_FOUND"`: Correo enviado indicando cuenta no encontrada.
  * `"FAILED"`: Error durante la ejecución de Stripe o Resend (guarda detalles en `errorDetails`).
* **`processedAt`** (`string` | `null`): ISO Timestamp del momento en que se procesó la respuesta.
* **`errorDetails`** (`string` | `null`): Mensaje de error detallado en caso de fallo.

### 2. Historial de Ejecuciones (`activity_logs/runs.json`)
Registra cada corrida de los scripts en segundo plano para auditoría operativa y telemetría:
```json
[
  {
    "timestamp": "2026-05-27T10:00:00Z",
    "type": "IMAP_SYNC",
    "status": "SUCCESS",
    "emailsProcessedCount": 4
  },
  {
    "timestamp": "2026-05-27T10:01:00Z",
    "type": "EMAIL_RESPONDER",
    "status": "PARTIAL_SUCCESS",
    "actionsProcessedCount": 3,
    "successesCount": 2,
    "failuresCount": 1
  }
]
```

---

## 🦾 Seguridad e Idempotencia

1. **Idempotencia Absoluta**: Cada correo se mapea utilizando su cabecera `Message-ID` como clave primaria en la cola JSON. Esto asegura que si el script clasificador se ejecuta dos veces seguidas sobre el mismo correo, **no se creará una fila duplicada** en la cola y se previenen dobles cancelaciones o correos duplicados al cliente.
2. **Aislamiento de Errores**: Si Stripe o Resend fallan (por corte de red o credenciales incorrectas), el estado cambia a `FAILED` pero el registro permanece intacto en la cola para que pueda ser reintentado en la siguiente ejecución del Responder Script.
3. **Resguardo Humano**: Si la cancelación en Stripe de un cliente `Found` falla por motivos lógicos, se despacha un email de alerta inmediata a `pianto33.tp@gmail.com` con todos los metadatos estructurados para garantizar que el soporte manual resuelva la solicitud de forma inmediata.
