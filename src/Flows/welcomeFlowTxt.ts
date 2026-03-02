import { addKeyword, EVENTS } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { MemoryDB } from "@builderbot/bot";
import { reset } from "~/utils/timeOut";
import { handleQueue, userQueues, userLocks } from "~/utils/queueManager";
const setTime = Number(process.env.timeOutCierre) * 60 * 1000; // tiempo configurable desde .env

export const welcomeFlowTxt = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { gotoFlow, flowDynamic, state, provider }) => {
        const userId = ctx.from;

        console.log(`📩 Mensaje recibido de :${userId}`);

        reset(ctx, gotoFlow, setTime);

        // Asegurar que userQueues tenga un array inicializado para este usuario
        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);

        if (!queue) {
            console.error(`❌ Error: No se pudo inicializar la cola de mensajes para ${userId}`);
            return;
        }

        console.log("📝 Mensaje de texto recibido");

        queue.push({ ctx, flowDynamic, state, provider, gotoFlow });

        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });
