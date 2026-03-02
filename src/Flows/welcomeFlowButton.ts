import { addKeyword, EVENTS } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { MemoryDB } from "@builderbot/bot";
import { reset } from "~/utils/timeOut";
import { handleQueue, userQueues, userLocks } from "~/utils/queueManager";

const setTime = Number(process.env.timeOutCierre) * 60 * 1000;

/**
 * welcomeFlowButton
 * Este flujo se activa exclusivamente cuando el proveedor detecta una interacción de botón
 * (mensajes interactivos, botones de lista, botones de plantilla de Meta).
 * El tipo de mensaje es EVENTS.ACTION.
 */
export const welcomeFlowButton = addKeyword<BaileysProvider, MemoryDB>(EVENTS.ACTION)
    .addAction(async (ctx, { gotoFlow, flowDynamic, state, provider }) => {
        const userId = ctx.from;

        // Filtrar contactos ignorados
        if (
            /@broadcast$/.test(userId) ||
            /@newsletter$/.test(userId) ||
            /@channel$/.test(userId) ||
            /@lid$/.test(userId)
        ) {
            console.log(`[FlowButton] Botón ignorado por filtro de contacto: ${userId}`);
            return;
        }

        console.log(`🔘 Interacción de botón detectada de: ${userId}`);
        console.log(`Contenido (body): ${ctx.body}`);

        // Reiniciar el timeout de inactividad
        reset(ctx, gotoFlow, setTime);

        // Inicializar la cola para el usuario si no existe
        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        if (!queue) {
            console.error(`❌ Error: No se pudo acceder a la cola para ${userId}`);
            return;
        }

        console.log("📝 Enviando interacción de botón al asistente...");

        // Agregar mensaje a la cola para procesamiento secuencial
        queue.push({ ctx, flowDynamic, state, provider, gotoFlow });

        // Si no se está procesando nada, iniciar el procesamiento de la cola
        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });
