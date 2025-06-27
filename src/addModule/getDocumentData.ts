import fs from "fs";
import path from "path";
import { google } from "googleapis";
import dotenv from "dotenv";
import OpenAI from "openai";
import * as glob from "glob";

dotenv.config();

const VECTOR_STORE_ID = process.env.VECTOR_STORE ?? "";
const DOCX_FILE_NAME = "archivo1.docx";
const TEMP_DOCX_PATH = path.join("temp", DOCX_FILE_NAME);
const DOCX_FILE_ID = process.env.DOCX_FILE_ID ?? ""; // <-- Agrega esta línea
let currentFileId: string | null = null;

// Autenticación con Google Drive API
const auth = new google.auth.GoogleAuth({
    keyFile: path.join("credentials", "bot-test-v1-450813-c85b778a9c36.json"),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth });
const openai = new OpenAI();

/**
 * Descarga un archivo .docx desde Google Drive usando el fileId del .env
 */
export async function downloadDocxFromDrive(): Promise<string> {
    try {
        if (!DOCX_FILE_ID) throw new Error("No se definió DOCX_FILE_ID en el .env");

        // Verifica que la carpeta temp exista
        if (!fs.existsSync("temp")) {
            fs.mkdirSync("temp", { recursive: true });
        }

        const dest = fs.createWriteStream(TEMP_DOCX_PATH);
        const res = await drive.files.get(
            { fileId: DOCX_FILE_ID, alt: "media" },
            { responseType: "stream" }
        );

        await new Promise((resolve, reject) => {
            res.data
                .on("end", resolve)
                .on("error", reject)
                .pipe(dest);
        });

        console.log(`✅ Archivo descargado: ${TEMP_DOCX_PATH}`);
        return TEMP_DOCX_PATH;
    } catch (error: any) {
        console.error("❌ Error al descargar el archivo .docx:", error.message);
        throw error;
    }
}

/**
 * Sube el archivo .docx al vector store de OpenAI, elimina la versión anterior y limpia el temp
 * @param stateId (Opcional) Un identificador de estado si lo necesitas para tu lógica
 */
export async function uploadDocxToVector(stateId?: string) {
    try {
        // Descarga el archivo desde Google Drive usando el fileId del .env
        const localPath = await downloadDocxFromDrive();

        // Elimina archivos anteriores en OpenAI
        await deleteOldDocxFiles();

        // Sube el archivo a OpenAI
        const fileStream = fs.createReadStream(localPath);
        const response = await openai.files.create({
            file: fileStream,
            purpose: "assistants"
        });

        currentFileId = response.id;
        console.log(`📂 Archivo .docx subido con ID: ${currentFileId}`);

        // Adjunta el archivo al vector store
        const attachSuccess = await attachFileToVectorStore(currentFileId);
        if (!attachSuccess) {
            throw new Error("No se pudo adjuntar el archivo al vector store.");
        }

        // Elimina el archivo temporal
        deleteTemporaryDocx();

        console.log("✅ Archivo .docx actualizado en el vector store.");
        return true;
    } catch (error: any) {
        console.error("❌ Error en el proceso de carga del .docx:", error.message);
        return false;
    }
}

/**
 * Adjunta un archivo al vector store de OpenAI
 */
async function attachFileToVectorStore(fileId: string) {
    try {
        console.log(`📡 Adjuntando archivo al vector store: ${fileId}`);
        const response = await openai.vectorStores.fileBatches.createAndPoll(VECTOR_STORE_ID, {
            file_ids: [fileId]
        });

        if (response && response.status === "completed") {
            console.log("✅ Archivo adjuntado correctamente al vector store.");
            return true;
        } else {
            console.warn("⚠️ No se recibió una confirmación clara de OpenAI.");
            return false;
        }
    } catch (error: any) {
        console.error("❌ Error al adjuntar el archivo al vector store:", error.message);
        return false;
    }
}

/**
 * Elimina archivos .docx anteriores del vector store de OpenAI
 */
async function deleteOldDocxFiles() {
    try {
        console.log("🗑️ Eliminando archivos .docx anteriores del vector store...");
        const files = await openai.files.list();
        for (const file of files.data) {
            if (file.filename === DOCX_FILE_NAME) {
                await openai.files.del(file.id);
                console.log(`🗑️ Archivo eliminado: ${file.id}`);
            }
        }
    } catch (error: any) {
        console.error("❌ Error al eliminar archivos anteriores:", error.message);
    }
}

/**
 * Elimina el archivo .docx temporal
 */
function deleteTemporaryDocx() {
    try {
        console.log("🗑️ Eliminando archivo .docx temporal...");
        const files = glob.sync(path.join("temp", DOCX_FILE_NAME));
        for (const file of files) {
            fs.unlinkSync(file);
            console.log(`🗑️ Archivo temporal eliminado: ${file}`);
        }
    } catch (error: any) {
        console.error("❌ Error al eliminar archivo temporal:", error.message);
    }
}

/**
 * USO:
 * 
 * Llama a esta función pasando el ID del archivo de Google Drive que quieres descargar y subir:
 * 
 * await uploadDocxToVector('AQUI_EL_ID_DEL_ARCHIVO_DE_GOOGLE_DRIVE');
 * 
 * El ID lo obtienes de la URL de Google Drive, por ejemplo:
 * https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/view
 * El ID es: 1A2B3C4D5E6F7G8H9I0J
 */