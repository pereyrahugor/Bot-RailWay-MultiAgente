// src/utils/AssistantResponseProcessor.ts
import { executeDbQuery } from '../utils/dbHandler';
import { JsonBlockFinder } from "../Api-Google/JsonBlockFinder";
import { CalendarEvents } from "../Api-Google/calendarEvents";
import moment from 'moment';
import OpenAI from "openai";
import { downloadFileFromDrive } from "../utils/googleDriveHandler";
import { waitForActiveRuns } from "./OpenAIHandler";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Limpia bloques técnicos y citas de OpenAI para entrega final al usuario.
 */
export function limpiarBloquesJSON(texto: string, finalDelivery: boolean = false): string {
    if (!texto) return "";
    
    if (finalDelivery) {
        let limpio = texto;
        limpio = limpio.replace(/\[DB_QUERY\s*:[\s\S]*?\]/gi, '');
        limpio = limpio.replace(/\[DB\s*:[\s\S]*?\]/gi, '');
        limpio = limpio.replace(/\[API\][\s\S]*?\[\/API\]/gi, '');
        limpio = limpio.replace(/\[PDF\s*:\s*[\s\S]*?\]/gi, '');
        limpio = limpio.replace(/\[RESULTADO_DB\][\s\S]*?\[\/RESULTADO_DB\]/gi, '');
        limpio = limpio.replace(/\[REPORT\][\s\S]*?\[\/REPORT\]/gi, '');
        limpio = limpio.replace(/【.*?】/g, ''); // Citas de OpenAI
        limpio = limpio.replace(/```json[\s\S]*?```/gi, ''); // Bloques de código JSON
        return limpio.trim();
    }

    // Preservación interna para procesamiento recursivo
    const specialBlocks: string[] = [];
    let textoConMarcadores = texto;

    const regexes = [
        /\[DB_QUERY\s*:[\s\S]*?\]/gi,
        /\[DB\s*:[\s\S]*?\]/gi,
        /\[API\][\s\S]*?\[\/API\]/gi,
        /\[PDF\s*:\s*[\s\S]*?\]/gi
    ];

    regexes.forEach(regex => {
        textoConMarcadores = textoConMarcadores.replace(regex, (match) => {
            const index = specialBlocks.length;
            specialBlocks.push(match);
            return `___SPECIAL_BLOCK_${index}___`;
        });
    });

    let limpio = textoConMarcadores.replace(/【.*?】/g, '');

    limpio = limpio.replace(/___SPECIAL_BLOCK_(\d+)___/g, (match, index) => {
        return specialBlocks[parseInt(index)];
    });

    return limpio;
}

export class AssistantResponseProcessor {
    /**
     * Punto de entrada principal para procesar respuestas del asistente.
     * Soporta recursividad para manejar múltiples llamadas a API en cadena.
     */
    static async analizarYProcesarRespuestaAsistente(
        response: any,
        ctx: any,
        flowDynamic: any,
        state: any,
        provider: any,
        gotoFlow: any,
        getAssistantResponse: Function,
        assistantId: string,
        recursionDepth: number = 0
    ) {
        if (recursionDepth > 5) {
            console.error('[AssistantResponseProcessor] Límite de recursión alcanzado. Abortando.');
            return;
        }

        const textResponse = typeof response === "string" ? response : String(response || "");
        let threadId = ctx?.thread_id || (state?.get && typeof state.get === 'function' ? state.get('thread_id') : null);

        console.log(`[AssistantResponseProcessor] Procesando respuesta (Recursion: ${recursionDepth})`);

        // 1. PROCESAR BLOQUES DE BASE DE DATOS [DB_QUERY: ...]
        const dbQueryRegex = /\[DB_QUERY\s*:\s*([\s\S]*?)\]/i;
        const dbMatch = textResponse.match(dbQueryRegex);
        if (dbMatch) {
            const sqlQuery = dbMatch[1].trim();
            console.log(`[AssistantResponseProcessor] 🔄 Ejecutando DB Query: ${sqlQuery.substring(0, 50)}...`);

            const queryResult = await executeDbQuery(sqlQuery);
            
            if (threadId) await waitForActiveRuns(threadId);
            else await new Promise(r => setTimeout(r, 2000));

            const nextResponse = await getAssistantResponse(
                assistantId,
                `[DB_RESULT] ${queryResult} [/DB_RESULT]`,
                state,
                undefined,
                ctx.from, 
                threadId 
            );

            return this.analizarYProcesarRespuestaAsistente(
                nextResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
            );
        }

        // 2. PROCESAR BÚSQUEDA EN BD [DB: {T:"tabla", D:"dato"}]
        const dbSearchRegex = /\[DB\s*:\s*\{?\s*["']?T["']?\s*[:"' \t]+(?<tabla>[^"' \t,]+)["']?\s*,\s*["']?D["']?\s*[:"' \t]+(?<dato>[^"']+)["']?\s*\}?\s*\]/i;
        const dbSearchMatch = textResponse.match(dbSearchRegex);
        if (dbSearchMatch && dbSearchMatch.groups) {
            const { tabla, dato } = dbSearchMatch.groups;
            const sqlQuery = `SELECT * FROM "${tabla}" WHERE "${tabla}"::text ~* '${dato}'`;
            console.log(`[AssistantResponseProcessor] 🔍 DB Search en ${tabla}: ${dato}`);

            const queryResult = await executeDbQuery(sqlQuery);
            
            if (threadId) await waitForActiveRuns(threadId);
            const nextResponse = await getAssistantResponse(
                assistantId,
                `[DB_RESULT] ${queryResult} [/DB_RESULT]`,
                state,
                undefined,
                ctx.from, 
                threadId 
            );

            return this.analizarYProcesarRespuestaAsistente(
                nextResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
            );
        }

        // 3. PROCESAR DESCARGA DE PDF [PDF: ID]
        const pdfRegex = /\[PDF\s*:\s*([\s\S]*?)\]/i;
        const pdfMatch = textResponse.match(pdfRegex);
        if (pdfMatch) {
            const fileId = pdfMatch[1].trim();
            try {
                const filePath = await downloadFileFromDrive(fileId);
                console.log(`[AssistantResponseProcessor] 📤 Enviando PDF: ${filePath}`);
                
                await flowDynamic([{
                    body: "Aquí tienes el documento solicitado:",
                    media: filePath
                }]);

                const nextResponse = await getAssistantResponse(
                    assistantId,
                    `[SISTEMA] PDF enviado con éxito id ${fileId}.`,
                    state,
                    undefined,
                    ctx.from,
                    threadId
                );

                return this.analizarYProcesarRespuestaAsistente(
                    nextResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
                );
            } catch (err) {
                console.error(`[AssistantResponseProcessor] ❌ Error PDF (${fileId}):`, err);
                await flowDynamic([{ body: "Hubo un error al intentar descargar el documento." }]);
                return;
            }
        }

        // 4. PROCESAR BLOQUE [API] ... [/API] (Calendar y otros)
        const apiBlockRegex = /\[API\](.*?)\[\/API\]/is;
        const match = textResponse.match(apiBlockRegex);
        if (match) {
            const jsonStr = match[1].trim();
            let jsonData: any = null;
            try {
                jsonData = JSON.parse(jsonStr);
            } catch (e) {
                // Fallback heurístico si el JSON está mal formado o fuera de [API]
                jsonData = JsonBlockFinder.buscarBloquesJSONEnTexto(textResponse);
            }

            if (jsonData && jsonData.type) {
                const tipo = jsonData.type.trim();
                let apiResponse: any = null;

                try {
                    console.log(`[AssistantResponseProcessor] 🛠 Ejecutando API Action: ${tipo}`);
                    
                    if (tipo === "create_event") {
                        const { fecha, hora, titulo, descripcion, invitados } = jsonData;
                        apiResponse = await CalendarEvents.createEvent({ fecha, hora, titulo, descripcion, invitados });
                    } else if (tipo === "available_event") {
                        const { fecha, hora } = jsonData;
                        const start = `${fecha}T${hora}:00-03:00`;
                        const startMoment = moment(start);
                        const endMoment = startMoment.clone().add(1, 'hour');
                        apiResponse = await CalendarEvents.checkAvailability(start, endMoment.format('YYYY-MM-DDTHH:mm:ssZ'));
                    } else if (tipo === "modify_event") {
                        const { id, fecha, hora, titulo, descripcion } = jsonData;
                        apiResponse = await CalendarEvents.updateEvent(id, { fecha, hora, titulo, descripcion });
                    } else if (tipo === "cancel_event") {
                        apiResponse = await CalendarEvents.deleteEvent(jsonData.id);
                    }

                    if (apiResponse) {
                        if (threadId) await waitForActiveRuns(threadId);
                        const nextResponse = await getAssistantResponse(
                            assistantId,
                            JSON.stringify(apiResponse, null, 2),
                            state,
                            undefined,
                            ctx.from,
                            threadId
                        );

                        return this.analizarYProcesarRespuestaAsistente(
                            nextResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
                        );
                    }
                } catch (err) {
                    console.error('[AssistantResponseProcessor] ❌ Error en API action:', err);
                }
            }
        }

        // 5. ENTREGA FINAL AL USUARIO (Texto Limpio)
        const cleanTextResponse = limpiarBloquesJSON(textResponse, true).trim();
        
        // Manejo especial de demora/reserva (opcional según lógica de negocio original)
        if (cleanTextResponse.includes('Voy a proceder a realizar la reserva.')) {
            await new Promise(res => setTimeout(res, 3000)); // Delay para simular procesamiento
            const waitMsg = await getAssistantResponse(assistantId, 'continuar', state, undefined, ctx.from, threadId);
            if (waitMsg) {
                await flowDynamic([{ body: limpiarBloquesJSON(String(waitMsg), true).trim() }]);
            }
        } else if (cleanTextResponse.length > 0) {
            // Dividir por párrafos para un envío más natural en WhatsApp
            const chunks = cleanTextResponse.split(/\n\n+/);
            for (const chunk of chunks) {
                if (chunk.trim().length > 0) {
                    try {
                        await flowDynamic([{ body: chunk.trim() }]);
                        await new Promise(r => setTimeout(r, 800)); // Pequeño delay entre burbujas
                    } catch (err) {
                        console.error('[AssistantResponseProcessor] Error en flowDynamic:', err);
                    }
                }
            }
        }
    }
}
