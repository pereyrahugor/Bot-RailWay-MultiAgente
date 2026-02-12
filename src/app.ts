import path from 'path';
import serve from 'serve-static';
import { Server } from 'socket.io';
import fs from 'fs';
import bodyParser from 'body-parser';
import QRCode from 'qrcode';
import "dotenv/config";

import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { YCloudProvider } from "./providers/YCloudProvider";
import { BaileysProvider } from "builderbot-provider-sherpa";
import { adapterProvider, groupProvider, setAdapterProvider, setGroupProvider } from "./providers/instances";
import { restoreSessionFromDb, startSessionSync, deleteSessionFromDb, isSessionInDb } from "./utils/sessionSync";
import { toAsk } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import { idleFlow } from "./Flows/idleFlow";
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
import { welcomeFlowDoc } from "./Flows/welcomeFlowDoc";
import { locationFlow } from "./Flows/locationFlow";
import { welcomeFlowVideo } from "./Flows/welcomeFlowVideo";
import { AssistantResponseProcessor } from "./utils/AssistantResponseProcessor";
import { updateMain } from "./addModule/updateMain";
import { ErrorReporter } from "./utils/errorReporter";
import { AssistantBridge } from "./utils-web/AssistantBridge";
import { WebChatManager } from "./utils-web/WebChatManager";
import { fileURLToPath } from 'url';
import { RailwayApi } from "./Api-RailWay/Railway";
import { getArgentinaDatetimeString } from "./utils/ArgentinaTime";
import { userQueues, userLocks, userAssignedAssistant, handleQueue, setProcessUserMessage } from "./utils/queue";
import { ASSISTANT_MAP, analizarDestinoRecepcionista, extraerResumenRecepcionista } from "./utils/assistantUtils";

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

// Definir __dirname para ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Instancia global de WebChatManager para sesiones webchat
const webChatManager = new WebChatManager();

/** Puerto en el que se ejecutará el servidor (Railway usa 8080 por defecto) */
const PORT = process.env.PORT || 8080;
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? "";

// Estado global para encender/apagar el bot
const botEnabled = true;

let errorReporter;

// Función auxiliar para verificar el estado de ambos proveedores
const getBotStatus = async () => {
    try {
        // 1. Estado YCloud (Meta)
        const ycloudConfigured = !!(process.env.YCLOUD_API_KEY && process.env.YCLOUD_WABA_NUMBER);
        
        // 2. Estado Motor de Grupos (Baileys)
        const groupsReady = !!(groupProvider?.vendor?.user || groupProvider?.globalVendorArgs?.sock?.user);
        
        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
        let groupsLocalActive = false;
        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
            groupsLocalActive = files.includes('creds.json');
        }

        const groupsRemoteActive = await isSessionInDb('groups');

        return {
            ycloud: {
                active: ycloudConfigured,
                status: ycloudConfigured ? 'connected' : 'error',
                phoneNumber: process.env.YCLOUD_WABA_NUMBER || null
            },
            groups: {
                initialized: !!groupProvider,
                active: groupsReady,
                source: groupsReady ? 'connected' : (groupsLocalActive ? 'local' : 'none'),
                hasRemote: groupsRemoteActive,
                qr: fs.existsSync(path.join(process.cwd(), 'bot.groups.qr.png')),
                phoneNumber: groupProvider?.vendor?.user?.id?.split(':')[0] || null
            }
        };
    } catch (e) {
        console.error('[Status] Error obteniendo estado:', e);
        return { error: String(e) };
    }
};

const TIMEOUT_MS = 40000;
const userTimeouts = new Map();
const userRetryCount = new Map();

export const getAssistantResponse = async (assistantId, message, state, fallbackMessage, userId, thread_id = null) => {
    if (!thread_id) {
        const fechaHoraActual = getArgentinaDatetimeString();
        const mensajeFecha = `La fecha y hora actual es: ${fechaHoraActual}`;
        await toAsk(assistantId, mensajeFecha, state);
    }
    if (userTimeouts.has(userId)) {
        clearTimeout(userTimeouts.get(userId));
        userTimeouts.delete(userId);
    }

    let timeoutResolve;
    const timeoutPromise = new Promise((resolve) => {
        timeoutResolve = resolve;
        const timeoutId = setTimeout(async () => {
            const retries = userRetryCount.get(userId) || 0;
            if (retries < 2) {
                userRetryCount.set(userId, retries + 1);
                console.warn(`⏱ Timeout alcanzado. Reintentando (${retries + 1}/3)...`);
                resolve(toAsk(assistantId, message, state));
            } else {
                userRetryCount.set(userId, 0);
                console.error(`⏱ Timeout alcanzado tras 3 intentos.`);
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

    const askPromise = toAsk(assistantId, message, state).then((result) => {
        if (userTimeouts.has(userId)) {
            clearTimeout(userTimeouts.get(userId));
            userTimeouts.delete(userId);
        }
        userRetryCount.set(userId, 0);
        timeoutResolve(result);
        return result;
    });

    return Promise.race([askPromise, timeoutPromise]);
};

// Asistentes
const ASSISTANT_1 = process.env.ASSISTANT_1; 
const ASSISTANT_2 = process.env.ASSISTANT_2; 
const ASSISTANT_3 = process.env.ASSISTANT_3; 
const ASSISTANT_4 = process.env.ASSISTANT_4; 
export const processUserMessage = async (
    ctx,
    { flowDynamic, state, provider, gotoFlow }
) => {
    const userId = ctx.from;
    const botNumber = (process.env.YCLOUD_WABA_NUMBER || '').replace(/\D/g, '');
    
    if (userId.replace(/\D/g, '') === botNumber) return;
    if (!botEnabled) return;

    await typing(ctx, provider);
    try {
        const assigned = userAssignedAssistant.get(ctx.from) || 'asistente1';
        const response = await getAssistantResponse(
            (ASSISTANT_MAP[assigned] as string),
            ctx.body,
            state,
            "Por favor, responde aunque sea brevemente.",
            ctx.from
        ) as string;
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
        
        const respuestaSinResumen = String(response)
            .replace(/GET_RESUMEN[\s\S]+/i, '')
            .replace(/^[ \t]*derivar(?:ndo)? a (asistente\s*[1-5]|asesor humano)\.?\s*$/gim, '')
            .replace(/\[Enviando.*$/gim, '')
            .replace(/^[ \t]*\n/gm, '')
            .trim();

        if (destino && ASSISTANT_MAP[destino] && destino !== assigned) {
            userAssignedAssistant.set(ctx.from, destino);
            if (respuestaSinResumen) {
                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    respuestaSinResumen, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, (ASSISTANT_MAP[assigned] as string)
                );
            }
            const respuestaDestino = await getAssistantResponse(
                (ASSISTANT_MAP[destino] as string), resumen, state, "Por favor, responde.", ctx.from
            );
            await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                String(respuestaDestino).trim(), ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, (ASSISTANT_MAP[destino] as string)
            );
            return state;
        } else {
            if (respuestaSinResumen) {
                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                    respuestaSinResumen, ctx, flowDynamic, state, provider, gotoFlow, getAssistantResponse, (ASSISTANT_MAP[assigned] as string)
                );
            }
            return state;
        }
    } catch (error) {
        console.error("Error al procesar el mensaje:", error);
        await errorReporter.reportError(error, ctx.from, `https://wa.me/${ctx.from}`);
        return (ctx.type === EVENTS.VOICE_NOTE) ? gotoFlow(welcomeFlowVoice) : gotoFlow(welcomeFlowTxt);
    }
};

setProcessUserMessage(processUserMessage);

const main = async () => {
    // QR Cleanup
    const qrPath = path.join(process.cwd(), 'bot.qr.png');
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

    // Restore Groups
    await restoreSessionFromDb('groups');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Providers
    setAdapterProvider(createProvider(YCloudProvider, {}));
    setGroupProvider(createProvider(BaileysProvider, {
        version: [2, 3000, 1030817285],
        groupsIgnore: false,
        readStatus: false,
        disableHttpServer: true
    }));

    const handleQR = async (qrString: string) => {
        if (qrString) {
            const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
            await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
        }
    };

    groupProvider.on('require_action', async (p) => handleQR(typeof p === 'string' ? p : p?.qr || p?.code));
    groupProvider.on('qr', handleQR);
    groupProvider.on('ready', () => {
        console.log('✅ [GroupSync] Motor de grupos conectado.');
        const p = path.join(process.cwd(), 'bot.groups.qr.png');
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    setTimeout(async () => {
        if (groupProvider.initVendor) await groupProvider.initVendor();
        else if ((groupProvider as any).init) await (groupProvider as any).init();
    }, 1000);

    adapterProvider.on('message', (ctx) => {
        if (ctx.type === 'interactive' || ctx.type === 'button') ctx.type = EVENTS.ACTION;
    });

    await updateMain();

    console.log('[Main] Iniciando configuración de bot...');
    const adapterFlow = createFlow([welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, welcomeFlowDoc, locationFlow, idleFlow, welcomeFlowVideo]);
    const adapterDB = new MemoryDB();

    console.log('[Main] Llamando a createBot...');
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });
    console.log('[Main] createBot finalizado.');

    errorReporter = new ErrorReporter(groupProvider, ID_GRUPO_RESUMEN);

    startSessionSync('groups');
    // httpInject(adapterProvider.server);

    const app = adapterProvider.server;
    app.use(bodyParser.json());

    // Middleware Compatibilidad
    app.use((req, res, next) => {
        res.status = (c) => { res.statusCode = c; return res; };
        res.send = (b) => {
            if (res.headersSent) return res;
            if (typeof b === 'object') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); }
            else res.end(b || '');
            return res;
        };
        res.json = (d) => {
            if (res.headersSent) return res;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(d));
            return res;
        };
        res.sendFile = (f) => {
            if (res.headersSent) return;
            if (fs.existsSync(f)) {
                const ext = path.extname(f).toLowerCase();
                const mimes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
                res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
                fs.createReadStream(f).pipe(res);
            } else { res.statusCode = 404; res.end('Not Found'); }
        };
        next();
    });

    // Root Redirect
    app.use((req, res, next) => {
        if (req.url === "/" || req.url === "") {
            res.writeHead(302, { 'Location': '/dashboard' });
            return res.end();
        }
        next();
    });

    app.use("/js", serve(path.join(process.cwd(), "src", "js")));
    app.use("/style", serve(path.join(process.cwd(), "src", "style")));
    app.use("/assets", serve(path.join(process.cwd(), "src", "assets")));
    
    app.post('/webhook', (req, res) => {
        console.log('📩 [Webhook] Petición recibida:', JSON.stringify(req.body, null, 2));
        
        // Emitir evento al Dashboard para visualización en vivo
        const bridge = (global as any).assistantBridge;
        if (bridge && bridge.io) {
            const body = req.body?.value?.messages?.[0]?.text?.body || 'Evento de sistema';
            const from = req.body?.value?.messages?.[0]?.from || 'Desconocido';
            bridge.io.emit('webhook_event', { type: 'message', body, from });
        }

        // @ts-ignore
        adapterProvider.handleWebhook(req, res);
    });

    function serveHtmlPage(route, filename) {
        app.get(route, (req, res) => {
            const possible = [
                path.join(process.cwd(), 'src', 'html', filename),
                path.join(process.cwd(), 'html', filename),
                path.join(__dirname, 'html', filename)
            ];
            const found = possible.find(p => fs.existsSync(p));
            if (found) res.sendFile(found);
            else res.status(404).send('Not Found');
        });
    }

    serveHtmlPage("/dashboard", "dashboard.html");
    serveHtmlPage("/webreset", "webreset.html");
    serveHtmlPage("/variables", "variables.html");

    app.get('/dashboard', (req, res) => {
        const dashPath = path.join(__dirname, 'html', 'dashboard-v2.html');
        res.sendFile(dashPath);
    });

    app.get("/webchat", (req, res) => {
        const p = path.join(process.cwd(), 'src', 'html', 'webchat.html');
        if (fs.existsSync(p)) res.sendFile(p);
        else res.status(404).send("Not Found");
    });

    app.get("/api/dashboard-status", async (req, res) => res.json(await getBotStatus()));
    app.get("/api/assistant-name", (req, res) => res.json({ name: process.env.ASSISTANT_NAME || 'Asistente' }));
    
    app.get("/api/variables", async (req, res) => {
        try {
            const variables = await RailwayApi.getVariables();
            res.json({ success: true, variables });
        } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    });

    app.post("/api/update-variables", async (req, res) => {
        try {
            const result = await RailwayApi.updateVariables(req.body.variables);
            res.json({ success: result.success });
        } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    });

    app.post("/api/restart-bot", async (req, res) => {
        res.json({ success: true, message: "Reiniciando..." });
        setTimeout(() => process.exit(0), 1000);
    });

    app.post("/api/delete-session", async (req, res) => {
        const type = req.body.type || 'groups';
        await deleteSessionFromDb(type);
        res.json({ success: true });
    });

    app.get("/qr.png", (req, res) => {
        const p = path.join(process.cwd(), 'bot.groups.qr.png');
        if (fs.existsSync(p)) res.sendFile(p);
        else res.status(404).send('Not Found');
    });

    // AssistantBridge se configurará después de iniciar el httpServer

    app.post('/webchat-api', async (req, res) => {
        if (req.body && req.body.message) {
            const { message } = req.body;
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const session = webChatManager.getSession(ip);
            const { getOrCreateThreadId, sendMessageToThread } = await import('./utils-web/openaiThreadBridge');
            const threadId = await getOrCreateThreadId(session);
            const assigned = userAssignedAssistant.get(ip) || 'asistente1';
            const reply = await sendMessageToThread(threadId, message, ASSISTANT_MAP[assigned]);
            res.json({ reply: String(reply).replace(/GET_RESUMEN[\s\S]+/i, '').trim() });
        }
    });

    try {
        const serverInstance = httpServer(+PORT);
        console.log(`🚀 [Server] Bot listo en puerto ${PORT}`);

        // Configurar Bridge de WebChat
        const bridge = new AssistantBridge();
        (global as any).assistantBridge = bridge;
        
        // Intentar extraer el servidor HTTP real de diversas formas
        // 1. Del retorno de httpServer()
        // 2. De adapterProvider.server.server (Polka)
        // 3. Del objeto adapterProvider.server mismo (Express)
        const webServer = (serverInstance as any)?.server || (adapterProvider.server as any)?.server || adapterProvider.server;
        
        if (webServer && (webServer.listeners || typeof webServer.on === 'function')) {
            console.log(`[Main] Inicializando AssistantBridge...`);
            bridge.setupWebChat(app, webServer);
            console.log('✅ [WebChat] Bridge configurado.');
        } else {
            console.warn('⚠️ [WebChat] No se pudo determinar un servidor válido. Socket.io podría no funcionar.');
        }
    } catch (err) {
        console.error('❌ [Server] Error al iniciar httpServer:', err.stack || err);
    }
};

main().catch(console.error);