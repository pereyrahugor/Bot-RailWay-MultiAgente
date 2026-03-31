import OpenAI from 'openai';
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { HistoryHandler } from './HistoryHandler';

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Capa 1: Verificación Proactiva de runs activos.
 */
export async function waitForActiveRuns(threadId: string, maxAttempts = 5) {
    if (!threadId) return;
    try {
        let attempt = 0;
        while (attempt < maxAttempts) {
            const runs = await openai.beta.threads.runs.list(threadId, { limit: 5 });
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
        // Si llegamos al límite, intentamos cancelar todo lo residual
        await cancelActiveRuns(threadId);
    } catch (error) {
        console.error(`[OpenAIHandler] Error verificando runs:`, error);
    }
}

/**
 * Cancela todos los runs activos encontrados en un thread
 */
export async function cancelActiveRuns(threadId: string) {
    if (!threadId) return;
    try {
        const runs = await openai.beta.threads.runs.list(threadId, { limit: 10 });
        for (const run of runs.data) {
            if (['in_progress', 'queued', 'requires_action'].includes(run.status)) {
                console.log(`[Reconexión] Cancelando run residual ${run.id} (${run.status})`);
                try {
                    await openai.beta.threads.runs.cancel(threadId, run.id);
                    await new Promise(r => setTimeout(r, 1000));
                } catch (e: any) {
                    console.error(`Error cancelando run ${run.id}:`, e.message);
                }
            }
        }
    } catch (error) {
        console.error(`Error en cancelActiveRuns:`, error);
    }
}

/**
 * Capa 2 & 3: Petición Segura con Reintentos, Renovación y Timeout Global.
 */
export const safeToAsk = async (
  assistantId: string,
  message: string,
  state: any,
  userId: string,
  errorReporter?: any,
  maxRetries = 5
): Promise<string | any> => {
  const SAFE_TIMEOUT = 120000; // 2 minutos de timeout total sugerido

  return Promise.race([
    (async () => {
      let attempt = 0;
      while (attempt < maxRetries) {
        const threadId = state?.get && typeof state.get === 'function' ? state.get('thread_id') : null;
        if (threadId) await waitForActiveRuns(threadId);

        try {
          console.log(`[OpenAIHandler] Consultando asistente (Intento ${attempt + 1}/${maxRetries})...`);
          return await toAsk(assistantId, message, state) as string;
        } catch (err: any) {
          attempt++;
          const errorMessage = err?.message || String(err);
          console.error(`[OpenAIHandler] Error en attempt ${attempt}:`, errorMessage);

          // Si OpenAI nos dice qué run está bloqueando, lo cancelamos de inmediato
          if (errorMessage.includes('while a run') && errorMessage.includes('is active') && threadId) {
            const runIdMatch = errorMessage.match(/run_[a-zA-Z0-9]+/);
            if (runIdMatch) {
              console.log(`[OpenAIHandler] Cancelando run bloqueador detectado: ${runIdMatch[0]}`);
              try {
                await openai.beta.threads.runs.cancel(threadId, runIdMatch[0]);
                await new Promise(r => setTimeout(r, 3000));
                continue; // Reintento inmediato
              } catch (cancelErr) {
                // Sigue al flujo de reintentos normal
              }
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
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_SAFE_TO_ASK')), SAFE_TIMEOUT))
  ]);
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
): Promise<string | null> {
    try {
        // 1. Notificar al desarrollador
        if (errorReporter && typeof errorReporter.reportError === 'function') {
            await errorReporter.reportError(
                new Error("Hilo bloqueado persistentemente. Renovando hilo automáticamente..."),
                userId,
                `https://wa.me/${userId}`
            );
        }

        // 2. Traer el historial reciente
        const history = await HistoryHandler.getMessages(userId, 10);
        
        // 3. Crear nuevo hilo en OpenAI con ese contexto
        const threadMessages = history.map(m => ({ 
            role: (m.role === 'assistant' ? 'assistant' : 'user') as "user" | "assistant", 
            content: m.content || ''
        })).filter(m => m.content);

        const newThread = await openai.beta.threads.create({
            messages: threadMessages
        });

        console.log(`[OpenAIHandler] Nuevo hilo creado: ${newThread.id}`);

        // 4. Actualizar estado y reintentar
        if (state && typeof state.update === 'function') {
            await state.update({ thread_id: newThread.id });
        }
        
        return await toAsk(assistantId, message, state) as string;
    } catch (error) {
        console.error('[OpenAIHandler] Error en renovación de hilo:', error);
        return null;
    }
}
