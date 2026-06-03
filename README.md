# 🤖 WisdomPackets — Automatización de Atención al Cliente (Customer Support)

Este subproyecto autocontenido gestiona el flujo de soporte técnico y facturación de **WisdomPackets** de forma automatizada e inteligente. Utiliza **Gemini API** para la clasificación semántica de correos, **Stripe API** para la gestión de suscripciones y cancelaciones, e **IMAP + Resend** para la bandeja de entrada y respuestas transaccionales automáticas.

## 📁 Arquitectura del Proyecto

El sistema se organiza en la siguiente estructura:

* **`docs/`**: Documentación operativa y diseño técnico detallado.
* **`prompts/`**: Prompts de ingeniería de lenguaje optimizados para clasificación.
* **`templates/`**: Plantillas HTML premium inline y responsivas para respuestas automáticas.
* **`activity_logs/`**: Cola persistente local en formato JSON (`queue.json`) y registros de ejecución (`runs.json`).
* **`scripts/`**: Los dos scripts principales (`classify_emails.js` y `respond_emails.js`), además de herramientas de prueba.

---

## 🔄 Flujo de Trabajo Operativo

El sistema está dividido en dos etapas independientes que garantizan la resiliencia offline de las APIs externas:

### 1. Clasificación y Encolado (`npm run classify`)
Este script se conecta a tu casilla de soporte (ej: `info@wisdompackets.com`) usando **IMAP**:
1. Trae los correos no leídos y los analiza.
2. Llama a **Gemini** (`gemini-2.5-flash`) para determinar la intención del usuario y clasificarla en:
   * **`Desuscripción`**: El usuario solicita dar de baja su membresía premium.
   * **`Desuscripción + Refund`**: El usuario solicita la baja y además exige la devolución de su último pago.
   * **`Otros`**: Consultas generales o spam (estos correos se marcan como leídos pero se ignoran de acciones automatizadas para que un agente humano los responda).
3. Si el correo califica para desuscripción, **busca al usuario en Stripe** usando su dirección de email.
4. Registra el correo en la cola local (`activity_logs/queue.json`) con las etiquetas:
   * **`Found`**: Se localizó una suscripción activa o trialing en Stripe (guarda los IDs).
   * **`Not-Found`**: No se localizó ninguna suscripción vinculada a ese email.

### 2. Ejecución de Acción y Respuesta (`npm run respond`)
Este script toma los elementos pendientes de la cola local (`activity_logs/queue.json`) y ejecuta las acciones pertinentes:
* Si el elemento es **`Not-Found`**: Envía el correo automático con la plantilla `suscription-not-found` informando que no pudimos ubicar su cuenta y solicitando más detalles.
* Si el elemento es **`Found`**:
  * Ejecuta la **cancelación inmediata de la suscripción en Stripe**.
  * Si la cancelación **falla** (error de red o de API): Envía un correo de alerta de máxima prioridad a `pianto33.tp@gmail.com` con todos los detalles del error para que se resuelva manualmente.
  * Si la cancelación **tiene éxito**:
    * Envía la plantilla `succesful-unsuscription` si se clasificó como `Desuscripción`.
    * Envía la plantilla `succesful-unsuscription-refund-link` si se clasificó como `Desuscripción + Refund` (con detalles para gestionar su reembolso).

---

## 🛠️ Cómo Empezar y Configuración

1. **Instalar Dependencias**:
   ```bash
   npm install
   ```

2. **Configurar Variables de Entorno**:
   Renombra `.env.example` a `.env` y completa con las credenciales reales:
   * `STRIPE_SECRET_KEY`: Tu clave secreta de administración de Stripe.
   * `RESEND_API_KEY`: Clave de envío de Resend.
   * `GEMINI_API_KEY`: Clave API para el clasificador de Inteligencia Artificial.
   * `IMAP_USER` / `IMAP_PASSWORD`: Dirección y contraseña de aplicación de tu casilla (ej. Gmail App Password).

3. **Ejecutar Pruebas Simuladas**:
   Puedes probar el sistema completo con correos ficticios (sin IMAP real) ejecutando el simulador:
   ```bash
   npm run test-simulator
   ```

4. **Producción (Vercel)**:
   ```bash
   vercel link   # proyecto wisdompackets_customer
   vercel --prod
   ```
   Ver `docs/CUSTOMER_SUPPORT_CRON.md` y `docs/GMAIL_LABELS.md`.
