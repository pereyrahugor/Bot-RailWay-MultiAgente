
import "dotenv/config";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import QRCode from 'qrcode';

// BuilderBot Core
import { createBot, createProvider, createFlow, EVENTS, MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "builderbot-provider-sherpa";

// Utils & Managers
import { restoreSessionFromDb, startSessionSync, deleteSessionFromDb } from "./utils/sessionSync";
import { AiManager } from "./utils/AiManager";
import { ErrorReporter } from "./utils/errorReporter";
import { HistoryHandler, historyEvents } from './utils/HistoryHandler';
import { WebChatManager } from './utils-web/WebChatManager';
import { AssistantBridge } from './utils-web/AssistantBridge';
import { RailwayApi } from "./Api-RailWay/Railway";
import { updateMain } from "./addModule/updateMain";
import { registerProcessCallback } from "./utils/queueManager";
import { obtenerTextoDelMensaje, obtenerMensajeUnwrapped } from "./utils/messageHelper";
import { openai } from "./utils/OpenAIHandler";

import multer from 'multer';

// Middlewares & Routes
import { 
    compatibilityMiddleware, 
    fileUploadInterceptor, 
    setupStaticRoutes 
} from "./middleware/global";
import { registerBackofficeRoutes } from "./routes/backoffice.routes";

// Flows
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
import { welcomeFlowDoc } from "./Flows/welcomeFlowDoc";
import { welcomeFlowVideo } from "./Flows/welcomeFlowVideo";
import { welcomeFlowButton } from "./Flows/welcomeFlowButton";
import { locationFlow } from "./Flows/locationFlow";
import { idleFlow } from "./Flows/idleFlow";

// --- CONFIGURACIÓN ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const ID_GRUPO_WS = process.env.ID_GRUPO_WS ?? "";

// --- ESTADO GLOBAL ---
export let errorReporter: ErrorReporter;
export let adapterProvider: any;
export let aiManager: AiManager;
const webChatManager = new WebChatManager();

/**
 * Función exportada para ser usada por AssistantBridge (webchat)
 */
export const processUserMessage = async (ctx: any, payload: any) => {
    if (!aiManager) {
        console.error("❌ AiManager no inicializado");
        return;
    }
    return await aiManager.processUserMessage(ctx, payload);
};

/**
 * Lógica principal de inicialización
 */
const main = async () => {
    console.log("🚀 Iniciando Bot...");

    // 1. Restaurar sesión desde DB (Supabase/Railway persistence)
    await restoreSessionFromDb();

    // 2. Cargar datos iniciales (Google Sheets, etc.)
    try {
        await updateMain();
    } catch (e) {
        console.warn("⚠️ No se pudieron cargar los datos iniciales.");
    }

    // 3. Inicializar Proveedor (Baileys via Sherpa)
    adapterProvider = createProvider(BaileysProvider, {
        version: [2, 3000, 1030817285],
        groupsIgnore: false,
        readStatus: false,
        disableHttpServer: true, // Nosotros manejaremos el servidor con Polka
    });

    // 4. Inicializar ErrorReporter e IA Manager
    errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_WS);
    aiManager = new AiManager(openai, errorReporter, { 
        welcomeFlowTxt, 
        welcomeFlowVoice, 
        welcomeFlowButton 
    });

    // 5. Configurar Flows y DB
    const adapterFlow = createFlow([
        welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, 
        welcomeFlowDoc, welcomeFlowVideo, locationFlow, 
        idleFlow, welcomeFlowButton
    ]);
    const adapterDB = new MemoryDB();

    // 6. Registro de procesamiento de cola
    registerProcessCallback(async (item) => {
        await aiManager.processUserMessage(item.ctx, item);
    });

    // 7. Eventos del Proveedor (QR y Mensajes Raw)
    adapterProvider.on('require_action', async (payload: any) => {
        const qrString = typeof payload === 'string' ? payload : (payload?.qr || payload?.code);
        if (qrString) {
            const qrPath = path.join(process.cwd(), 'bot.qr.png');
            await QRCode.toFile(qrPath, qrString, { scale: 4 });
            console.log(`✅ QR generado: ${qrPath}`);
        }
    });

    adapterProvider.on('message', (ctx: any) => {
        const message = obtenerMensajeUnwrapped(ctx);
        if (message) ctx.message = message;
        
        // Normalizar body para eventos de BuilderBot
        const texto = obtenerTextoDelMensaje(message);
        if (!ctx.body || ctx.body === '' || ctx.body.startsWith('_event_')) {
            ctx.body = texto;
        }

        // Enriquecer tipos de eventos
        if (message?.locationMessage) ctx.type = EVENTS.LOCATION;
        if (message?.buttonsResponseMessage || message?.listResponseMessage) ctx.type = EVENTS.ACTION;
    });

    // 8. Crear Bot (Inicializa el servidor Polka interno)
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // 9. CONFIGURACIÓN DEL SERVIDOR WEB (POLKA)
    const app = adapterProvider.server;

    // A. Interceptor de Archivos (DEBE ir antes de body-parser)
    app.use(fileUploadInterceptor);

    // B. Middlewares Globales
    app.use(bodyParser.json());
    app.use(compatibilityMiddleware);
    setupStaticRoutes(app);

    // C. Rutas de Control y Status
    app.get("/api/dashboard-status", (req, res) => {
        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
        const active = fs.existsSync(sessionsDir) && fs.readdirSync(sessionsDir).length > 0;
        res.json({ success: true, active });
    });

    app.get("/api/assistant-name", (req, res) => {
        res.json({ name: process.env.ASSISTANT_NAME || 'Asistente IA' });
    });

    app.get("/api/variables", async (req, res) => {
        const variables = await RailwayApi.getVariables();
        res.json({ success: true, variables: variables || process.env });
    });

    app.post("/api/update-variables", async (req, res) => {
        const result = await RailwayApi.updateVariables(req.body.variables);
        res.json(result);
    });

    app.post("/api/delete-session", async (req, res) => {
        await deleteSessionFromDb();
        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
        if (fs.existsSync(sessionsDir)) fs.rmSync(sessionsDir, { recursive: true, force: true });
        res.json({ success: true });
    });

    app.post("/api/restart-bot", async (req, res) => {
        const result = await RailwayApi.restartActiveDeployment();
        res.json(result);
    });


    // D. Registro de Rutas Backoffice (Modularizado)
    const upload = multer({ dest: 'uploads/' });
    registerBackofficeRoutes(app, {
        adapterProvider,
        HistoryHandler,
        openaiMain: openai,
        upload
    });

    // E. WebChat API (Simplificada usando AiManager)
    app.post('/webchat-api', async (req, res) => {
        try {
            const { message } = req.body;
            if (!message) return res.status(400).json({ error: 'No message provided' });

            const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket.remoteAddress || 'unknown';
            const session = webChatManager.getSession(ip);

            if (message.trim().toLowerCase() === "#reset" || message.trim().toLowerCase() === "#cerrar") {
                session.clear();
                return res.json({ reply: "🔄 El chat ha sido reiniciado." });
            }

            const replyChunks: string[] = [];
            const flowDynamic = async (arr: any) => {
                if (Array.isArray(arr)) arr.forEach(a => { if (a.body) replyChunks.push(a.body); });
                else if (typeof arr === 'string') replyChunks.push(arr);
            };

            const ctx = { from: ip, body: message, type: 'webchat', pushName: 'Web User' };
            await aiManager.processUserMessage(ctx, { 
                flowDynamic, 
                state: session, 
                provider: null, 
                gotoFlow: (flow: any) => { console.log(`[WebChat] Redirección sugerida a flow: ${flow?.name}`); }
            });

            const finalReply = replyChunks.join('\n\n').trim();
            res.json({ reply: finalReply || 'Lo siento, no pude procesar tu solicitud.' });

        } catch (err) {
            console.error('❌ Error WebChat API:', err);
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    // F. Servir Páginas HTML (Auxiliar)
    const serveHtml = (route: string, file: string) => {
        app.get(route, (req, res) => {
            const p = path.join(process.cwd(), 'src', 'html', file);
            if (fs.existsSync(p)) res.sendFile(p);
            else res.status(404).send("Página no encontrada");
        });
    };
    serveHtml("/dashboard", "dashboard.html");
    serveHtml("/backoffice", "backoffice.html");
    serveHtml("/login", "login.html");
    serveHtml("/variables", "variables.html");
    serveHtml("/webchat", "webchat.html");

    // 10. Iniciar Sincronización y Sockets
    startSessionSync();
    const assistantBridge = new AssistantBridge();
    assistantBridge.setupWebChat(app, adapterProvider.server.server, processUserMessage);

    // 11. Escuchar en el puerto configurado
    httpServer(+PORT);
    console.log(`✅ Servidor listo en puerto ${PORT}`);
};

// Error handling y ejecución
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

main();

export {
    welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, 
    welcomeFlowDoc, welcomeFlowVideo, locationFlow
};