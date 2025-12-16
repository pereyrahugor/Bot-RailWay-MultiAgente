// ...existing imports y lógica del bot...

import path from 'path';
import serve from 'serve-static';
import { Server } from 'socket.io';
import fs from 'fs';
// Estado global para encender/apagar el bot
//let botEnabled = true;
import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "builderbot-provider-sherpa";
import { restoreSessionFromDb, startSessionSync } from "./utils/sessionSync";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import { idleFlow } from "./Flows/idleFlow";
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
import { welcomeFlowDoc } from "./Flows/welcomeFlowDoc";
//import { imgResponseFlow } from "./Flows/imgResponse";
import { updateMain } from "./addModule/updateMain";
//import { listImg } from "./addModule/listImg";
import { ErrorReporter } from "./utils/errorReporter";
//import { testAuth } from './utils/test-google-auth.js';
import { AssistantBridge } from './utils-web/AssistantBridge';
import { WebChatManager } from './utils-web/WebChatManager';
import { WebChatSession } from './utils-web/WebChatSession';
import { fileURLToPath } from 'url';
import { RailwayApi } from "./Api-RailWay/Railway";

// Definir __dirname para ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Instancia global de WebChatManager para sesiones webchat
const webChatManager = new WebChatManager();
// Eliminado: processUserMessageWeb. Usar lógica principal para ambos canales.

/** Puerto en el que se ejecutará el servidor (Railway usa 8080 por defecto) */
const PORT = process.env.PORT || 8080;

/** ID del asistente de OpenAI */
//const ASSISTANT_ID = process.env.ASSISTANT_ID;
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? "";

const userQueues = new Map();
const userLocks = new Map();
// Mapa para persistir el asistente asignado a cada usuario
const userAssignedAssistant = new Map();

let adapterProvider;
let errorReporter;

const TIMEOUT_MS = 40000;

// Control de timeout por usuario para evitar ejecuciones automáticas superpuestas
const userTimeouts = new Map();

// Mapa para controlar reintentos por usuario
const userRetryCount = new Map();

export const getAssistantResponse = async (assistantId, message, state, fallbackMessage, userId, thread_id = null) => {
    // Si es un nuevo hilo, envía primero la fecha y hora actual
    if (!thread_id) {
        const moment = (await import('moment')).default;
        const fechaHoraActual = moment().format('YYYY-MM-DD HH:mm');
        const mensajeFecha = `La fecha y hora actual es: ${fechaHoraActual}`;
        await toAsk(assistantId, mensajeFecha, state);
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
        resolve(toAsk(assistantId, message, state));
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

  // Lanzamos la petición a OpenAI
  const askPromise = toAsk(assistantId, message, state).then((result) => {
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
    // Detecta frases como "derivar a asistenteX", "derivando a asistenteX", etc. en cualquier parte del texto
    if (/asistente\s*1\b/.test(lower)) return 'asistente1';
    if (/asistente\s*2\b/.test(lower)) return 'asistente2';
    if (/asistente\s*3\b/.test(lower)) return 'asistente3';
    if (/asistente\s*4\b/.test(lower)) return 'asistente4'; // opcional
    if (/asistente\s*5\b/.test(lower)) return 'asistente5'; // opcional
    // Detecta frases como "derivar a asesor humano", "derivando a asesor humano", etc.
    //if (/asesor humano/.test(lower)) return 'cliente';
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
    return match ? match[0].trim() : respuesta;
}

const processUserMessage = async (
    ctx,
    { flowDynamic, state, provider, gotoFlow }
) => {
    await typing(ctx, provider);
    try {
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
            .replace(/^derivar(?:ndo)? a (asistente\s*[1-5]|asesor humano)\.?$/gim, '')
            .replace(/\[Enviando.*$/gim, '')
            .replace(/^[ \t]*\n/gm, '')
            .trim();

        // Si hay una derivación clara, actualizar el asistente asignado
        if (destino && ASSISTANT_MAP[destino]) {
            userAssignedAssistant.set(ctx.from, destino);
            // Enviar respuesta limpia del asistente anterior (si hay)
            if (respuestaSinResumen) {
                await flowDynamic([{ body: respuestaSinResumen }]);
            }
            // Derivar y responder con el nuevo asistente
            const respuestaDestino = await getAssistantResponse(
                ASSISTANT_MAP[destino],
                resumen,
                state,
                "Por favor, responde aunque sea brevemente.",
                ctx.from
            );
            await flowDynamic([{ body: String(respuestaDestino).trim() }]);
            return state;
        } else if (destino === 'ambiguous') {
            // No cambiar el asistente, solo mostrar respuesta
            if (respuestaSinResumen) {
                await flowDynamic([{ body: respuestaSinResumen }]);
            }
            return state;
        } else {
            // No hay derivación, mantener el asistente actual
            if (respuestaSinResumen) {
                await flowDynamic([{ body: respuestaSinResumen }]);
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


const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) return;

    userLocks.set(userId, true);

    while (queue.length > 0) {
        const { ctx, flowDynamic, state, provider, gotoFlow } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider, gotoFlow });
        } catch (error) {
            console.error(`Error procesando el mensaje de ${userId}:`, error);
        }
    }

    userLocks.set(userId, false);
    userQueues.delete(userId);
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


                // ...existing code...
                const adapterFlow = createFlow([welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, welcomeFlowDoc, idleFlow]);
                const adapterDB = new MemoryDB();
                adapterProvider = createProvider(BaileysProvider, {
                    version: [2, 3000, 1030817285],
                    groupsIgnore: false,
                    readStatus: false,
                    disableHttpServer: true,
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
                polkaApp.use("/js", serve("src/js"));
                polkaApp.use("/style", serve("src/style"));
                polkaApp.use("/assets", serve("src/assets"));
                
                // Utilidad para servir páginas HTML estáticas
                                function serveHtmlPage(route, filename) {
                                    polkaApp.get(route, (req, res) => {
                                        res.setHeader("Content-Type", "text/html");
                                        // Buscar primero en src/ (local), luego en /app/src/ (deploy)
                                        let htmlPath = path.join(__dirname, filename);
                                        if (!fs.existsSync(htmlPath)) {
                                            // Buscar en /app/src/ (deploy)
                                            htmlPath = path.join(process.cwd(), 'src', filename);
                                        }
                                        try {
                                            res.end(fs.readFileSync(htmlPath));
                                        } catch (err) {
                                            res.statusCode = 404;
                                            res.end('HTML no encontrado');
                                        }
                                    });
                                }

                                // Registrar páginas HTML
                                serveHtmlPage("/webchat", "webchat.html");
                                serveHtmlPage("/webreset", "webreset.html");

                                  // Endpoint para reiniciar el bot vía Railway
  polkaApp.post("/api/restart-bot", async (req, res) => {
  console.log('POST /api/restart-bot recibido');
  try {
    const result = await RailwayApi.restartActiveDeployment();
    console.log('Resultado de restartRailwayDeployment:', result);
    if (result.success) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: "Reinicio solicitado correctamente."
      }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: result.error || "Error desconocido" }));
    }
  } catch (err: any) {
    console.error('Error en /api/restart-bot:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});

                // Obtener el servidor HTTP real de BuilderBot después de httpInject
                const realHttpServer = adapterProvider.server.server;

                // Integrar Socket.IO sobre el servidor HTTP real de BuilderBot
                const io = new Server(realHttpServer, { cors: { origin: '*' } });
                io.on('connection', (socket) => {
                    console.log('💬 Cliente web conectado');
                    socket.on('message', async (msg) => {
                        // Procesar el mensaje usando la lógica principal del bot
                        try {
                            let ip = '';
                            const xff = socket.handshake.headers['x-forwarded-for'];
                            if (typeof xff === 'string') {
                                ip = xff.split(',')[0];
                            } else if (Array.isArray(xff)) {
                                ip = xff[0];
                            } else {
                                ip = socket.handshake.address || '';
                            }
                            // Centralizar historial y estado igual que WhatsApp
                            if (!global.webchatHistories) global.webchatHistories = {};
                            const historyKey = `webchat_${ip}`;
                            if (!global.webchatHistories[historyKey]) global.webchatHistories[historyKey] = [];
                            const _history = global.webchatHistories[historyKey];
                            const state = {
                                get: function (key) {
                                    if (key === 'history') return _history;
                                    return undefined;
                                },
                                update: async function (msg, role = 'user') {
                                    if (_history.length > 0) {
                                        const last = _history[_history.length - 1];
                                        if (last.role === role && last.content === msg) return;
                                    }
                                    _history.push({ role, content: msg });
                                    if (_history.length >= 6) {
                                        const last3 = _history.slice(-3);
                                        if (last3.every(h => h.role === 'user' && h.content === msg)) {
                                            _history.length = 0;
                                        }
                                    }
                                },
                                clear: async function () { _history.length = 0; }
                            };
                            const provider = undefined;
                            const gotoFlow = () => {};
                            let replyText = '';
                            const flowDynamic = async (arr) => {
                                if (Array.isArray(arr)) {
                                    replyText = arr.map(a => a.body).join('\n');
                                } else if (typeof arr === 'string') {
                                    replyText = arr;
                                }
                            };
                            if (msg.trim().toLowerCase() === "#reset" || msg.trim().toLowerCase() === "#cerrar") {
                                await state.clear();
                                replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
                            } else {
                                await processUserMessage({ from: ip, body: msg, type: 'webchat' }, { flowDynamic, state, provider, gotoFlow });
                            }
                            socket.emit('reply', replyText);
                        } catch (err) {
                            console.error('Error procesando mensaje webchat:', err);
                            socket.emit('reply', 'Hubo un error procesando tu mensaje.');
                        }
                    });
                });

                // Agregar ruta personalizada para el webchat
                polkaApp.get('/webchat', (req, res) => {
                    res.setHeader('Content-Type', 'text/html');
                    res.end(fs.readFileSync(path.join(__dirname, '../webchat.html')));
                });

                // Integrar AssistantBridge si es necesario
                const assistantBridge = new AssistantBridge();
                assistantBridge.setupWebChat(polkaApp, realHttpServer);

                                polkaApp.post('/webchat-api', async (req, res) => {
                                    console.log('Llamada a /webchat-api'); // log para debug
                                    // Si el body ya está disponible (por ejemplo, con body-parser), úsalo directamente
                                    if (req.body && req.body.message) {
                                        console.log('Body recibido por body-parser:', req.body); // debug
                                        try {
                                            const message = req.body.message;
                                            console.log('Mensaje recibido en webchat:', message); // debug
                                            let ip = '';
                                            const xff = req.headers['x-forwarded-for'];
                                            if (typeof xff === 'string') {
                                                ip = xff.split(',')[0];
                                            } else if (Array.isArray(xff)) {
                                                ip = xff[0];
                                            } else {
                                                ip = req.socket.remoteAddress || '';
                                            }
                                            // Crear un ctx similar al de WhatsApp, usando el IP como 'from'
                                            const ctx = {
                                                from: ip,
                                                body: message,
                                                type: 'webchat',
                                                // Puedes agregar más propiedades si tu lógica lo requiere
                                            };
                                            // Usar la lógica principal del bot (processUserMessage)
                                            let replyText = '';
                                            // Simular flowDynamic para capturar la respuesta
                                            const flowDynamic = async (arr) => {
                                                if (Array.isArray(arr)) {
                                                    replyText = arr.map(a => a.body).join('\n');
                                                } else if (typeof arr === 'string') {
                                                    replyText = arr;
                                                }
                                            };
                                                // Usar WebChatManager y WebChatSession para gestionar la sesión webchat
                                                const { getOrCreateThreadId, sendMessageToThread, deleteThread } = await import('./utils-web/openaiThreadBridge');
                                                const session = webChatManager.getSession(ip);
                                                if (message.trim().toLowerCase() === "#reset" || message.trim().toLowerCase() === "#cerrar") {
                                                    await deleteThread(session);
                                                    session.clear();
                                                    replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
                                                } else {
                                                    // Asignar el asistente actual igual que WhatsApp
                                                    const assigned = userAssignedAssistant.get(ip) || 'asistente1';
                                                    const assistantId = ASSISTANT_MAP[assigned];
                                                    session.addUserMessage(message);
                                                    const threadId = await getOrCreateThreadId(session);
                                                    let reply = await sendMessageToThread(threadId, message, assistantId);
                                                    let destino = analizarDestinoRecepcionista(reply);
                                                    // Si hay una derivación clara, actualizar el asistente asignado y volver a consultar al nuevo asistente
                                                    if (destino && ASSISTANT_MAP[destino]) {
                                                        userAssignedAssistant.set(ip, destino);
                                                        // Reconsultar al nuevo asistente para esta misma interacción
                                                        reply = await sendMessageToThread(threadId, message, ASSISTANT_MAP[destino]);
                                                        destino = analizarDestinoRecepcionista(reply); // por si hay doble derivación
                                                    }
                                                    // Limpiar la respuesta para el usuario
                                                    const respuestaSinResumen = String(reply)
                                                        .replace(/GET_RESUMEN[\s\S]+/i, '')
                                                        .replace(/^derivar(?:ndo)? a (asistente\s*[1-5]|asesor humano)\.?$/gim, '')
                                                        .replace(/\[Enviando.*$/gim, '')
                                                        .replace(/^[ \t]*\n/gm, '')
                                                        .trim();
                                                    session.addAssistantMessage(reply);
                                                    replyText = respuestaSinResumen;
                                            }
                                            res.setHeader('Content-Type', 'application/json');
                                            res.end(JSON.stringify({ reply: replyText }));
                                        } catch (err) {
                                            console.error('Error en /webchat-api:', err); // debug
                                            res.statusCode = 500;
                                            res.end(JSON.stringify({ reply: 'Hubo un error procesando tu mensaje.' }));
                                        }
                                    } else {
                                        // Fallback manual si req.body no está disponible
                                        let body = '';
                                        req.on('data', chunk => { body += chunk; });
                                        req.on('end', async () => {
                                            console.log('Body recibido en /webchat-api:', body); // log para debug
                                            try {
                                                const { message } = JSON.parse(body);
                                                console.log('Mensaje recibido en webchat:', message); // debug
                                                let ip = '';
                                                const xff = req.headers['x-forwarded-for'];
                                                if (typeof xff === 'string') {
                                                    ip = xff.split(',')[0];
                                                } else if (Array.isArray(xff)) {
                                                    ip = xff[0];
                                                } else {
                                                    ip = req.socket.remoteAddress || '';
                                                }
                                                // Centralizar historial y estado igual que WhatsApp
                                                if (!global.webchatHistories) global.webchatHistories = {};
                                                const historyKey = `webchat_${ip}`;
                                                if (!global.webchatHistories[historyKey]) global.webchatHistories[historyKey] = { history: [], thread_id: null };
                                                const _store = global.webchatHistories[historyKey];
                                                const _history = _store.history;
                                                const state = {
                                                    get: function (key) {
                                                        if (key === 'history') return _history;
                                                        if (key === 'thread_id') return _store.thread_id;
                                                        return undefined;
                                                    },
                                                    setThreadId: function (id) {
                                                        _store.thread_id = id;
                                                    },
                                                    update: async function (msg, role = 'user') {
                                                        if (_history.length > 0) {
                                                            const last = _history[_history.length - 1];
                                                            if (last.role === role && last.content === msg) return;
                                                        }
                                                        _history.push({ role, content: msg });
                                                        if (_history.length >= 6) {
                                                            const last3 = _history.slice(-3);
                                                            if (last3.every(h => h.role === 'user' && h.content === msg)) {
                                                                _history.length = 0;
                                                                _store.thread_id = null;
                                                            }
                                                        }
                                                    },
                                                    clear: async function () { _history.length = 0; _store.thread_id = null; }
                                                };
                                                const provider = undefined;
                                                const gotoFlow = () => {};
                                                let replyText = '';
                                                const flowDynamic = async (arr) => {
                                                    if (Array.isArray(arr)) {
                                                        replyText = arr.map(a => a.body).join('\n');
                                                    } else if (typeof arr === 'string') {
                                                        replyText = arr;
                                                    }
                                                };
                                                if (message.trim().toLowerCase() === "#reset" || message.trim().toLowerCase() === "#cerrar") {
                                                    await state.clear();
                                                    replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
                                                } else {
                                                    // ...thread_id gestionado por openaiThreadBridge, no es necesario actualizar aquí...
                                                }
                                                res.setHeader('Content-Type', 'application/json');
                                                res.end(JSON.stringify({ reply: replyText }));
                                            } catch (err) {
                                                console.error('Error en /webchat-api:', err); // debug
                                                res.statusCode = 500;
                                                res.end(JSON.stringify({ reply: 'Hubo un error procesando tu mensaje.' }));
                                            }
                                        });
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
    handleQueue,
    userQueues,
    userLocks,
    userAssignedAssistant,
    processUserMessage
};

main();

//ok