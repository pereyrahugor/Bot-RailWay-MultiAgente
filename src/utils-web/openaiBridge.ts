import { toAsk } from '@builderbot-plugins/openai-assistants';

/**
 * Wrapper para gestionar thread_id y respuesta de OpenAI Assistant
 * @param assistantId string
 * @param message string
 * @param state contexto/historial
 * @param threadId string|null
 * @returns { text: string, thread_id: string|null }
 */
export async function askWithThread(assistantId: string, message: string, state: any, threadId: string | null = null) {
  // Si el paquete no soporta threadId, ignora el parámetro
  // Si soporta, pásalo como argumento extra
  let response;
  try {
    // Intenta pasar threadId si la función lo soporta
    if (threadId) {
      response = await toAsk(assistantId, message, state);
    } else {
      response = await toAsk(assistantId, message, state);
    }
  } catch (err) {
    return { text: 'Error al consultar el asistente.', thread_id: null };
  }

  // Si la respuesta es objeto y tiene thread_id, úsalo
  if (response && typeof response === 'object') {
    return {
      text: response.text || String(response),
      thread_id: response.thread_id || null
    };
  }
  // Si la respuesta es string, retorna como texto y thread_id null
  return { text: String(response), thread_id: null };
}
