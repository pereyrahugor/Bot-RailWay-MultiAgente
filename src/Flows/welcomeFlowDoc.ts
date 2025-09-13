import { addKeyword, EVENTS } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { MemoryDB } from "@builderbot/bot";
import { reset } from "~/utils/timeOut";
import { handleQueue, userQueues, userLocks } from "~/app";
import { processImageWithVision } from "../utils/processImageWithVision";
import fs from 'fs';
import path from 'path';


import { execSync } from 'child_process';



// Función para convertir PDF a imágenes PNG usando pdftoppm (Poppler)
function extraerPaginasComoPNG(pdfPath, outputDir) {
    // Genera imágenes page-1.png, page-2.png, ... en outputDir
    const outPrefix = path.join(outputDir, 'page');
    execSync(`pdftoppm -png "${pdfPath}" "${outPrefix}"`);
    // Buscar los archivos generados
    const files = fs.readdirSync(outputDir)
        .filter(f => f.startsWith('page-') && f.endsWith('.png'))
        .map(f => path.join(outputDir, f));
    return files;
}

const setTime = Number(process.env.timeOutCierre) * 60 * 1000;

export const welcomeFlowDoc = addKeyword<BaileysProvider, MemoryDB>(EVENTS.DOCUMENT)
    .addAction(async (ctx, { flowDynamic, provider }) => {
        let localPath = null;
        let outputDir = null;
        const imagenesGeneradas = [];
        try {
            let tipo = "desconocido";
            const mimetype = ctx?.media?.mimetype || ctx?.message?.documentMessage?.mimetype;
            if (mimetype === "application/pdf") tipo = "pdf";
            else tipo = mimetype || "desconocido";

            if (tipo !== "pdf") {
                await flowDynamic("Solo se aceptan archivos PDF en este flujo.");
                return;
            }

            // Guardar el PDF en tmp
            localPath = await provider.saveFile(ctx, { path: "./tmp/" });
            if (!localPath) {
                await flowDynamic("No se pudo guardar el PDF recibido.");
                return;
            }

            // Convertir cada página del PDF a imagen (png) usando pdftoppm (Poppler)
            outputDir = path.join("./tmp", `pdf_${Date.now()}`);
            fs.mkdirSync(outputDir, { recursive: true });
            let imagenes = [];
            try {
                imagenes = extraerPaginasComoPNG(localPath, outputDir);
            } catch (e) {
                console.error("Error extrayendo páginas como PNG:", e);
                await flowDynamic("Error al convertir el PDF a imágenes. Asegúrate de que el PDF no esté protegido y que Poppler esté instalado.");
            }
            if (imagenes.length === 0) {
                await flowDynamic("No se pudo convertir el PDF a imágenes.");
                return;
            }
            for (const imgPath of imagenes) {
                const imgBuffer = fs.readFileSync(imgPath);
                // Procesar la imagen con la lógica de Vision+OpenAI+Imgur
                await processImageWithVision(imgBuffer, flowDynamic);
            }
            imagenesGeneradas.push(...imagenes);
        } catch (err) {
            console.error("Error procesando PDF:", err);
            await flowDynamic("Ocurrió un error al procesar el PDF.");
        } finally {
            // Limpiar archivos temporales SIEMPRE
            if (imagenesGeneradas.length > 0) {
                for (const imgPath of imagenesGeneradas) {
                    try { fs.unlinkSync(imgPath); } catch (e) { /* Ignorar error al borrar imagen temporal */ }
                }
            }
            if (outputDir && fs.existsSync(outputDir)) {
                try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (e) { /* Ignorar error al borrar carpeta temporal */ }
            }
            if (localPath && fs.existsSync(localPath)) {
                try { fs.unlinkSync(localPath); } catch (e) { /* Ignorar error al borrar PDF temporal */ }
            }
        }
    });