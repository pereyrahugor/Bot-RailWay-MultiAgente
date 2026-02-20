import { addKeyword, EVENTS } from "@builderbot/bot";
import { ErrorReporter } from "../utils/errorReporter";

import { welcomeFlowTxt } from "./welcomeFlowTxt";
import { welcomeFlowVideo } from "./welcomeFlowVideo";
import { OpenAI } from "openai";
import { reset } from "../utils/timeOut";
import { handleQueue, userQueues, userLocks } from "../app";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_IMG });
const setTime = Number(process.env.timeOutCierre) * 60 * 1000;

const welcomeFlowImg = addKeyword(EVENTS.MEDIA).addAction(
  async (ctx, { flowDynamic, provider, gotoFlow, state }) => {
    const userId = ctx.from;

    // Verificar si es una imagen (y no un video)
    const mimetype = ctx?.media?.mimetype || ctx?.message?.imageMessage?.mimetype || "";
    if (mimetype.includes('video')) {
        return gotoFlow(welcomeFlowVideo);
    }

    // Filtrar contactos ignorados antes de agregar a la cola
    if (
      /@broadcast$/.test(userId) ||
      /@newsletter$/.test(userId) ||
      /@channel$/.test(userId) ||
      /@lid$/.test(userId)
    ) {
      console.log(`Mensaje de imagen ignorado por filtro de contacto: ${userId}`);
      return;
    }

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

    // Procesar la imagen y responder directamente al usuario
    const fs = await import('fs');
    try {
      if (!provider) {
        await flowDynamic("No se encontró el provider para descargar la imagen.");
        return;
      }
      
      // Asegurar que la carpeta temp exista
      if (!fs.default.existsSync("./temp/")) {
        fs.default.mkdirSync("./temp/", { recursive: true });
      }
      
      // Usar ./temp/ en lugar de ./tmp/ para consistencia
      const localPath = await provider.saveFile(ctx, { path: "./temp/" });
      if (!localPath) {
        await flowDynamic("No se pudo guardar la imagen recibida.");
        return;
      }

      // Eliminar imagen anterior si existe para no acumular archivos
      const oldImage = state.get('lastImage');
      if (oldImage && typeof oldImage === 'string' && fs.default.existsSync(oldImage)) {
        try {
          fs.default.unlinkSync(oldImage);
          console.log(`🗑️ Imagen anterior eliminada: ${oldImage}`);
        } catch (e) {
          console.error(`❌ Error eliminando imagen anterior: ${oldImage}`, e);
        }
      }

      await state.update({ lastImage: localPath });
      const buffer = fs.default.readFileSync(localPath);
      
      console.log("Analizando imagen con GPT-4o...");
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe esta imagen detalladamente para que el asistente pueda entender su contenido y responder al usuario." },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` },
              },
            ],
          },
        ],
      });

      const result = response.choices[0].message.content || "No se pudo obtener una descripción de la imagen.";

      // Enviar el mensaje al asistente principal para que lo procese y mantenga el contexto
      ctx.body = `[Imagen recibida]: ${result}`;

      // Reencolar el mensaje para que lo procese el flujo principal (texto)
      if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
      }
      userQueues.get(userId).push({ ctx, flowDynamic, state, provider, gotoFlow });
      
      if (!userLocks.get(userId) && userQueues.get(userId).length === 1) {
        await handleQueue(userId);
      }
      
      console.log(`💾 Imagen guardada para resumen: ${localPath}`);
    } catch (err) {
      console.error("Error procesando imagen:", err);
      await flowDynamic("Ocurrió un error al analizar la imagen. Intenta más tarde.");
    }
  }
);

export { welcomeFlowImg };
