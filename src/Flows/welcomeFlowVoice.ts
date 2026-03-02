import { addKeyword, EVENTS } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { MemoryDB } from "@builderbot/bot";
import { reset } from "~/utils/timeOut";
import { handleQueue, userQueues, userLocks } from "~/utils/queueManager";
import { transcribeAudioFile } from "~/utils/audioTranscriptior";
import path from "path";
import fs from "fs";

const setTime = Number(process.env.timeOutCierre) * 60 * 1000; // tiempo configurable desde .env

export const welcomeFlowVoice = addKeyword<BaileysProvider, MemoryDB>(EVENTS.VOICE_NOTE)
    .addAction(async (ctx, { gotoFlow, flowDynamic, state, provider }) => {
        const userId = ctx.from;
        
        console.log(`🎙️ Mensaje de voz recibido de ${userId}`);

        reset(ctx, gotoFlow, setTime);

        // Asegurar que userQueues tenga un array inicializado para este usuario
    if (!userQueues.has(userId)) {
        userQueues.set(userId, []);
      }

        // 📌 Definir ruta donde se guardarán los audios
        const audioFolder = path.join("./temp/voiceNote/");

        // 📌 Crear la carpeta si no existe
        if (!fs.existsSync(audioFolder)) {
            fs.mkdirSync(audioFolder, { recursive: true });
            console.log("📂 Carpeta 'temp/voiceNote' creada.");
        }

        // Guardar el archivo de audio localmente
        const localPath = await provider.saveFile(ctx, { path: "./temp/voiceNote/" });
        console.log(`📂 Ruta del archivo de audio: ${localPath}`);

        // Transcribir el audio antes de procesarlo
        const transcription = await transcribeAudioFile(`${localPath}`);

        if (!transcription) {
            await flowDynamic("⚠️ No pude transcribir el audio. Inténtalo de nuevo.");
            return;
        }

        console.log(`📝 Transcripción: ${transcription}`);
        ctx.body = transcription;

        // Enviar la transcripción al asistente
        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider, gotoFlow });

        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }

        // Eliminar el archivo temporal
        fs.unlink(localPath, (err) => {
            if (err) {
                console.error(`❌ Error al eliminar el archivo: ${localPath}`, err);
            } else {
                console.log(`🗑️ Archivo eliminado: ${localPath}`);
            }
        });
    });
