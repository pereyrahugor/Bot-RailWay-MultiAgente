import { addKeyword, EVENTS } from "@builderbot/bot";
import { reset } from "../utils/timeOut";
import { handleQueue, userQueues, userLocks } from "../utils/queueManager";
import * as fs from 'fs';

const setTime = Number(process.env.timeOutCierre) * 60 * 1000;

const welcomeFlowVideo = addKeyword(EVENTS.MEDIA).addAction(
  async (ctx, { flowDynamic, provider, gotoFlow, state }) => {
    const userId = ctx.from;

    // Verificar si es un video
    const mimetype = ctx?.media?.mimetype || ctx?.message?.videoMessage?.mimetype || "";
    if (!mimetype.includes('video')) {
        return; // No es un video, ignorar y dejar que otro flujo lo maneje si es posible
    }

    // Filtrar contactos ignorados
    if (
      /@broadcast$/.test(userId) ||
      /@newsletter$/.test(userId) ||
      /@channel$/.test(userId) ||
      /@lid$/.test(userId)
    ) {
      console.log(`Mensaje de video ignorado por filtro de contacto: ${userId}`);
      return;
    }

    reset(ctx, gotoFlow, setTime);

    // Asegurar que userQueues tenga un array inicializado para este usuario
    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
    }

    try {
      if (!provider) {
        await flowDynamic("No se encontró el provider para descargar el video.");
        return;
      }
      
      // Asegurar que la carpeta temp exista
      if (!fs.existsSync("./temp/")) {
        fs.mkdirSync("./temp/", { recursive: true });
      }
      
      const localPath = await provider.saveFile(ctx, { path: "./temp/" });
      if (!localPath) {
        await flowDynamic("No se pudo guardar el video recibido.");
        return;
      }

      // Eliminar video anterior si existe
      const oldVideo = state.get('lastVideo');
      if (oldVideo && typeof oldVideo === 'string' && fs.existsSync(oldVideo)) {
        try {
          fs.unlinkSync(oldVideo);
          console.log(`🗑️ Video anterior eliminado: ${oldVideo}`);
        } catch (e) {
          console.error(`❌ Error eliminando video anterior: ${oldVideo}`, e);
        }
      }

      await state.update({ lastVideo: localPath });

      // Informar al asistente principal
      ctx.body = `Se recibió un video. (El usuario envió un video que ha sido guardado)`;
      
      if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
      }
      userQueues.get(userId).push({ ctx, flowDynamic, state, provider, gotoFlow });
      if (!userLocks.get(userId) && userQueues.get(userId).length === 1) {
        await handleQueue(userId);
      }
      
      console.log(`💾 Video guardado: ${localPath}`);
    } catch (err) {
      console.error("Error procesando video:", err);
      await flowDynamic("Ocurrió un error al procesar el video. Intenta más tarde.");
    }
  }
);

export { welcomeFlowVideo };
