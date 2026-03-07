// src/utils/AssistantResponseProcessor.ts
// Ajustar fecha/hora a GMT-3 (hora argentina)
function toArgentinaTime(fechaReservaStr: string): string {
    const [fecha, hora] = fechaReservaStr.split(' ');
    const [anio, mes, dia] = fecha.split('-').map(Number);
    const [hh, min] = hora.split(':').map(Number);
    const date = new Date(Date.UTC(anio, mes - 1, dia, hh, min));
    date.setHours(date.getHours() - 3);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hhh = String(date.getHours()).padStart(2, '0');
    const mmm = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hhh}:${mmm}`;
}
import { executeDbQuery } from '../utils/dbHandler';
import { JsonBlockFinder } from "../Api-Google/JsonBlockFinder";
import { CalendarEvents } from "../Api-Google/calendarEvents";
import fs from 'fs';
import moment from 'moment';
import OpenAI from "openai";
import { downloadFileFromDrive } from "../utils/googleDriveHandler";
import { waitForActiveRuns } from "./OpenAIHandler";
//import { handleToolFunctionCall } from '../Api-BotAsistente/handleToolFunctionCall.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// waitForActiveRuns movido a OpenAIHandler.ts

// Mapa global para bloquear usuarios de WhatsApp durante operaciones API
const userApiBlockMap = new Map();
const API_BLOCK_TIMEOUT_MS = 1000; // 5 segundos

function limpiarBloquesJSON(texto: string, finalDelivery: boolean = false): string {
    if (!texto) return "";
    
    // 1. Si es para entrega final, removemos todo lo que esté entre corchetes técnicos
    if (finalDelivery) {
        let limpio = texto;
        limpio = limpio.replace(/\[DB_QUERY\s*:[\s\S]*?\]/gi, '');
        limpio = limpio.replace(/\[DB\s*:\s*[tT]\s*:[\s\S]*?\]/gi, '');
        limpio = limpio.replace(/\[API\][\s\S]*?\[\/API\]/gi, '');
        limpio = limpio.replace(/\[PDF\s*:\s*[\s\S]*?\]/gi, '');
        limpio = limpio.replace(/\[RESULTADO_DB\][\s\S]*?\[\/RESULTADO_DB\]/gi, '');
        limpio = limpio.replace(/\[REPORT\][\s\S]*?\[\/REPORT\]/gi, '');
        limpio = limpio.replace(/【.*?】/g, ''); // Citas de OpenAI
        limpio = limpio.replace(/```json[\s\S]*?```/gi, ''); // Bloques de código JSON
        return limpio.trim();
    }

    // Comportamiento original para preservación interna
    const specialBlocks: string[] = [];
    let textoConMarcadores = texto;

    // Preservar [DB_QUERY: ...]
    textoConMarcadores = textoConMarcadores.replace(/\[DB_QUERY\s*:[\s\S]*?\]/gi, (match) => {
        const index = specialBlocks.length;
        specialBlocks.push(match);
        return `___SPECIAL_BLOCK_${index}___`;
    });

    // Preservar [DB:T:"tabla", D:"dato"]
    textoConMarcadores = textoConMarcadores.replace(/\[DB\s*:\s*[tT]\s*:[\s\S]*?\]/gi, (match) => {
        const index = specialBlocks.length;
        specialBlocks.push(match);
        return `___SPECIAL_BLOCK_${index}___`;
    });

    // Preservar [API]...[/API]
    textoConMarcadores = textoConMarcadores.replace(/\[API\][\s\S]*?\[\/API\]/gi, (match) => {
        const index = specialBlocks.length;
        specialBlocks.push(match);
        return `___SPECIAL_BLOCK_${index}___`;
    });

    // Preservar [PDF: ID]
    textoConMarcadores = textoConMarcadores.replace(/\[PDF\s*:\s*([\s\S]*?)\]/gi, (match) => {
        const index = specialBlocks.length;
        specialBlocks.push(match);
        return `___SPECIAL_BLOCK_${index}___`;
    });

    // Limpiar referencias de OpenAI tipo 【 archivo.pdf 】
    let limpio = textoConMarcadores.replace(/【.*?】/g, '');

    // Restaurar bloques especiales
    limpio = limpio.replace(/___SPECIAL_BLOCK_(\d+)___/g, (match, index) => {
        return specialBlocks[parseInt(index)];
    });

    return limpio;
}

function esFechaFutura(fechaReservaStr: string): boolean {
    const ahora = new Date();
    const fechaReserva = new Date(fechaReservaStr.replace(" ", "T"));
    return fechaReserva >= ahora;
}

export class AssistantResponseProcessor {
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
            console.error('[AssistantResponseProcessor] Límite de recursión alcanzado (5). Abortando.');
            return;
        }

        // Log de mensaje entrante del asistente (antes de cualquier filtro)
        if (ctx && ctx.type === 'webchat') {
            // console.log('[Webchat Debug] Mensaje entrante del asistente:', response);
        } else {
            // if (ctx && ctx.from && userApiBlockMap.has(ctx.from)) {
            //     console.log(`[API Block] Mensaje ignorado de usuario bloqueado: ${ctx.from}`);
            //     return;
            // }
        }

        let jsonData: any = null;
        const textResponse = typeof response === "string" ? response : String(response || "");

        // Log de mensaje saliente al usuario (antes de cualquier filtro)
        if (ctx && ctx.type === 'webchat') {
            console.log('[Webchat Debug] Mensaje saliente al usuario (sin filtrar):', textResponse);
        } else {
            console.log('[WhatsApp Debug] Mensaje saliente al usuario (sin filtrar):', textResponse);
        }

        // 0) Detectar y procesar DB QUERY [DB_QUERY: ...]
        const dbQueryRegex = /\[DB_QUERY\s*:\s*([\s\S]*?)\]/i;
        const dbMatch = textResponse.match(dbQueryRegex);
        if (dbMatch) {
            const sqlQuery = dbMatch[1].trim();
            if (ctx && ctx.type === 'webchat') console.log(`[Webchat Debug] 🔄 Detectada solicitud de DB Query: ${sqlQuery}`);
            else console.log(`[WhatsApp Debug] 🔄 Detectada solicitud de DB Query: ${sqlQuery}`);

            // Ejecutar Query
            const queryResult = await executeDbQuery(sqlQuery);
            console.log(`[AssistantResponseProcessor] 📄 Resultado DB:`, queryResult.substring(0, 100) + '...');

            // Obtener threadId de forma segura
            let threadId = ctx && ctx.thread_id;
            if (!threadId && state && typeof state.get === 'function') {
                threadId = state.get('thread_id');
            }

            // Esperar a que el Run anterior haya finalizado realmente en OpenAI
            if (threadId) {
                await waitForActiveRuns(threadId);
            } else {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Enviar resultado al asistente (NO al usuario)
            const newResponse = await getAssistantResponse(
                assistantId,
                `[DB_RESULT] ${queryResult} [/DB_RESULT]`,
                state,
                undefined,
                ctx.from,
                ctx.from
            );

            // Recursión: procesar la nueva respuesta
            await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                newResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
            );
            return; // Terminar ejecución actual
        }

        // 0.1) Detectar y procesar DB SEARCH [DB:T:"tabla", D:"dato"]
        const dbSearchRegex = /\[DB\s*:\s*"?[tT]"?\s*:\s*"(?<tabla>[^"]+)"\s*,\s*"?[dD]"?\s*:\s*"(?<dato>[^"]+)"\]/i;
        const dbSearchMatch = textResponse.match(dbSearchRegex);

        if (dbSearchMatch && dbSearchMatch.groups) {
            const { tabla, dato } = dbSearchMatch.groups;
            const sqlQuery = `SELECT * FROM "${tabla}" WHERE "${tabla}"::text ~* '${dato}'`;
            
            if (ctx && ctx.type === 'webchat') console.log(`[Webchat Debug] 🔍 Detectada DB Search en ${tabla}: ${dato}`);
            else console.log(`[WhatsApp Debug] 🔍 Detectada DB Search en ${tabla}: ${dato}`);

            // Ejecutar Query
            const queryResult = await executeDbQuery(sqlQuery);
            console.log(`[AssistantResponseProcessor] 📄 Resultado DB Search:`, queryResult.substring(0, 100) + '...');

            // Obtener threadId de forma segura
            let threadId = ctx && ctx.thread_id;
            if (!threadId && state && typeof state.get === 'function') {
                threadId = state.get('thread_id');
            }

            // Esperar a que el Run anterior haya finalizado realmente en OpenAI
            if (threadId) {
                await waitForActiveRuns(threadId);
            } else {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Enviar resultado al asistente (NO al usuario)
            const newResponse = await getAssistantResponse(
                assistantId,
                `[DB_RESULT] ${queryResult} [/DB_RESULT]`,
                state,
                undefined,
                ctx.from,
                ctx.from
            );

            // Recursión: procesar la nueva respuesta
            await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                newResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
            );
            return; // Terminar ejecución actual
        }

        // 0.2) Detectar y procesar descarga de PDF [PDF: ID]
        const pdfRegex = /\[PDF\s*:\s*([\s\S]*?)\]/i;
        const pdfMatch = textResponse.match(pdfRegex);
        if (pdfMatch) {
            const fileId = pdfMatch[1].trim();
            console.log(`[AssistantResponseProcessor] 📄 Detectada solicitud de PDF: ${fileId}`);
            
            try {
                const filePath = await downloadFileFromDrive(fileId);
                console.log(`[AssistantResponseProcessor] 📤 Enviando PDF al usuario: ${filePath}`);
                
                await flowDynamic([{
                    body: "Aquí tienes el documento solicitado:",
                    media: filePath
                }]);

                // Notificar al asistente que el PDF fue enviado correctamente
                const newResponse = await getAssistantResponse(
                    assistantId,
                    `[SISTEMA] PDF enviado con éxito id ${fileId}. ¿Deseas algo más?`,
                    state,
                    undefined,
                    ctx.from,
                    ctx.from
                );

                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    newResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
                );
                return;
            } catch (err) {
                console.error(`[AssistantResponseProcessor] ❌ Error al procesar PDF (${fileId}):`, err);
                await flowDynamic([{ body: "Hubo un error al intentar descargar el documento." }]);
                return;
            }
        }

        // 1) Extraer bloque [API] ... [/API]
        const apiBlockRegex = /\[API\](.*?)\[\/API\]/is;
        const match = textResponse.match(apiBlockRegex);
        if (match) {
            const jsonStr = match[1].trim();
            try {
                jsonData = JSON.parse(jsonStr);
            } catch (e) {
                jsonData = null;
            }
        }

        // 2) Fallback heurístico (desactivado, solo [API])
        if (!jsonData) {
            jsonData = JsonBlockFinder.buscarBloquesJSONEnTexto(textResponse) || (typeof response === "object" ? JsonBlockFinder.buscarBloquesJSONProfundo(response) : null);
        }

        // 3) Procesar JSON si existe
        if (jsonData && typeof jsonData.type === "string") {
            let unblockUser = null;
            if (ctx && ctx.type !== 'webchat' && ctx.from) {
                userApiBlockMap.set(ctx.from, true);
                const timeoutId = setTimeout(() => {
                    userApiBlockMap.delete(ctx.from);
                }, API_BLOCK_TIMEOUT_MS);
                unblockUser = () => {
                    clearTimeout(timeoutId);
                    userApiBlockMap.delete(ctx.from);
                };
            }
            
            const tipo = jsonData.type.trim();
            let apiResponse: any;

            try {
                if (tipo === "create_event") {
                    const { fecha, hora, titulo, descripcion, invitados } = jsonData;
                    apiResponse = await CalendarEvents.createEvent({ fecha, hora, titulo, descripcion, invitados });
                } else if (tipo === "available_event") {
                    const { fecha, hora } = jsonData;
                    const start = `${fecha}T${hora}:00-03:00`;
                    const startMoment = moment(start);
                    const endMoment = startMoment.clone().add(1, 'hour');
                    const end = endMoment.format('YYYY-MM-DDTHH:mm:ssZ');
                    apiResponse = await CalendarEvents.checkAvailability(start, end);
                } else if (tipo === "modify_event") {
                    const { id, fecha, hora, titulo, descripcion } = jsonData;
                    apiResponse = await CalendarEvents.updateEvent(id, { fecha, hora, titulo, descripcion });
                } else if (tipo === "cancel_event") {
                    const { id } = jsonData;
                    apiResponse = await CalendarEvents.deleteEvent(id);
                }

                if (apiResponse) {
                    let threadId = ctx && ctx.thread_id;
                    if (!threadId && state && typeof state.get === 'function') {
                        threadId = state.get('thread_id');
                    }

                    if (threadId) {
                        await waitForActiveRuns(threadId);
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                    const newResponse = await getAssistantResponse(
                        assistantId,
                        JSON.stringify(apiResponse, null, 2),
                        state,
                        undefined,
                        ctx.from,
                        ctx.from
                    );

                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        newResponse, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, assistantId, recursionDepth + 1
                    );
                    if (unblockUser) unblockUser();
                    return;
                }
            } catch (err) {
                console.error('[API Error]', err);
                if (unblockUser) unblockUser();
            }
        }

        // Si no hubo bloque JSON válido o fue procesado, enviar el texto limpio al usuario
        const cleanTextResponse = limpiarBloquesJSON(textResponse, true).trim();
        
        if (cleanTextResponse.includes('Voy a proceder a realizar la reserva.')) {
            await new Promise(res => setTimeout(res, 30000));
            let assistantApiResponse = await getAssistantResponse(assistantId, 'ok', state, undefined, ctx.from, ctx.from);
            while (assistantApiResponse && /(ID:\s*\w+)/.test(assistantApiResponse)) {
                await new Promise(res => setTimeout(res, 10000));
                assistantApiResponse = await getAssistantResponse(assistantId, 'ok', state, undefined, ctx.from, ctx.from);
            }
            if (assistantApiResponse) {
                try {
                    await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                } catch (err) {
                    console.error('[WhatsApp Debug] Error en flowDynamic:', err);
                }
            }
        } else if (cleanTextResponse.length > 0) {
            const chunks = cleanTextResponse.split(/\n\n+/);
            for (const chunk of chunks) {
                if (chunk.trim().length > 0) {
                    try {
                        await flowDynamic([{ body: chunk.trim() }]);
                        await new Promise(r => setTimeout(r, 600));
                    } catch (err) {
                        console.error('[WhatsApp Debug] Error en flowDynamic:', err);
                    }
                }
            }
        }
    }
}
