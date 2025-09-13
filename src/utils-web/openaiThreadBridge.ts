import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Obtiene o crea un thread_id para el usuario webchat
 * @param store objeto de sesión por IP
 * @returns thread_id
 */
export async function getOrCreateThreadId(store: { thread_id?: string | null }) {
  if (store.thread_id) return store.thread_id;
  const thread = await openai.beta.threads.create();
  store.thread_id = thread.id;
  return thread.id;
}

/**
 * Envía un mensaje al thread y ejecuta el run
 * @param threadId string
 * @param userMessage string
 * @param assistantId string
 * @returns respuesta del asistente
 */
export async function sendMessageToThread(threadId: string, userMessage: string, assistantId: string) {
  await openai.beta.threads.messages.create(
    threadId,
    {
      role: "user",
      content: [{ type: "text", text: userMessage }],
    }
  );
  const run = await openai.beta.threads.runs.create(
    threadId,
    { assistant_id: assistantId }
  );
  // Esperar la finalización del run
  let runStatus = run.status;
  const runId = run.id;
  while (runStatus !== 'completed') {
    await new Promise(res => setTimeout(res, 1000));
    const runInfo = await openai.beta.threads.runs.retrieve(threadId, runId);
    runStatus = runInfo.status;
    if (runStatus === 'failed' || runStatus === 'cancelled') {
      throw new Error('Run fallido o cancelado');
    }
  }
  // Obtener el último mensaje del asistente (más reciente)
  const messages = await openai.beta.threads.messages.list(threadId);
  const assistantMessages = messages.data.filter(m => m.role === 'assistant');
  if (!assistantMessages.length) return '';
  const lastMsg = assistantMessages[0]; // El primero es el más reciente
  const textBlock = lastMsg.content.find(block => block.type === 'text' && typeof (block as any).text?.value === 'string');
  if (textBlock && textBlock.type === 'text') {
    return (textBlock as { type: 'text'; text: { value: string } }).text.value;
  }
  return lastMsg.content.length ? JSON.stringify(lastMsg.content[0]) : '';
}

/**
 * Elimina el thread y limpia el thread_id
 */
export async function deleteThread(store: { thread_id?: string | null }) {
  // No existe un método delete para threads en la API de OpenAI.
  // Simplemente limpia el thread_id en el store.
  if (store.thread_id) {
    store.thread_id = null;
  }
}
