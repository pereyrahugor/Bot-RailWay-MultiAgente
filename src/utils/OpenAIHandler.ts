import OpenAI from 'openai';
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { HistoryHandler } from './HistoryHandler';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Capa 1: Verificación Proactiva de runs activos.
 * @param threadId string
 * @param maxAttempts number
 */
export async function waitForActiveRuns(threadId: string, maxAttempts = 5) {
    if (!threadId) return;
    try {
        let attempt = 0;
        while (attempt < maxAttempts) {
            const runs = await openai.beta.threads.runs.list(threadId);
            const activeRun = runs.data.find(r => 
                ['in_progress', 'queued', 'requires_action'].includes(r.status)
            );

            if (activeRun) {
                console.log(`[Reconexión] Run activo detectado (${activeRun.status}): ${activeRun.id}`);
                // Si está estancado en requires_action o lleva más de 2 intentos, cancelamos proactivamente
                if ((activeRun.status === 'requires_action' && attempt >= 2) || attempt >= 4) {
                    console.warn(`[Reconexión] Cancelando run ${activeRun.id} por bloqueo...`);
                    await openai.beta.threads.runs.cancel(threadId, activeRun.id);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;
            } else {
                return;
            }
        }
    } catch (error) {
        console.error(`[OpenAIHandler] Error verificando runs:`, error);
    }
}

/**
 * Capa 2 & 3: Petición Segura con Reintentos y Renovación.
 */
export const safeToAsk = async (
  assistantId: string,
  message: string,
  state: any,
  userId: string,
  errorReporter?: any,
  maxRetries = 5
) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    const threadId = state?.get && typeof state.get === 'function' ? state.get('thread_id') : null;
    if (threadId) await waitForActiveRuns(threadId);

    try {
      console.log(`[OpenAIHandler] Consultando asistente (Intento ${attempt + 1}/${maxRetries})...`);
      return await toAsk(assistantId, message, state);
    } catch (err: any) {
      attempt++;
      const errorMessage = err?.message || String(err);
      console.error(`[OpenAIHandler] Error en attempt ${attempt}:`, errorMessage);

      // Si OpenAI nos dice qué run está bloqueando, lo cancelamos de inmediato
      if (errorMessage.includes('while a run') && errorMessage.includes('is active') && threadId) {
        const runIdMatch = errorMessage.match(/run_[a-zA-Z0-9]+/);
        if (runIdMatch) {
          console.log(`[OpenAIHandler] Cancelando run bloqueador: ${runIdMatch[0]}`);
          await openai.beta.threads.runs.cancel(threadId, runIdMatch[0]);
          await new Promise(r => setTimeout(r, 3000));
          continue; // Reintento inmediato
        }
      }

      if (attempt >= maxRetries) {
          // CAPA 3: Renovación de Hilo
          console.warn('[OpenAIHandler] Iniciando renovación de hilo...');
          return await renewThreadAndRetry(assistantId, message, state, userId, errorReporter);
      }
      
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
};

/**
 * Renovación automática de hilo con recuperación de historial.
 */
async function renewThreadAndRetry(
    assistantId: string,
    message: string,
    state: any,
    userId: string,
    errorReporter?: any
) {
    try {
        // 1. Notificar al desarrollador
        if (errorReporter) {
            await errorReporter.reportError(
                new Error("Hilo bloqueado persistentemente. Renovando..."),
                userId,
                `https://wa.me/${userId}`
            );
        }

        // 2. Traer el historial reciente
        const history = await HistoryHandler.getMessages(userId, 10);
        
        // 3. Crear nuevo hilo en OpenAI con ese contexto
        // Opcional: si HistoryHandler no trajo nada, igual creamos hilo vacío
        const threadMessages = history.map(m => ({ 
            role: m.role === 'assistant' ? 'assistant' : 'user', 
            content: m.content || ''
        })).filter(m => m.content);

        const newThread = await openai.beta.threads.create({
            messages: (threadMessages as any)
        });

        console.log(`[OpenAIHandler] Nuevo hilo creado: ${newThread.id}`);

        // 4. Actualizar estado y reintentar
        if (state && typeof state.update === 'function') {
            await state.update({ thread_id: newThread.id });
        }
        
        return await toAsk(assistantId, message, state);
    } catch (error) {
        console.error('[OpenAIHandler] Error en renovación de hilo:', error);
        return null;
    }
}
