// ...existing imports y lógica del bot...

import path from 'path';
import serve from 'serve-static';
import { Server } from 'socket.io';
import fs from 'fs';
import bodyParser from 'body-parser';
import QRCode from 'qrcode';
// Estado global para encender/apagar el bot
import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "builderbot-provider-sherpa";
import { restoreSessionFromDb, startSessionSync, deleteSessionFromDb } from "./utils/sessionSync";
import { httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import { idleFlow } from "./Flows/idleFlow";
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
import { welcomeFlowDoc } from "./Flows/welcomeFlowDoc";
import { welcomeFlowButton } from "./Flows/welcomeFlowButton";
import { locationFlow } from "./Flows/locationFlow";
import { welcomeFlowVideo } from "./Flows/welcomeFlowVideo";
import { AssistantResponseProcessor } from "./utils/AssistantResponseProcessor";
import { safeToAsk, waitForActiveRuns } from "./utils/OpenAIHandler";
import { updateMain } from "./addModule/updateMain";
//import { listImg } from "./addModule/listImg";
import { ErrorReporter } from "./utils/errorReporter";
//import { testAuth } from './utils/test-google-auth.js';
import { AssistantBridge } from './utils-web/AssistantBridge';
import { WebChatManager } from './utils-web/WebChatManager';
import { WebChatSession } from './utils-web/WebChatSession';
import { fileURLToPath } from 'url';
import { RailwayApi } from "./Api-RailWay/Railway";
import { getArgentinaDatetimeString } from "./utils/ArgentinaTime";
import { userQueues, userLocks, handleQueue, registerProcessCallback } from "./utils/queueManager";
import { HistoryHandler, historyEvents } from './utils/HistoryHandler';

// Definir __dirname para ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Instancia global de WebChatManager para sesiones webchat
const webChatManager = new WebChatManager();
// Eliminado: processUserMessageWeb. Usar lógica principal para ambos canales.

/** Puerto en el que se ejecutará el servidor (Railway usa 8080 por defecto) */
const PORT = process.env.PORT || 8080;

const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? "";

// Mapa para persistir el asistente asignado a cada usuario
const userAssignedAssistant = new Map();

let adapterProvider;
export let errorReporter;

const TIMEOUT_MS = 40000;

// Control de timeout por usuario para evitar ejecuciones automáticas superpuestas
const userTimeouts = new Map();

// Mapa para controlar reintentos por usuario
const userRetryCount = new Map();

export const getAssistantResponse = async (assistantId, message, state, fallbackMessage, userId, thread_id = null) => {
    // Obtener threadId para verificar si hay runs activos
    const tId = thread_id || (state && state.get && typeof state.get === 'function' ? state.get('thread_id') : null);
    if (tId) {
        await waitForActiveRuns(tId);
    }

    // Si es un nuevo hilo, envía primero la fecha y hora actual
    if (!thread_id && !tId) {
        const fechaHoraActual = getArgentinaDatetimeString();
        const mensajeFecha = `La fecha y hora actual es: ${fechaHoraActual}`;
        await safeToAsk(assistantId, mensajeFecha, state, userId, errorReporter);
    }
  // Si hay un timeout previo, lo limpiamos
  if (userTimeouts.has(userId)) {
    clearTimeout(userTimeouts.get(userId));
    userTimeouts.delete(userId);
  }

  let timeoutResolve;
  const timeoutPromise = new Promise((resolve) => {
    timeoutResolve = resolve;
    const timeoutId = setTimeout(async () => {
      // Reintentos solo al asistente
      const retries = userRetryCount.get(userId) || 0;
      if (retries < 2) {
        userRetryCount.set(userId, retries + 1);
        console.warn(`⏱ Timeout alcanzado. Reintentando (${retries + 1}/3) con el último mensaje del usuario al asistente...`);
        if (tId) await waitForActiveRuns(tId);
        resolve(safeToAsk(assistantId, message, state, userId, errorReporter));
      } else {
        userRetryCount.set(userId, 0); // Reset para futuros intentos
        console.error(`⏱ Timeout alcanzado. Se realizaron 3 intentos sin respuesta del asistente. Reportando error al grupo.`);
        await errorReporter.reportError(
          new Error("No se recibió respuesta del asistente tras 3 intentos."),
          userId,
          `https://wa.me/${userId}`
        );
        resolve(null);
      }
      userTimeouts.delete(userId);
    }, TIMEOUT_MS);
    userTimeouts.set(userId, timeoutId);
  });

  // Lanzamos la petición a OpenAI usando safeToAsk
  if (tId) await waitForActiveRuns(tId);
  const askPromise = safeToAsk(assistantId, message, state, userId, errorReporter).then((result) => {
    // Si responde antes del timeout, limpiamos el timeout y el contador de reintentos
    if (userTimeouts.has(userId)) {
      clearTimeout(userTimeouts.get(userId));
      userTimeouts.delete(userId);
    }
    userRetryCount.set(userId, 0);
    timeoutResolve(result);
    return result;
  });

  // El primero que responda (OpenAI o timeout) gana
  return Promise.race([askPromise, timeoutPromise]);
};

// IDs genéricos de asistentes
const ASSISTANT_1 = process.env.ASSISTANT_1; // Recepcionista
const ASSISTANT_2 = process.env.ASSISTANT_2; // Asistente2
const ASSISTANT_3 = process.env.ASSISTANT_3; // Asistente3
const ASSISTANT_4 = process.env.ASSISTANT_4; // ASistente4 (opcional, si se usa otro asistente)
const ASSISTANT_5 = process.env.ASSISTANT_5; // Asistente5 (opcional, si se usa otro asistente)

// Mapeo lógico para derivación
export const ASSISTANT_MAP = {
    asistente1: ASSISTANT_1,
    asistente2: ASSISTANT_2,
    asistente3: ASSISTANT_3,
    asistente4: ASSISTANT_4, // opcional
    asistente5: ASSISTANT_5, // opcional
};

/**
 * Analiza la respuesta del recepcionista para determinar el destino.
 * Devuelve: 'asistente1', 'asistente2', 'asistente3', 'cliente', 'ambiguous' o null
 */
export function analizarDestinoRecepcionista(respuesta) {
    const lower = respuesta.toLowerCase();
    // Detecta frases como "derivar a asistenteX", "derivando a asistenteX", etc.
    // Se requiere que la frase incluya explícitamente la palabra "derivar" o "derivando" para evitar falsos positivos
    if (/derivar(?:ndo)?\s+a\s+asistente\s*1\b/.test(lower)) return 'asistente1';
    if (/derivar(?:ndo)?\s+a\s+asistente\s*2\b/.test(lower)) return 'asistente2';
    if (/derivar(?:ndo)?\s+a\s+asistente\s*3\b/.test(lower)) return 'asistente3';
    if (/derivar(?:ndo)?\s+a\s+asistente\s*4\b/.test(lower)) return 'asistente4'; 
    if (/derivar(?:ndo)?\s+a\s+asistente\s*5\b/.test(lower)) return 'asistente5';
    
    // Si contiene "derivar" o "derivando" pero no es claro el destino
    if (/derivar|derivando/.test(lower)) return 'ambiguous';
    return null;
}

/**
 * Extrae el resumen GET_RESUMEN de la respuesta del recepcionista
 */
export function extraerResumenRecepcionista(respuesta) {
    // Busca bloques que comiencen con GET_RESUMEN
    const match = respuesta.match(/GET_RESUMEN[\s\S]+/i);
    // Si no hay resumen explícito, devolvemos un mensaje genérico de continuación en lugar de toda la respuesta
    // para evitar que el siguiente asistente reciba su propio mensaje anterior como entrada del usuario.
    return match ? match[0].trim() : "Continúa con la atención del cliente.";
}

const processUserMessage = async (
    ctx,
    { flowDynamic, state, provider, gotoFlow }
) => {
    await typing(ctx, provider);
    try {
        // Persistir mensaje del usuario
        await HistoryHandler.saveMessage(ctx.from, 'user', ctx.body, ctx.type, ctx.pushName);

        // Verificar si el bot está activado para este chat (Intervención humana)
        const botEnabled = await HistoryHandler.isBotEnabled(ctx.from);
        if (!botEnabled) {
            console.log(`[BACKOFFICE] Bot desactivado para ${ctx.from}. Ignorando IA.`);
            return;
        }

        // Determinar el asistente asignado actual
        const assigned = userAssignedAssistant.get(ctx.from) || 'asistente1';
        const response = await getAssistantResponse(
            ASSISTANT_MAP[assigned],
            ctx.body,
            state,
            "Por favor, responde aunque sea brevemente.",
            ctx.from
        );
        if (!response) {
            await errorReporter.reportError(
                new Error("No se recibió respuesta del asistente."),
                ctx.from,
                `https://wa.me/${ctx.from}`
            );
            return;
        }
        const destino = analizarDestinoRecepcionista(response);
        const resumen = extraerResumenRecepcionista(response);
        console.log(`[DERIVACION] Respuesta ${assigned}:`, response);
        console.log(`[DERIVACION] Destino detectado:`, destino);
        // Limpiar la respuesta para el usuario
        const respuestaSinResumen = String(response)
            .replace(/GET_RESUMEN[\s\S]+/i, '')
            .replace(/^[ \t]*derivar(?:ndo)? a (asistente\s*[1-5]|asesor humano)\.?\s*$/gim, '')
            .replace(/\[Enviando.*$/gim, '')
            .replace(/^[ \t]*\n/gm, '')
            .trim();

        // Si hay una derivación clara y es a un asistente DIFERENTE al actual
        if (destino && ASSISTANT_MAP[destino] && destino !== assigned) {
            userAssignedAssistant.set(ctx.from, destino);
            // Enviar respuesta limpia del asistente anterior (si hay)
            if (respuestaSinResumen) {
                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    respuestaSinResumen,
                    ctx,
                    flowDynamic,
                    state,
                    provider,
                    gotoFlow,
                    getAssistantResponse,
                    ASSISTANT_MAP[assigned]
                );
            }
            // Derivar y responder con el nuevo asistente
            const respuestaDestino = await getAssistantResponse(
                ASSISTANT_MAP[destino],
                resumen,
                state,
                "Por favor, responde aunque sea brevemente.",
                ctx.from
            );
            await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                String(respuestaDestino).trim(),
                ctx,
                flowDynamic,
                state,
                provider,
                gotoFlow,
                getAssistantResponse,
                ASSISTANT_MAP[destino]
            );
            return state;
        } else if (destino === 'ambiguous') {
            // No cambiar el asistente, solo mostrar respuesta
            if (respuestaSinResumen) {
                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    respuestaSinResumen,
                    ctx,
                    flowDynamic,
                    state,
                    provider,
                    gotoFlow,
                    getAssistantResponse,
                    ASSISTANT_MAP[assigned]
                );
            }
            return state;
        } else {
            // No hay derivación, mantener el asistente actual
            if (respuestaSinResumen) {
                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    respuestaSinResumen,
                    ctx,
                    flowDynamic,
                    state,
                    provider,
                    gotoFlow,
                    getAssistantResponse,
                    ASSISTANT_MAP[assigned]
                );
                // Persistir respuesta del asistente
                await HistoryHandler.saveMessage(ctx.from, 'assistant', respuestaSinResumen);
            }
            return state;
        }
    } catch (error) {
        console.error("Error al procesar el mensaje del usuario:", error);
        await errorReporter.reportError(
            error,
            ctx.from,
            `https://wa.me/${ctx.from}`
        );
        if (ctx.type === EVENTS.VOICE_NOTE) {
            return gotoFlow(welcomeFlowVoice);
        } else {
            return gotoFlow(welcomeFlowTxt);
        }
    }
};


// Main function to initialize the bot and load Google Sheets data
const main = async () => {
    await restoreSessionFromDb();

    // Verificar credenciales de Google Sheets al iniciar
    //await testAuth();

    // Actualizar listado de imágenes en vector store
    //await listImg();

    // Cargar todas las hojas principales con una sola función reutilizable
    await updateMain();

    // Registrar el callback para procesar mensajes de la cola
    registerProcessCallback(async (item) => {
        await processUserMessage(item.ctx, item);
    });


                // ...existing code...
                const adapterFlow = createFlow([welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, welcomeFlowDoc, welcomeFlowVideo, locationFlow, idleFlow, welcomeFlowButton]);
                const adapterDB = new MemoryDB();
                adapterProvider = createProvider(BaileysProvider, {
                    version: [2, 3000, 1030817285],
                    groupsIgnore: false,
                    readStatus: false,
                    disableHttpServer: true,
                });

                adapterProvider.on('require_action', async (payload: any) => {
                    console.log('⚡ [Provider] require_action received. Payload:', payload);
                    let qrString = null;
                    if (typeof payload === 'string') {
                        qrString = payload;
                    } else if (payload && typeof payload === 'object') {
                        if (payload.qr) qrString = payload.qr;
                        else if (payload.code) qrString = payload.code;
                    }
                    if (qrString && typeof qrString === 'string') {
                        console.log('⚡ [Provider] QR Code detected (length: ' + qrString.length + '). Generating image...');
                        try {
                            const qrPath = path.join(process.cwd(), 'bot.qr.png');
                            await QRCode.toFile(qrPath, qrString, {
                                color: { dark: '#000000', light: '#ffffff' },
                                scale: 4,
                                margin: 2
                            });
                            console.log(`✅ [Provider] QR Image saved to ${qrPath}`);
                        } catch (err) {
                            console.error('❌ [Provider] Error generating QR image:', err);
                        }
                    }
                });

                adapterProvider.on('message', (ctx) => {
                    console.log(`Type Msj Recibido: ${ctx.type || 'desconocido'}`);
                    console.log('⚡ [Provider] message received');
                    
                    // Detección de botones para Sherpa/Baileys/Meta
                    const isButton = ctx.message?.buttonsResponseMessage || 
                                     ctx.message?.templateButtonReplyMessage || 
                                     ctx.message?.interactiveResponseMessage ||
                                     ctx.message?.listResponseMessage;
                    
                    if (isButton) {
                        console.log('🔘 Interacción de botón específica detectada');
                        // Mapear el texto del botón al body para que el flujo pueda procesarlo
                        if (ctx.message?.buttonsResponseMessage) {
                            ctx.body = ctx.message.buttonsResponseMessage.selectedDisplayText || ctx.message.buttonsResponseMessage.selectedId;
                        } else if (ctx.message?.templateButtonReplyMessage) {
                            ctx.body = ctx.message.templateButtonReplyMessage.selectedDisplayText || ctx.message.templateButtonReplyMessage.selectedId;
                        } else if (ctx.message?.listResponseMessage) {
                            ctx.body = ctx.message.listResponseMessage.title || ctx.message.listResponseMessage.singleSelectReply?.selectedRowId;
                        } else if (ctx.message?.interactiveResponseMessage) {
                            try {
                                const interactive = JSON.parse(ctx.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
                                ctx.body = interactive.id;
                            } catch (e) {
                                ctx.body = 'buttonInteraction';
                            }
                        }
                        
                        // Asignar el tipo ACTION para disparar welcomeFlowButton
                        ctx.type = EVENTS.ACTION;
                        console.log(`Actualizado -> Type: ${ctx.type} | Body: ${ctx.body}`);
                    } else if (ctx.type === 'desconocido' || !ctx.body) {
                         // Log de ayuda para mensajes de plantilla de Meta no detectados
                         console.log('⚠️ [Debug] Mensaje potencial de plantilla no detectado. Estructura ctx:', JSON.stringify(ctx).substring(0, 500));
                    }
                });

                errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN);

                const { httpServer } = await createBot({
                    flow: adapterFlow,
                    provider: adapterProvider,
                    database: adapterDB,
                });

                startSessionSync();

                httpInject(adapterProvider.server);

                // Usar la instancia Polka (adapterProvider.server) para rutas
                const polkaApp = adapterProvider.server;

                // Middleware para parsear JSON en el body
                polkaApp.use(bodyParser.json());

                // 1. Middleware de compatibilidad (res.json, res.send, res.sendFile, etc)
                polkaApp.use((req, res, next) => {
                    res.status = (code) => { res.statusCode = code; return res; };
                    res.send = (body) => {
                        if (res.headersSent) return res;
                        if (typeof body === 'object') {
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify(body || null));
                        } else {
                            res.end(body || '');
                        }
                        return res;
                    };
                    res.json = (data) => {
                        if (res.headersSent) return res;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(data || null));
                        return res;
                    };
                    res.sendFile = (filepath) => {
                        if (res.headersSent) return;
                        try {
                            if (fs.existsSync(filepath)) {
                                const ext = path.extname(filepath).toLowerCase();
                                const mimeTypes = {
                                    '.html': 'text/html',
                                    '.js': 'application/javascript',
                                    '.css': 'text/css',
                                    '.png': 'image/png',
                                    '.jpg': 'image/jpeg',
                                    '.gif': 'image/gif',
                                    '.svg': 'image/svg+xml',
                                    '.json': 'application/json'
                                };
                                res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
                                fs.createReadStream(filepath)
                                    .on('error', (err) => {
                                        console.error(`[ERROR] Stream error in sendFile (${filepath}):`, err);
                                        if (!res.headersSent) {
                                            res.statusCode = 500;
                                            res.end('Internal Server Error');
                                        }
                                    })
                                    .pipe(res);
                            } else {
                                console.error(`[ERROR] sendFile: File not found: ${filepath}`);
                                res.statusCode = 404;
                                res.end('Not Found');
                            }
                        } catch (e) {
                            console.error(`[ERROR] Error in sendFile (${filepath}):`, e);
                            if (!res.headersSent) {
                                res.statusCode = 500;
                                res.end('Internal Error');
                            }
                        }
                    };
                    next();
                });

                // 2. Middleware de logging y redirección de raíz
                polkaApp.use((req, res, next) => {
                    if (req.url === "/" || req.url === "") {
                        res.writeHead(302, { 'Location': '/dashboard' });
                        return res.end();
                    }
                    next();
                });

                polkaApp.use("/js", serve(path.join(process.cwd(), "src", "js")));
                polkaApp.use("/style", serve(path.join(process.cwd(), "src", "style")));
                polkaApp.use("/assets", serve(path.join(process.cwd(), "src", "assets")));
                
                // Utilidad para servir páginas HTML estáticas
                function serveHtmlPage(route, filename) {
                    polkaApp.get(route, (req, res) => {
                        console.log(`[DEBUG] Request for ${route} -> serving ${filename}`);
                        try {
                            const possiblePaths = [
                                path.join(process.cwd(), 'src', 'html', filename),
                                path.join(process.cwd(), 'html', filename),
                                path.join(__dirname, 'html', filename),
                                path.join(__dirname, '..', 'src', 'html', filename)
                            ];

                            let htmlPath = null;
                            for (const p of possiblePaths) {
                                if (fs.existsSync(p)) {
                                    htmlPath = p;
                                    break;
                                }
                            }

                            if (htmlPath) {
                                console.log(`[DEBUG] Found HTML at: ${htmlPath}`);
                                res.sendFile(htmlPath);
                            } else {
                                console.error(`[ERROR] HTML file not found: ${filename}. Searched in: ${possiblePaths.join(', ')}`);
                                res.status(404).send(`HTML no encontrado: ${filename}`);
                            }
                        } catch (err) {
                            console.error(`[ERROR] Failed to serve ${filename}:`, err);
                            res.status(500).send('Error interno al servir HTML');
                        }
                    });
                }

                // Registrar páginas HTML
                serveHtmlPage("/dashboard", "dashboard.html");
                serveHtmlPage("/webreset", "webreset.html");
                serveHtmlPage("/variables", "variables.html");

                // Ruta explícita para webchat para evitar conflictos
                polkaApp.get("/webchat", (req, res) => {
                    console.log(`[DEBUG] Explicit request for /webchat`);
                    const htmlPath = path.join(process.cwd(), 'src', 'html', 'webchat.html');
                    if (fs.existsSync(htmlPath)) {
                        res.sendFile(htmlPath);
                    } else {
                        // Fallback a la lógica de serveHtmlPage si no está en la ruta esperada
                        const possiblePaths = [
                            path.join(process.cwd(), 'html', 'webchat.html'),
                            path.join(__dirname, 'html', 'webchat.html'),
                            path.join(__dirname, '..', 'src', 'html', 'webchat.html')
                        ];
                        let found = false;
                        for (const p of possiblePaths) {
                            if (fs.existsSync(p)) {
                                res.sendFile(p);
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            res.status(404).send("Webchat HTML no encontrado");
                        }
                    }
                });

                // API Endpoints para el Dashboard
                polkaApp.get("/api/dashboard-status", (req, res) => {
                    try {
                        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
                        const active = fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).length > 0;
                        res.json({ success: true, active });
                    } catch (err) {
                        res.json({ success: false, error: err.message });
                    }
                });

                polkaApp.get("/api/assistant-name", (req, res) => {
                    res.json({ name: process.env.ASSISTANT_NAME || 'Asistente demo' });
                });

                polkaApp.get("/api/variables", async (req, res) => {
                    try {
                        const variables = await RailwayApi.getVariables();
                        if (variables) {
                            res.json({ success: true, variables });
                        } else {
                            // Fallback a process.env si falla la API
                            const vars = {};
                            const keys = [
                                'ASSISTANT_NAME', 'ASSISTANT_1', 'ASSISTANT_2', 'ASSISTANT_3', 'ASSISTANT_4', 'ASSISTANT_5', 'ASSISTANT_ID_IMG', 'OPENAI_API_KEY', 'OPENAI_API_KEY_IMG',
                                'ID_GRUPO_RESUMEN', 'ID_GRUPO_RESUMEN_2', 'msjCierre', 'timeOutCierre',
                                'msjSeguimiento1', 'msjSeguimiento2', 'timeOutSeguimiento2', 'msjSeguimiento3', 'timeOutSeguimiento3',
                                'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_CALENDAR_ID',
                                'SHEET_ID_UPDATE', 'SHEET_ID_RESUMEN', 'DOCX_ID_UPDATE', 'VECTOR_STORE_ID',
                                'SUPABASE_URL', 'SUPABASE_KEY', 'RAILWAY_TOKEN', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID'
                            ];
                            keys.forEach(k => { vars[k] = process.env[k] || ''; });
                            res.json({ success: true, variables: vars });
                        }
                    } catch (err) {
                        res.status(500).json({ success: false, error: err.message });
                    }
                });

                polkaApp.post("/api/update-variables", async (req, res) => {
                    try {
                        const { variables } = req.body;
                        if (!variables) return res.status(400).json({ success: false, error: 'No variables provided' });
                        
                        const result = await RailwayApi.updateVariables(variables);
                        if (result.success) {
                            res.json({ success: true });
                        } else {
                            res.status(500).json({ success: false, error: result.error });
                        }
                    } catch (err) {
                        res.status(500).json({ success: false, error: err.message });
                    }
                });

                polkaApp.post("/api/delete-session", async (req, res) => {
                    try {
                        await deleteSessionFromDb();
                        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
                        if (fs.existsSync(sessionsDir)) {
                            fs.rmSync(sessionsDir, { recursive: true, force: true });
                        }
                        res.json({ success: true });
                    } catch (err) {
                        res.status(500).json({ success: false, error: err.message });
                    }
                });

                polkaApp.post("/api/restart-bot", async (req, res) => {
                    try {
                        const result = await RailwayApi.restartActiveDeployment();
                        if (result.success) {
                            res.json({ success: true, message: "Reinicio solicitado correctamente." });
                        } else {
                            res.status(500).json({ success: false, error: result.error || "Error desconocido" });
                        }
                    } catch (err) {
                        res.status(500).json({ success: false, error: err.message });
                    }
                });

                polkaApp.get("/qr.png", (req, res) => {
                    const qrPath = path.join(process.cwd(), 'bot.qr.png');
                    if (fs.existsSync(qrPath)) {
                        res.sendFile(qrPath);
                    } else {
                        res.status(404).send('QR no generado aún');
                    }
                });

                // ==========================================
                // BACKOFFICE CRM API & REAL-TIME
                // ==========================================
                
                // Middleware simple de autenticación
                const BACKOFFICE_TOKEN = process.env.BACKOFFICE_TOKEN || "admin.123";
                const backofficeAuth = (req, res, next) => {
                    const token = req.query.token || req.headers['authorization'];
                    if (token === BACKOFFICE_TOKEN) {
                        return next();
                    }
                    console.warn(`[AUTH] Intento de acceso no autorizado desde ${req.socket.remoteAddress}`);
                    res.status(401).json({ success: false, error: 'Unauthorized' });
                };

                // Socket.IO para tiempo real
                const io = new Server(adapterProvider.server.server);
                historyEvents.on('new_message', (payload) => {
                    io.emit('new_message', payload);
                });
                historyEvents.on('bot_toggled', (payload) => {
                    io.emit('bot_toggled', payload);
                });

                // Rutas API Backoffice
                polkaApp.post('/api/backoffice/auth', (req, res) => {
                    const { token } = req.body;
                    if (token === BACKOFFICE_TOKEN) {
                        res.json({ success: true });
                    } else {
                        res.json({ success: false });
                    }
                });

                polkaApp.get('/api/backoffice/chats', backofficeAuth, async (req, res) => {
                    const chats = await HistoryHandler.listChats();
                    res.json(chats);
                });

                polkaApp.get('/api/backoffice/messages/:chatId', backofficeAuth, async (req, res) => {
                    const messages = await HistoryHandler.getMessages(req.params.chatId);
                    res.json(messages);
                });

                polkaApp.post('/api/backoffice/toggle-bot', backofficeAuth, async (req, res) => {
                    const { chatId, enabled } = req.body;
                    const result = await HistoryHandler.toggleBot(chatId, enabled);
                    res.json(result);
                });

                polkaApp.get('/api/backoffice/profile-pic/:chatId', backofficeAuth, async (req, res) => {
                    try {
                        const chatId = req.params.chatId;
                        if (!chatId.includes('@')) { // Si no es WhatsApp (ej: webchat)
                            return res.status(404).end();
                        }
                        const url = await adapterProvider.vendor.profilePictureUrl(chatId, 'image');
                        const imgRes = await fetch(url);
                        const buffer = await imgRes.arrayBuffer();
                        res.setHeader('Content-Type', 'image/jpeg');
                        res.end(Buffer.from(buffer));
                    } catch (e) {
                        res.status(404).end();
                    }
                });

                polkaApp.post('/api/backoffice/send-message', backofficeAuth, async (req, res) => {
                    try {
                        const { chatId, content } = req.body;
                        if (!chatId || !content) return res.status(400).json({ error: 'Missing data' });

                        // Enviar mensaje por WhatsApp vía provider
                        await adapterProvider.sendMessage(chatId, content, {});
                        
                        // Guardar en historial como assistant (o humano)
                        await HistoryHandler.saveMessage(chatId, 'assistant', content);

                        res.json({ success: true });
                    } catch (err) {
                        res.status(500).json({ error: err.message });
                    }
                });

                // Registrar páginas HTML de Backoffice
                serveHtmlPage("/backoffice", "backoffice.html");
                serveHtmlPage("/login", "login.html");

                // Obtener el servidor HTTP real de BuilderBot después de httpInject
                const realHttpServer = adapterProvider.server.server;

                // Integrar AssistantBridge si es necesario
                const assistantBridge = new AssistantBridge();
                assistantBridge.setupWebChat(polkaApp, realHttpServer);

                                polkaApp.post('/webchat-api', async (req, res) => {
                                    console.log('Llamada a /webchat-api');
                                    let message = '';
                                    let ip = '';
                                    
                                    // 1. Obtener mensaje y contexto independientemente de si el body ya está parseado o no
                                    if (req.body && req.body.message) {
                                        message = req.body.message;
                                    } else {
                                        // Fallback manual si req.body no está disponible (stream)
                                        const body = await new Promise<string>((resolve) => {
                                            let chunk = '';
                                            req.on('data', c => { chunk += c; });
                                            req.on('end', () => resolve(chunk));
                                        });
                                        try {
                                            const parsed = JSON.parse(body);
                                            message = parsed.message;
                                        } catch (e) {
                                            return res.status(400).end(JSON.stringify({ error: 'Invalid JSON' }));
                                        }
                                    }

                                    if (!message) return res.status(400).end(JSON.stringify({ error: 'No message' }));

                                    // 2. Determinar IP para sesión
                                    const xff = req.headers['x-forwarded-for'];
                                    if (typeof xff === 'string') ip = xff.split(',')[0];
                                    else if (Array.isArray(xff)) ip = xff[0];
                                    else ip = req.socket.remoteAddress || '';

                                    try {
                                        const { getOrCreateThreadId, deleteThread } = await import('./utils-web/openaiThreadBridge');
                                        const session = webChatManager.getSession(ip);

                                        if (message.trim().toLowerCase() === "#reset" || message.trim().toLowerCase() === "#cerrar") {
                                            await deleteThread(session);
                                            session.clear();
                                            return res.json({ reply: "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación." });
                                        }

                                        // 3. Preparar contexto y recolector de respuestas (flowDynamic)
                                        const threadId = await getOrCreateThreadId(session);
                                        const ctx = {
                                            from: ip,
                                            body: message,
                                            type: 'webchat',
                                            thread_id: threadId
                                        };

                                        const replyChunks: string[] = [];
                                        const flowDynamic = async (arr: any) => {
                                            if (Array.isArray(arr)) {
                                                arr.forEach(a => { if (a.body) replyChunks.push(a.body); });
                                            } else if (typeof arr === 'string') {
                                                replyChunks.push(arr);
                                            }
                                        };

                                        const state = {
                                            get: (key: string) => (key === 'thread_id' ? threadId : undefined),
                                            update: async () => {}, // No persistencia en este flujo simplificado
                                        };

                                        // 4. Ejecutar proceso principal
                                        const assigned = userAssignedAssistant.get(ip) || 'asistente1';
                                        const assistantId = ASSISTANT_MAP[assigned];

                                        // El primer mensaje se envía al asistente para obtener la respuesta inicial
                                        const initialResponse = await getAssistantResponse(assistantId, message, state, undefined, ip, threadId);
                                        
                                        if (!initialResponse) {
                                            return res.json({ reply: 'Lo siento, no pude obtener una respuesta del asistente.' });
                                        }

                                        // Procesar la respuesta a través del AssistantResponseProcessor (esto ejecutará [DB:...], etc.)
                                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                                            initialResponse,
                                            ctx,
                                            flowDynamic,
                                            state,
                                            undefined, // provider
                                            () => {}, // gotoFlow
                                            getAssistantResponse,
                                            assistantId
                                        );

                                        const finalReply = replyChunks.join('\n\n').trim();
                                        res.json({ reply: finalReply || 'Sin respuesta.' });

                                    } catch (err) {
                                        console.error('Error en /webchat-api:', err);
                                        res.status(500).json({ reply: 'Hubo un error procesando tu mensaje.' });
                                    }
                                });

            // No llamar a listen, BuilderBot ya inicia el servidor

    // ...existing code...
    httpServer(+PORT);
};

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

export {
    welcomeFlowTxt,
    welcomeFlowVoice,
    welcomeFlowImg,
    welcomeFlowDoc,
    locationFlow,
    welcomeFlowVideo,
    userAssignedAssistant,
    processUserMessage
};

main();

//ok