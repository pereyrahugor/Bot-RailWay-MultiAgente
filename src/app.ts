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
const ASSISTANT_1 = process.env.ASSISTANT_1; // Asistente 1 (personaliza según uso)
const ASSISTANT_2 = process.env.ASSISTANT_2; // Asistente 2 (personaliza según uso)
const ASSISTANT_3 = process.env.ASSISTANT_3; // Asistente 3 (personaliza según uso)
const ASSISTANT_4 = process.env.ASSISTANT_4; // Asistente 4 (personaliza según uso)
const ASSISTANT_5 = process.env.ASSISTANT_5; // Asistente 5 (personaliza según uso)

// Mapeo lógico para derivación
const ASSISTANT_MAP = {
    asistente1: ASSISTANT_1,
    asistente2: ASSISTANT_2,
    asistente3: ASSISTANT_3,
    asistente4: ASSISTANT_4,
    asistente5: ASSISTANT_5,
    cliente: null // para asesor humano
};

/**
 * Analiza la respuesta del recepcionista para determinar el destino.
 * Devuelve: 'asistente1', 'asistente2', 'asistente3', 'asistente4', 'asistente5', 'cliente', 'ambiguous' o null
 * Mejora: ahora soporta asistentes dinámicos según ASSISTANT_MAP
 */
function analizarDestinoRecepcionista(respuesta) {
    const lower = respuesta.toLowerCase();
    // Log para depuración
    console.log(`[ANALIZAR DESTINO] Analizando respuesta:`, lower);
    // Buscar coincidencia dinámica con los asistentes definidos
    for (const key of Object.keys(ASSISTANT_MAP)) {
        if (key !== 'cliente' && lower.includes(key)) {
            console.log(`[ANALIZAR DESTINO] Destino detectado dinámicamente:`, key);
            return key;
        }
    }
    if (lower.includes('asesor humano')) {
        console.log(`[ANALIZAR DESTINO] Destino: cliente (asesor humano)`);
        return 'cliente';
    }
    if (lower.includes('derivar')) {
        console.log(`[ANALIZAR DESTINO] Destino ambiguo detectado`);
        return 'ambiguous';
    }
    console.log(`[ANALIZAR DESTINO] No se detectó destino claro.`);
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
        // if (ctx.body === "#ACTUALIZAR#") {

        //     console.log("📌 BaseProductos Actualizado...");
        //     await getSheet2();
        //     console.log("📌 Ventas Actualizado...");
        //     await getSheet1();
        //     console.log("📌 Alquiler Actualizado...");
        // }

        // 1. Enviar mensaje al recepcionista (asistente1)
        const recepcionistaResponse = await getAssistantResponse(
            ASSISTANT_1,
            ctx.body,
            state,
            "Por favor, responde aunque sea brevemente.",
            ctx.from
        );
        if (!recepcionistaResponse) {
            await errorReporter.reportError(
                new Error("No se recibió respuesta del recepcionista."),
                ctx.from,
                `https://wa.me/${ctx.from}`
            );
            return;
        }
        const destino = analizarDestinoRecepcionista(recepcionistaResponse);
        const resumen = extraerResumenRecepcionista(recepcionistaResponse);
        console.log(`[DERIVACION] Respuesta recepcionista:`, recepcionistaResponse);
        console.log(`[DERIVACION] Destino detectado:`, destino);
        // Limpiar la respuesta del recepcionista para el usuario
        let respuestaSinResumen = String(recepcionistaResponse).replace(/GET_RESUMEN[\s\S]+/i, '').trim();
        respuestaSinResumen = respuestaSinResumen
            .replace(/\[Enviando.*$/gim, '')
            .replace(/^[ \t]*\n/gm, '')
            .trim();
        // 2. Solo enviar la última respuesta limpia del recepcionista al usuario si el destino es 'cliente'
        if (destino === 'cliente') {
            console.log(`[DERIVACION] Derivando a asesor humano.`);
            if (respuestaSinResumen) {
                await flowDynamic([{ body: respuestaSinResumen }]);
            }
            // Cerrar el hilo sin enviar saludo final (no gotoFlow de bienvenida)
            return;
        }
        // 2b. Si no es cliente, enviar la respuesta limpia del recepcionista normalmente
        if (respuestaSinResumen) {
            await flowDynamic([{ body: respuestaSinResumen }]);
        }
        // 3. Derivación automática si es claro y no es cliente
        if (destino && ASSISTANT_MAP[destino]) {
            console.log(`[DERIVACION] Derivando a ${destino}.`);
            const respuestaDestino = await getAssistantResponse(
                ASSISTANT_MAP[destino],
                resumen,
                state,
                "Por favor, responde aunque sea brevemente.",
                ctx.from
            );
            console.log(`[DERIVACION] Respuesta del asistente derivado (${destino}):`, respuestaDestino);
            await flowDynamic([{ body: String(respuestaDestino).trim() }]);
            return state;
        } else if (destino === 'ambiguous' || !destino) {
            console.log(`[DERIVACION] Destino ambiguo o no detectado. El recepcionista continúa la conversación.`);
            // No enviar mensajes adicionales, dejar que el recepcionista continúe la conversación
            return state;
        }
    } catch (error) {
        console.error("Error al procesar el mensaje del usuario:", error);

        // Enviar reporte de error al grupo de WhatsApp
        await errorReporter.reportError(
            error,
            ctx.from,
            `https://wa.me/${ctx.from}`
        );

        // 📌 Manejo de error: volver al flujo adecuado
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