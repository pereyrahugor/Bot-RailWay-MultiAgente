import axios from "axios";
import { OpenAI } from "openai";
import fs from "fs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY_IMG });
const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID;

export async function processImageWithVision(buffer: Buffer, flowDynamic: any): Promise<string> {
  // Subir imagen a Imgur
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
    return "";
  }

  // Crear un thread solo con la imagen
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

  // Ejecutar el asistente sobre el thread
  const run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: assistantId,
  });

  // Esperar a que termine el procesamiento
  let runStatus;
  do {
    await new Promise((res) => setTimeout(res, 2000));
    runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
  } while (runStatus.status !== "completed" && runStatus.status !== "failed");

  if (runStatus.status === "failed") {
    await flowDynamic("El asistente falló al procesar la imagen.");
    return "";
  }

  // Obtener el mensaje de respuesta
  const messages = await openai.beta.threads.messages.list(thread.id);
  const resultMsg = messages.data.find((msg) => msg.role === "assistant");
  let result = "No se obtuvo respuesta del asistente.";
  if (resultMsg && Array.isArray(resultMsg.content)) {
    const textBlock = resultMsg.content.find(
      (block: any) => block.type === "text" && typeof (block as any).text?.value === "string"
    );
    if (textBlock && (textBlock as any).text && typeof (textBlock as any).text.value === "string") {
      result = (textBlock as any).text.value;
    }
  }
  await flowDynamic(result);
  return result;
}