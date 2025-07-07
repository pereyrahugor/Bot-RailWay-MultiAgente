import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import { idleFlow } from "./Flows/idleFlow";
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
// import { getSheet2 } from "./addModule/getSheet2";
// import { getSheet1 } from "./addModule/getSheet1";
import { ErrorReporter } from "./utils/errorReporter";

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? "";
/** ID del asistente de OpenAI */
//const ASSISTANT_ID = process.env.ASSISTANT_ID;
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? "";

const userQueues = new Map();
const userLocks = new Map();
// Mapa para persistir el asistente asignado a cada usuario
const userAssignedAssistant = new Map();

const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: false,
    readStatus: false,
});

const errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN); // Reemplaza YOUR_GROUP_ID con el ID del grupo de WhatsApp

const TIMEOUT_MS = 30000;

// Control de timeout por usuario para evitar ejecuciones automáticas superpuestas
const userTimeouts = new Map();

const getAssistantResponse = async (assistantId, message, state, fallbackMessage, userId) => {
  // Si hay un timeout previo, lo limpiamos
  if (userTimeouts.has(userId)) {
    clearTimeout(userTimeouts.get(userId));
    userTimeouts.delete(userId);
  }

  let timeoutResolve;
  const timeoutPromise = new Promise((resolve) => {
    timeoutResolve = resolve;
    const timeoutId = setTimeout(() => {
      console.warn("⏱ Timeout alcanzado. Reintentando con mensaje de control...");
      resolve(toAsk(assistantId, fallbackMessage ?? message, state));
      userTimeouts.delete(userId);
    }, TIMEOUT_MS);
    userTimeouts.set(userId, timeoutId);
  });

  // Lanzamos la petición a OpenAI
  const askPromise = toAsk(assistantId, message, state).then((result) => {
    // Si responde antes del timeout, limpiamos el timeout
    if (userTimeouts.has(userId)) {
      clearTimeout(userTimeouts.get(userId));
      userTimeouts.delete(userId);
    }
    // Resolvemos el timeout para evitar que quede pendiente
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
const ASSISTANT_MAP = {
    asistente1: ASSISTANT_1,
    asistente2: ASSISTANT_2,
    asistente3: ASSISTANT_3,
    asistente4: ASSISTANT_4, // opcional
    asistente5: ASSISTANT_5, // opcional
    cliente: null // para asesor humano
};

/**
 * Analiza la respuesta del recepcionista para determinar el destino.
 * Devuelve: 'asistente1', 'asistente2', 'asistente3', 'cliente', 'ambiguous' o null
 */
function analizarDestinoRecepcionista(respuesta) {
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
function extraerResumenRecepcionista(respuesta) {
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
        let assigned = userAssignedAssistant.get(ctx.from) || 'asistente1';
        let response, destino, resumen;

        // 1. Enviar mensaje al asistente asignado
        response = await getAssistantResponse(
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
        destino = analizarDestinoRecepcionista(response);
        resumen = extraerResumenRecepcionista(response);
        console.log(`[DERIVACION] Respuesta ${assigned}:`, response);
        console.log(`[DERIVACION] Destino detectado:`, destino);
        // Limpiar la respuesta para el usuario
        let respuestaSinResumen = String(response)
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
        } else if (destino === 'cliente') {
            userAssignedAssistant.set(ctx.from, 'cliente');
            if (respuestaSinResumen) {
                await flowDynamic([{ body: respuestaSinResumen }]);
            }
            // Aquí podrías cerrar el hilo si lo deseas
            return;
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
    // // Paso 1: Inicializar datos desde Google Sheets
    // console.log("📌 Inicializando datos desde Google Sheets...");

    // // Paso 2: Cargar datos de ventas desde la hoja de cálculo
    // const sheetVentas = await getSheet2();
    // if (!sheetVentas || sheetVentas.length === 0) {
    //     console.warn("⚠️ No se encontraron datos en la hoja de cálculo de ventas. Continuando sin datos de ventas...");
    // } else {
    //     console.log("✅ Datos de ventas cargados en memoria.");
    // }

    // // Paso 3: Cargar datos de alquiler desde la hoja de cálculo
    // const sheetAlquiler = await getSheet1();
    // if (!sheetAlquiler || sheetAlquiler.length === 0) {
    //     console.warn("⚠️ No se encontraron datos en la hoja de cálculo de alquiler. Continuando sin datos de alquiler...");
    // } else {
    //     console.log("✅ Datos de alquiler cargados en memoria.");
    // }

    // Paso 4: Crear el flujo principal del bot
    const adapterFlow = createFlow([welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, idleFlow]);
    // Paso 5: Crear el proveedor de WhatsApp (Baileys)
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: false,
        readStatus: false,
    });
    // Paso 6: Crear la base de datos en memoria
    const adapterDB = new MemoryDB();
    // Paso 7: Inicializar el bot con los flujos, proveedor y base de datos
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Paso 8: Inyectar el servidor HTTP para el proveedor
    httpInject(adapterProvider.server);
    // Paso 9: Iniciar el servidor HTTP en el puerto especificado
    httpServer(+PORT);
};

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

export { welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg,
    handleQueue, userQueues, userLocks,
 };

main();

//ok