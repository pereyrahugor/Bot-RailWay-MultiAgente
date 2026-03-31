import { typing } from "./presence";
import { HistoryHandler } from "./HistoryHandler";
import { EVENTS } from "@builderbot/bot";
import { getArgentinaDatetimeString } from "./ArgentinaTime";
import { safeToAsk, waitForActiveRuns } from "./OpenAIHandler";
import { AssistantResponseProcessor } from "./AssistantResponseProcessor";
import { stop, reset } from "./timeOut";
import { updateMain } from "../addModule/updateMain";

export class AiManager {
    private userTimeouts = new Map<string, NodeJS.Timeout>();
    private userRetryCount = new Map<string, number>();
    private readonly TIMEOUT_MS = 60000;
    private userAssignedAssistant = new Map<string, string>();

    // IDs genéricos de asistentes desde variables de entorno
    public readonly ASSISTANT_MAP: Record<string, string | undefined> = {
        asistente1: process.env.ASSISTANT_1, // Recepcionista
        asistente2: process.env.ASSISTANT_2,
        asistente3: process.env.ASSISTANT_3,
        asistente4: process.env.ASSISTANT_4,
        asistente5: process.env.ASSISTANT_5,
    };

    constructor(
        private openaiMain: any, // Cliente OpenAI (opcional si se usa safeToAsk)
        public errorReporter: any,
        private flows: { welcomeFlowTxt: any; welcomeFlowVoice: any; welcomeFlowButton: any }
    ) {}

    /**
     * Retorna el Assistant ID asignado al usuario
     */
    public getAssignedAssistantId(userId: string): string {
        const assigned = this.userAssignedAssistant.get(userId) || 'asistente1';
        return this.ASSISTANT_MAP[assigned] || this.ASSISTANT_MAP['asistente1']!;
    }

    /**
     * Obtiene la respuesta del asistente con lógica de reintentos y timeout.
     */
    public getAssistantResponse = async (
        assistantId: string,
        message: string,
        state: any,
        fallbackMessage: string | undefined,
        userId: string,
        thread_id: string | null = null
    ): Promise<string | any> => {
        const tId = thread_id || (state && state.get && typeof state.get === 'function' ? state.get('thread_id') : null);
        
        if (tId) {
            await waitForActiveRuns(tId);
        }

        // Si es un nuevo hilo, envía primero la fecha y hora actual como contexto de sistema implícito
        if (!thread_id && !tId) {
            const fechaHoraActual = getArgentinaDatetimeString();
            const mensajeFecha = `La fecha y hora actual es: ${fechaHoraActual}`;
            await safeToAsk(assistantId, mensajeFecha, state, userId, this.errorReporter);
        }

        if (this.userTimeouts.has(userId)) {
            clearTimeout(this.userTimeouts.get(userId)!);
            this.userTimeouts.delete(userId);
        }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(async () => {
                const retries = this.userRetryCount.get(userId) || 0;
                if (retries < 2) {
                    this.userRetryCount.set(userId, retries + 1);
                    console.warn(`⏱ Timeout alcanzado para ${userId}. Reintentando (${retries + 1}/3)...`);
                    if (tId) await waitForActiveRuns(tId);
                    try {
                        const retryResult = await safeToAsk(assistantId, message, state, userId, this.errorReporter);
                        resolve(retryResult);
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    this.userRetryCount.set(userId, 0);
                    console.error(`⏱ Timeout final. Reportando error para ${userId}.`);
                    await this.errorReporter.reportError(
                        new Error("No se recibió respuesta del asistente tras 3 intentos."),
                        userId,
                        `https://wa.me/${userId}`
                    );
                    resolve(fallbackMessage || "Lo siento, estoy teniendo dificultades técnicas. Por favor, reintenta en unos instantes.");
                }
                this.userTimeouts.delete(userId);
            }, this.TIMEOUT_MS);
            
            this.userTimeouts.set(userId, timeoutId);

            safeToAsk(assistantId, message, state, userId, this.errorReporter)
                .then(result => {
                    if (this.userTimeouts.has(userId)) {
                        clearTimeout(this.userTimeouts.get(userId)!);
                        this.userTimeouts.delete(userId);
                    }
                    this.userRetryCount.set(userId, 0);
                    resolve(result);
                })
                .catch(error => {
                    if (this.userTimeouts.has(userId)) {
                        clearTimeout(this.userTimeouts.get(userId)!);
                        this.userTimeouts.delete(userId);
                    }
                    if (error?.message === 'TIMEOUT_SAFE_TO_ASK') {
                        console.error(`[AiManager] Finalizando por timeout de seguridad para ${userId}`);
                        resolve(fallbackMessage || "Lo siento, estoy tardando un poco más de lo habitual. Por favor, reintenta en un momento.");
                    } else {
                        reject(error);
                    }
                });
        });
    };

    /**
     * Analiza la respuesta para determinar si hay una derivación a otro asistente.
     */
    public analizarDestinoRecepcionista(respuesta: string): string | null {
        const lower = respuesta.toLowerCase();
        if (/derivar(?:ndo)?\s+a\s+asistente\s*1\b/.test(lower)) return 'asistente1';
        if (/derivar(?:ndo)?\s+a\s+asistente\s*2\b/.test(lower)) return 'asistente2';
        if (/derivar(?:ndo)?\s+a\s+asistente\s*3\b/.test(lower)) return 'asistente3';
        if (/derivar(?:ndo)?\s+a\s+asistente\s*4\b/.test(lower)) return 'asistente4';
        if (/derivar(?:ndo)?\s+a\s+asistente\s*5\b/.test(lower)) return 'asistente5';
        if (/derivar|derivando/.test(lower)) return 'ambiguous';
        return null;
    }

    /**
     * Extrae el bloque de resumen para el siguiente asistente.
     */
    private extraerResumenRecepcionista(respuesta: string): string {
        const match = respuesta.match(/GET_RESUMEN[\s\S]+/i);
        return match ? match[0].trim() : "Continúa con la atención del cliente.";
    }

    /**
     * Procesa el mensaje del usuario, manejando comandos, historial y la interacción con la IA.
     */
    public processUserMessage = async (ctx: any, { flowDynamic, state, provider, gotoFlow }: any) => {
        await typing(ctx, provider);
        try {
            const body = ctx.body && ctx.body.trim();

            // 1. COMANDOS DE CONTROL (Admin manual via WhatsApp)
            if (body === "#ON#") {
                await HistoryHandler.toggleBot(ctx.from, true);
                if (ctx.pushName) await HistoryHandler.getOrCreateChat(ctx.from, 'whatsapp', ctx.pushName);
                const msg = "🤖 Bot activado para este chat.";
                await flowDynamic([{ body: msg }]);
                await HistoryHandler.saveMessage(ctx.from, 'assistant', msg, 'text');
                return state;
            }

            if (body === "#OFF#") {
                await HistoryHandler.toggleBot(ctx.from, false);
                if (ctx.pushName) await HistoryHandler.getOrCreateChat(ctx.from, 'whatsapp', ctx.pushName);
                const msg = "🛑 Bot desactivado. (Intervención humana activa)";
                await flowDynamic([{ body: msg }]);
                await HistoryHandler.saveMessage(ctx.from, 'assistant', msg, 'text');
                return state;
            }

            if (body === "#ACTUALIZAR#") {
                try {
                    await updateMain();
                    await flowDynamic([{ body: "🔄 Datos actualizados desde Google." }]);
                } catch (err) {
                    await flowDynamic([{ body: "❌ Error al actualizar datos desde Google." }]);
                }
                return state;
            }

            // 2. FILTRO DE ECO / BOT
            const botNumber = (process.env.YCLOUD_WABA_NUMBER || '').replace(/\D/g, '');
            const senderNumber = (ctx.from || '').replace(/\D/g, '');
            if (ctx.key?.fromMe || (botNumber && senderNumber === botNumber)) {
                stop(ctx);
                return;
            }

            // 3. FILTRO DE BROADCAST/NEWSLETTER
            if (ctx.from) {
                if (/@broadcast$/.test(ctx.from) || /@newsletter$/.test(ctx.from) || /@channel$/.test(ctx.from)) return;
            }

            stop(ctx);

            // 4. GUARDAR MENSAJE EN HISTORIAL
            await HistoryHandler.saveMessage(
                ctx.from,
                'user',
                body || (ctx.type === EVENTS.VOICE_NOTE ? "[Audio]" : "[Media]"),
                ctx.type,
                ctx.pushName || null
            );

            // 5. VERIFICAR SI EL BOT ESTÁ ACTIVO
            const isBotActiveForUser = await HistoryHandler.isBotEnabled(ctx.from);
            if (!isBotActiveForUser) {
                // Si el bot está apagado, solo actualizamos el hilo en OpenAI si existe
                try {
                    const threadId = await HistoryHandler.getThreadId(ctx.from);
                    if (threadId && body) {
                        await this.openaiMain.beta.threads.messages.create(threadId, {
                            role: 'user',
                            content: body
                        });
                    }
                } catch (e: any) {
                    console.error("[AiManager] Error actualizando hilo pasivamente:", e.message);
                }
                return state;
            }

            // 6. LÓGICA DE MULTI-ASISTENTE (DERIVACIÓN)
            let assigned = this.userAssignedAssistant.get(ctx.from) || 'asistente1';
            let assistantId = this.ASSISTANT_MAP[assigned];

            if (!assistantId) {
                console.warn(`[AiManager] No se encontró AssistantID para ${assigned}. Usando asistente1.`);
                assigned = 'asistente1';
                assistantId = this.ASSISTANT_MAP[assigned];
            }

            const response = (await this.getAssistantResponse(
                assistantId!,
                ctx.body,
                state,
                "Por favor, responde aunque sea brevemente.",
                ctx.from
            )) as string;

            if (!response) return state;

            // Persistir ThreadID si es nuevo
            try {
                const currentThreadId = state && typeof state.get === 'function' ? state.get('thread_id') : null;
                if (currentThreadId && ctx.from) {
                    await HistoryHandler.saveThreadId(ctx.from, currentThreadId);
                }
            } catch (e: any) {
                console.error("[AiManager] Error guardando threadId:", e.message);
            }

            const destino = this.analizarDestinoRecepcionista(response);
            const resumen = this.extraerResumenRecepcionista(response);
            
            // Limpiar la respuesta para el usuario (remover bloques técnicos)
            let cleanResponse = String(response)
                .replace(/GET_RESUMEN[\s\S]+/i, '')
                .replace(/^[ \t]*derivar(?:ndo)? a (asistente\s*[1-5]|asesor humano)\.?\s*$/gim, '')
                .replace(/\[Enviando.*$/gim, '')
                .replace(/^[ \t]*\n/gm, '')
                .trim();

            // Manejo de Derivación
            if (destino && this.ASSISTANT_MAP[destino] && destino !== assigned) {
                console.log(`[AiManager] Derivando de ${assigned} a ${destino} para ${ctx.from}`);
                this.userAssignedAssistant.set(ctx.from, destino);

                // Enviar lo que haya dicho el primer asistente antes de derivar
                if (cleanResponse) {
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        cleanResponse, ctx, flowDynamic, state, provider, gotoFlow,
                        this.getAssistantResponse, assistantId!
                    );
                }

                // Obtener respuesta del nuevo asistente usando el resumen
                const nextAssistantId = this.ASSISTANT_MAP[destino]!;
                const secondResponse = await this.getAssistantResponse(
                    nextAssistantId, resumen, state, undefined, ctx.from
                );

                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    String(secondResponse).trim(), ctx, flowDynamic, state, provider, gotoFlow,
                    this.getAssistantResponse, nextAssistantId
                );
            } else {
                // Sin derivación o ambigua
                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    cleanResponse, ctx, flowDynamic, state, provider, gotoFlow,
                    this.getAssistantResponse, assistantId!
                );
                
                // Guardar la respuesta final en el historial
                if (cleanResponse) {
                    await HistoryHandler.saveMessage(ctx.from, 'assistant', cleanResponse);
                }
            }

            // Gestionar timeout de inactividad (cierre de sesión)
            const setTime = Number(process.env.timeOutCierre || 5) * 60 * 1000;
            reset(ctx, gotoFlow, setTime);

            return state;

        } catch (error: any) {
            console.error("[AiManager] Error crítico:", error);
            await this.errorReporter.reportError(error, ctx.from, `https://wa.me/${ctx.from}`);

            if (ctx.type === EVENTS.VOICE_NOTE) return gotoFlow(this.flows.welcomeFlowVoice);
            if (ctx.type === EVENTS.ACTION) return gotoFlow(this.flows.welcomeFlowButton);
            return gotoFlow(this.flows.welcomeFlowTxt);
        }
    };
}
