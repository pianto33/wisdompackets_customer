# 📖 Guía Operativa: Ejecución y Automatización de Soporte

Este documento describe paso a paso cómo configurar, probar y automatizar el sistema de atención al cliente de **WisdomPackets**.

---

## 🔑 1. Configuración de Gmail (Casilla IMAP)

Si utilizas Gmail o Google Workspace para tu cuenta de soporte (ej. `info@wisdompackets.com`), debes generar una **contraseña de aplicación** para permitir la conexión segura del script:

1. Ve a tu [Cuenta de Google](https://myaccount.google.com/).
2. En la barra de búsqueda superior, escribe **"Contraseñas de aplicación"** (App Passwords) o ve a **Seguridad** -> **Contraseñas de aplicación**.
   * *Nota: La verificación en dos pasos (2FA) debe estar activada en tu cuenta de Google para ver esta opción.*
3. Escribe un nombre descriptivo para identificarla (ej. `WP Support Automation`).
4. Haz clic en **Crear**. Google te proporcionará una clave de 16 caracteres.
5. Copia esa contraseña de 16 caracteres y colócala en tu archivo `.env` en la variable `IMAP_PASSWORD` (sin espacios).
6. Activa **IMAP** en Gmail: Configuración → Reenvío y POP/IMAP → **Activar IMAP** → Guardar.
7. Si enviás como otra dirección (ej. `noreply@wisdompackets.com`), configurala en **Enviar correo como** y verificála.

### Envío saliente (Gmail SMTP, recomendado)

1. La misma contraseña de aplicación sirve para SMTP (`SMTP_PASSWORD` o reutilizar `IMAP_PASSWORD`).
2. Variables: `EMAIL_PROVIDER=gmail`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=info@wisdompackets.com`.
3. `RESEND_FROM_EMAIL=noreply@wisdompackets.com` — remitente visible en respuestas automáticas.
4. Probar: `npm run test-email tu@email.com` y revisar **Enviados** en Gmail.

### Resend (opcional, fallback)

1. Verificá `wisdompackets.com` en [resend.com](https://resend.com).
2. `EMAIL_PROVIDER=resend` + `RESEND_API_KEY`.

---

## 🗓️ 2. Producción en Vercel (recomendado)

Todo el flujo corre en **wisdompackets_customer** (este repo) sin crontab local:

| Cron | Ruta | Qué hace |
|------|------|----------|
| :00 | `/api/customer-support-classify` | Clasifica mails a info@ **sin** label `WP/Clasificado`, taguea en Gmail, encola en Blob |
| :15 | `/api/customer-support-respond` | Cancela en Stripe, responde por Gmail SMTP (o Resend), actualiza labels |

Documentación: [`CUSTOMER_SUPPORT_CRON.md`](CUSTOMER_SUPPORT_CRON.md)  
Labels Gmail: [`GMAIL_LABELS.md`](GMAIL_LABELS.md)

Variables en Vercel: `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`, `GEMINI_API_KEY`, `IMAP_*`, `EMAIL_PROVIDER`, `SMTP_*`, `STRIPE_SECRET_KEY`, `RESEND_FROM_EMAIL`. (`RESEND_API_KEY` solo si `EMAIL_PROVIDER=resend`.)

Deploy: `vercel --prod` (desde la raíz de este repo)

---

## 🏃 3. Local (solo desarrollo / debug)

```bash
npm run classify
npm run respond
```

No es necesario en producción si los crons de Vercel están activos.

---

## 🧪 4. Ejecución del Simulador de Pruebas

Puedes validar y experimentar el comportamiento del flujo completo de manera segura y sin realizar llamadas a APIs reales ejecutando el simulador de entornos en cualquier momento:

```bash
npm run test-simulator
```

Esto generará los archivos simulados:
* `activity_logs/mock_queue.json` (cola persistente de simulación).
* `activity_logs/mock_runs.json` (registro de telemetría de simulación).
* Muestra de forma detallada en consola la carga e interpolación dinámica de tus plantillas de correo HTML (`templates/`).

---

## 🔑 5. Clave de API Restringida de Stripe

Para el funcionamiento seguro del sistema de automatización, se ha generado y configurado una **Clave de API Restringida** especial en tu panel de Stripe. Esta clave limita al mínimo indispensable el acceso del robot a tu cuenta de Stripe.

### Configuración
* Creá una **Restricted API Key** en el [Dashboard de Stripe](https://dashboard.stripe.com/apikeys) y cargala en Vercel / `.env` como `STRIPE_SECRET_KEY` (nunca commitear el valor real).

### Tabla de Permisos Asignados (Matriz de Seguridad):

| Tipo de Recurso | Sección | Nivel de Permiso | Finalidad Técnica |
| :--- | :--- | :--- | :--- |
| **`Customers`** | Core | **`Read`** | Permite buscar y relacionar al cliente por su dirección de email de origen. |
| **`Charges and Refunds`** | Core | **`Write`** | Permite leer recibos oficiales (`receipt_url`) y emitir reembolsos automáticos en el futuro. |
| **`Subscriptions`** | Billing | **`Write`** | Permite realizar la cancelación inmediata de la membresía premium del usuario en Stripe. |
| **`Invoices`** | Billing | **`Read`** | Permite listar las facturas del cliente para recuperar el último cargo facturado. |

