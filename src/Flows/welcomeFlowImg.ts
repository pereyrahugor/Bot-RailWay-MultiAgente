// import { addKeyword, EVENTS } from "@builderbot/bot";
// import { ErrorReporter } from "../utils/errorReporter";

// const welcomeFlowImg = addKeyword(EVENTS.MEDIA).addAnswer(
//   "Por un problema no puedo ver imágenes, me podrás escribir de que trata la imagen? Gracias ",
//   { capture: false },
//   async (ctx) => {
//     if (!ctx?.media?.buffer || ctx.media.buffer.length === 0) {
//       console.error("No se recibió buffer de imagen válido.");
//       return;
//     }
//     console.log("Imagen recibida:", ctx);
//     await new ErrorReporter(ctx.provider, ctx.groupId);
//   }
// );

// export { welcomeFlowImg };

import { addKeyword, EVENTS } from "@builderbot/bot";
import { ErrorReporter } from "../utils/errorReporter";

import { welcomeFlowTxt } from "./welcomeFlowTxt";
import axios from "axios";
import { OpenAI } from "openai";
import { reset } from "../utils/timeOut";
import { handleQueue, userQueues, userLocks, userAssignedAssistant, ASSISTANT_MAP } from "../app";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_IMG });
const IMGUR_CLIENT_ID = "dbe415c6bbb950d";
const setTime = 7 * 60 * 1000; // 7 minutos


const welcomeFlowImg = addKeyword(EVENTS.MEDIA).addAction(
  async (ctx, { flowDynamic, provider, gotoFlow, state }) => {
    const userId = ctx.from;
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
      const localPath = await provider.saveFile(ctx, { path: "./tmp/" });
      if (!localPath) {
        await flowDynamic("No se pudo guardar la imagen recibida.");
        return;
      }
      await state.update({ lastImage: localPath });
      const buffer = fs.default.readFileSync(localPath);
      const imgurRes = await axios.post(
        "https://api.imgur.com/3/image",
        {
          image: buffer.toString("base64"),
          type: "base64",
        },
        {
          headers: {
            Authorization: `Client-ID ${IMGUR_CLIENT_ID}`,
          },
        }
      );
      const imgUrl = imgurRes.data.data.link;
      const assistantId = process.env.ASSISTANT_ID_IMG;
      if (!assistantId) {
        await flowDynamic("No se encontró el ASSISTANT_ID_IMG en las variables de entorno.");
        return;
      }
      const thread = await openai.beta.threads.create({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imgUrl } },
            ],
          },
        ],
      });
      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });
      let runStatus;
      do {
        await new Promise((res) => setTimeout(res, 2000));
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      } while (runStatus.status !== "completed" && runStatus.status !== "failed");
      if (runStatus.status === "failed") {
        await flowDynamic("El asistente falló al procesar la imagen.");
        return;
      }
      const messages = await openai.beta.threads.messages.list(thread.id);
      const resultMsg = messages.data.find((msg) => msg.role === "assistant");
      let result = "No se obtuvo respuesta del asistente.";
      if (resultMsg && Array.isArray(resultMsg.content)) {
        const textBlock = resultMsg.content.find(
          (block): block is { type: "text"; text: { value: string; annotations: any[] } } =>
            block.type === "text" &&
            typeof (block as any).text?.value === "string" &&
            Array.isArray((block as any).text?.annotations)
        );
        if (
          textBlock &&
          typeof textBlock.text?.value === "string" &&
          Array.isArray(textBlock.text?.annotations)
        ) {
          result = textBlock.text.value;
        }
      }
      // Enviar el mensaje al asistente principal para que lo procese y mantenga el contexto
      const assigned = userAssignedAssistant.get(userId) || 'asistente1';
      ctx.body = `Se recibió una imagen con la siguiente información: ${result}`;
      // Reencolar el mensaje para que lo procese el asistente actualmente asignado
      userQueues.get(userId).push({ ctx, flowDynamic, state, provider, gotoFlow, assigned });
      if (!userLocks.get(userId) && userQueues.get(userId).length === 1) {
        await handleQueue(userId);
      }
      fs.default.unlink(localPath, (err) => {
        if (err) {
          console.error(`❌ Error al eliminar el archivo: ${localPath}`, err);
        } else {
          console.log(`🗑️ Archivo eliminado: ${localPath}`);
        }
      });
    } catch (err) {
      console.error("Error procesando imagen:", err);
      await flowDynamic("Ocurrió un error al analizar la imagen. Intenta más tarde.");
    }
  }
);

export { welcomeFlowImg };