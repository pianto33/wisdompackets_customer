import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mockQueuePath = path.join(__dirname, '../activity_logs/mock_queue.json');
const mockRunsPath = path.join(__dirname, '../activity_logs/mock_runs.json');
const templatesDir = path.join(__dirname, '../templates');

// Realistic mock emails for our 4 scenarios
const mockEmails = [
  {
    messageId: 'mock_msg_101',
    fromEmail: 'rodrigo.test.found@example.com',
    subject: 'Hola, solicito dar de baja mi suscripcion por favor',
    body: 'Hola equipo de WisdomPackets. No tengo tiempo para leer los libros ultimamente asi que me gustaria dar de baja mi suscripcion mensual premium. Saludos, Rodrigo.'
  },
  {
    messageId: 'mock_msg_102',
    fromEmail: 'maria.test.refund@example.com',
    subject: 'Quiero cancelar y reembolso de mi pago',
    body: 'Hola. Ayer se me cobro la suscripcion automatica pero yo queria cancelarla antes. Por favor cancelen mi cuenta y hagan la devolucion de mi dinero a la tarjeta cuanto antes. Gracias.'
  },
  {
    messageId: 'mock_msg_103',
    fromEmail: 'juan.test.notfound@example.com',
    subject: 'solicitud de baja de cuenta',
    body: 'Quiero cancelar mi cuenta premium, gracias.'
  },
  {
    messageId: 'mock_msg_104',
    fromEmail: 'sofia.info@example.com',
    subject: '¿Tienen el libro Hábitos Atómicos?',
    body: 'Hola! Estaba viendo su catálogo y quería saber si tienen el resumen del libro Hábitos Atómicos en español y si viene con audiolibro. Quedo atenta, gracias!'
  }
];

// Mock Stripe Database
const mockStripeDb = {
  'rodrigo.test.found@example.com': {
    customerId: 'cus_R0dr1g0_P1ant0',
    subscriptionId: 'sub_active_premium_123',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + (15 * 24 * 60 * 60) // 15 days from now
  },
  'maria.test.refund@example.com': {
    customerId: 'cus_Mar1a_Refund_999',
    subscriptionId: 'sub_active_premium_456',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + (29 * 24 * 60 * 60) // 29 days from now
  }
};

// Mock LLM Gemini Classifier
function mockGeminiClassifier(subject, body) {
  const combined = (subject + ' ' + body).toLowerCase();
  
  if (combined.includes('reembolso') || combined.includes('devolucion') || combined.includes('devolver')) {
    return {
      classification: 'Desuscripción + Refund',
      confidence: 0.98,
      reasoning: 'El usuario solicita explícitamente cancelar la membresía y exige la devolución/reembolso del cobro.'
    };
  }
  
  if (combined.includes('baja') || combined.includes('cancelar') || combined.includes('desuscripcion') || combined.includes('cancelen')) {
    return {
      classification: 'Desuscripción',
      confidence: 0.95,
      reasoning: 'El usuario expresa claramente el deseo de dar de baja o cancelar su suscripción premium.'
    };
  }

  return {
    classification: 'Otros',
    confidence: 0.92,
    reasoning: 'El correo es una consulta informativa sobre disponibilidad de libros y no solicita baja de cuenta.'
  };
}

/**
 * SIMULATED STEP 1: Classifier Script
 */
async function simulateClassifier() {
  console.log('\n==================================================');
  console.log('🤖 SIMULACIÓN - PASO 1: CLASIFICADOR DE CORREOS');
  console.log('==================================================');

  const queue = [];

  for (const email of mockEmails) {
    console.log(`\n--------------------------------------------------`);
    console.log(`📥 Recibido correo de: \x1b[36m${email.fromEmail}\x1b[0m`);
    console.log(`Asunto: "${email.subject}"`);
    console.log(`Cuerpo: "${email.body.substring(0, 80)}..."`);
    
    // 1. Classify
    console.log(' -> Clasificando con Gemini AI...');
    const result = mockGeminiClassifier(email.subject, email.body);
    console.log(`    \x1b[32m[Gemini]\x1b[0m Categoría: \x1b[1m${result.classification}\x1b[0m (Confianza: ${result.confidence * 100}%)`);
    console.log(`    Razonamiento: "${result.reasoning}"`);

    let stripeTag = 'Not-Found';
    let stripeCustomerId = null;
    let stripeSubscriptionId = null;

    // 2. Stripe check
    if (['Desuscripción', 'Desuscripción + Refund'].includes(result.classification)) {
      console.log(' -> Buscando cliente en Stripe...');
      const customer = mockStripeDb[email.fromEmail];
      if (customer) {
        stripeTag = 'Found';
        stripeCustomerId = customer.customerId;
        stripeSubscriptionId = customer.subscriptionId;
        console.log(`    \x1b[32m[Stripe]\x1b[0m Cliente ENCONTRADO. ID: ${stripeCustomerId}, Sub: ${stripeSubscriptionId}`);
      } else {
        console.log(`    \x1b[31m[Stripe]\x1b[0m Cliente NO encontrado.`);
      }
    }

    // 3. Save
    const queueItem = {
      id: email.messageId,
      receivedAt: new Date().toISOString(),
      fromEmail: email.fromEmail,
      subject: email.subject,
      bodySnippet: email.body.substring(0, 150),
      classification: result.classification,
      stripeTag,
      stripeCustomerId,
      stripeSubscriptionId,
      status: result.classification === 'Otros' ? 'NEEDS_HUMAN_REVIEW' : 'PENDING_ACTION',
      processedAt: null,
      errorDetails: null
    };

    queue.push(queueItem);
  }

  // Write mock queue to disk
  fs.writeFileSync(mockQueuePath, JSON.stringify(queue, null, 2), 'utf-8');
  console.log(`\n\x1b[32m✔ Se guardaron ${queue.length} elementos clasificados en mock_queue.json\x1b[0m`);
}

/**
 * SIMULATED STEP 2: Responder Script
 */
async function simulateResponder() {
  console.log('\n==================================================');
  console.log('📨 SIMULACIÓN - PASO 2: RESPONDEDOR DE CORREOS');
  console.log('==================================================');

  if (!fs.existsSync(mockQueuePath)) {
    console.error('No se encontró el archivo de cola simulado.');
    return;
  }

  const queue = JSON.parse(fs.readFileSync(mockQueuePath, 'utf-8'));
  const pendingItems = queue.filter(item => item.status === 'PENDING_ACTION');

  console.log(`Procesando ${pendingItems.length} acciones de soporte pendientes...`);

  for (const item of pendingItems) {
    console.log(`\n--------------------------------------------------`);
    console.log(`⚙️ Procesando cola para: \x1b[36m${item.fromEmail}\x1b[0m`);
    console.log(`   Clasificación: "${item.classification}" | Stripe Tag: "${item.stripeTag}"`);

    if (item.stripeTag === 'Not-Found') {
      // CASE A: Subscription Not Found
      console.log(' -> Cargando plantilla "suscription-not-found.html"...');
      const templatePath = path.join(templatesDir, 'suscription-not-found.html');
      let html = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : 'Template not found';
      html = html.replace('{{CUSTOMER_EMAIL}}', item.fromEmail);

      console.log(` -> \x1b[32m[SMTP]\x1b[0m Enviando correo automatico a ${item.fromEmail}...`);
      console.log(`    Asunto: "Suscripción no encontrada - WisdomPackets"`);
      console.log(`    \x1b[90m(Simulación: El email informará que no se ubicó su cuenta)\x1b[0m`);

      item.status = 'PROCESSED_NOT_FOUND';
      item.processedAt = new Date().toISOString();

    } else if (item.stripeTag === 'Found') {
      // CASE B: Subscription Found in Stripe - Cancel Sub
      console.log(` -> \x1b[32m[Stripe]\x1b[0m Cancelando suscripcion ${item.stripeSubscriptionId}...`);
      const stripeSub = mockStripeDb[item.fromEmail];
      
      const periodEnd = stripeSub.current_period_end 
        ? new Date(stripeSub.current_period_end * 1000).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })
        : 'el final de tu periodo actual';

      if (item.classification === 'Desuscripción') {
        console.log(' -> Cargando plantilla "succesful-unsuscription.html"...');
        const templatePath = path.join(templatesDir, 'succesful-unsuscription.html');
        let html = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : 'Template not found';
        html = html
          .replace(/\{\{EXPIRATION_DATE\}\}/g, periodEnd)
          .replace(/\{\{UNSUSCRIPTION_DATE\}\}/g, periodEnd);

        console.log(` -> \x1b[32m[SMTP]\x1b[0m Enviando confirmación de baja a ${item.fromEmail}...`);
        console.log(`    Asunto: "Confirmación de cancelación de membresía - WisdomPackets"`);
        console.log(`    Fecha Cancelación: "${periodEnd}"`);

      } else if (item.classification === 'Desuscripción + Refund') {
        console.log(' -> Cargando plantilla "succesful-unsuscription-refund-link.html"...');
        const templatePath = path.join(templatesDir, 'succesful-unsuscription-refund-link.html');
        let html = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : 'Template not found';
        
        // Mock Stripe paid invoice receipt
        const mockReceipt = `https://receipt.stripe.com/receipt/acct_12345/ch_mock_${item.stripeCustomerId}/receipt_code_xyz`;
        html = html
          .replace(/\{\{REFUND_RECEIPT_URL\}\}/g, mockReceipt)
          .replace(/\{\{EXPIRATION_DATE\}\}/g, periodEnd)
          .replace(/\{\{UNSUSCRIPTION_DATE\}\}/g, periodEnd);

        console.log(` -> \x1b[32m[SMTP]\x1b[0m Enviando confirmación de reembolso a ${item.fromEmail}...`);
        console.log(`    Asunto: "Cancelación de membresía y reembolso iniciado - WisdomPackets"`);
        console.log(`    Enlace de Reembolso: ${mockReceipt}`);
      }

      item.status = 'PROCESSED_SUCCESS';
      item.processedAt = new Date().toISOString();
    }
  }

  // Save the updated mock queue
  fs.writeFileSync(mockQueuePath, JSON.stringify(queue, null, 2), 'utf-8');
  console.log(`\n\x1b[32m✔ Simulación de respuestas completada con éxito. Cola actualizada en mock_queue.json\x1b[0m`);

  // Write runs log
  const mockRuns = [
    {
      timestamp: new Date().toISOString(),
      type: 'SIMULATION_CLASSIFIER',
      status: 'SUCCESS',
      emailsProcessedCount: mockEmails.length
    },
    {
      timestamp: new Date().toISOString(),
      type: 'SIMULATION_RESPONDER',
      status: 'SUCCESS',
      actionsProcessedCount: pendingItems.length
    }
  ];
  fs.writeFileSync(mockRunsPath, JSON.stringify(mockRuns, null, 2), 'utf-8');
  console.log(`\x1b[32m✔ Historial de ejecución simulado guardado en mock_runs.json\x1b[0m\n`);
}

async function runSimulation() {
  console.log('==================================================');
  console.log('🎬 INICIANDO SIMULACIÓN EXTREMO A EXTREMO (E2E)');
  console.log('==================================================');
  
  await simulateClassifier();
  await simulateResponder();
  
  console.log('==================================================');
  console.log('🎉 SIMULACIÓN COMPLETADA CON ÉXITO');
  console.log('==================================================');
  console.log('Puedes inspeccionar los archivos generados en:');
  console.log(` - Cola simulada: [mock_queue.json]`);
  console.log(` - Historial: [mock_runs.json]`);
  console.log('==================================================\n');
}

runSimulation().catch(console.error);
