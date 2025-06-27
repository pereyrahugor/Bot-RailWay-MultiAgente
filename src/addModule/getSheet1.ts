import fs from "fs";
import { google } from "googleapis";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";
import * as glob from "glob";

dotenv.config();

// Variables de entorno para la hoja de cálculo y el vector store
const SHEET_ID = process.env.SHEET_ID_ALQUILER ?? "";
const SHEET_RANGE = process.env.SHEET_ALQUILER_RANGE ?? "";
const VECTOR_STORE_ID = process.env.VECTOR_STORE ?? "";
const TXT_PATH = path.join("temp", "base1.json");
let currentFileId: string | null = null;

// Verificar que las variables de entorno estén definidas
if (!SHEET_ID || !SHEET_RANGE) {
    throw new Error("❌ Las variables de entorno SHEET_ID_ALQUILERA y SHEET_ALQUILER_RANGE deben estar definidas.");
}

// Autenticación con Google Sheets API
const auth = new google.auth.GoogleAuth({
    keyFile: path.join("credentials", "bot-test-v1-450813-c85b778a9c36.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });
const openai = new OpenAI();

// Función para obtener datos de Google Sheets
export async function getSheet1() {
    try {
        console.log("📌 Obteniendo datos de Google Sheets...");

        // Obtener los datos de la hoja de cálculo
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: SHEET_RANGE,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.warn("⚠️ No se encontraron datos en la hoja de cálculo.");
            return [];
        }

        // Formatear los datos obtenidos
        const formattedData = rows.slice(1).map((row) => ({
            ID: (row[0] || "").trim(),
            CODIGO: row[1] || "",
            NOMBRE: row[2] || "",
            TIPO_DE_PRODUCTO: row[3] || "",
            DESCRIPCION: row[4] || "",
            CARACTERISTICAS_TECNICAS: row[5] || "",
            LINK: (row[6] || "").trim(),
            STOCK: row[7] || "",
        }));

        console.log("✅ Datos obtenidos.");

        // Verificar que la carpeta "temp/data" exista
        const dirPath = path.join("temp");
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`📂 Carpeta creada: ${dirPath}`);
        }

        // Guardar los datos en un archivo de texto en formato JSON simple
        const jsonData = JSON.stringify(formattedData, null, 2);
        fs.writeFileSync(TXT_PATH, jsonData, "utf8");

        console.log(`📂 Datos guardados en archivo de texto: ${TXT_PATH}`);

        // Enviar el archivo de texto al vector store
        const success = await uploadDataToAssistant(TXT_PATH, "newStateId");
        if (!success) {
            console.error("❌ Error al enviar los datos al vector store.");
        }

        return formattedData;
    } catch (error) {
        console.error("❌ Error al obtener datos:", error.message);
        return null;
    }
}

// Función para subir datos al vector store de OpenAI
export async function uploadDataToAssistant(filePath: string, stateId: string) {
    try {
        // Verificar si el archivo actual está en uso
        if (currentFileId && stateId === currentFileId) {
            console.log("📂 Utilizando archivo existente con ID:", currentFileId);
            return true;
        }

        // Eliminar archivos anteriores
        await deleteOldFiles();

        console.log("🚀 Subiendo archivo al vector store...");

        // Subir el archivo al vector store
        const fileStream = fs.createReadStream(filePath);
        const response = await openai.files.create({
            file: fileStream,
            purpose: "assistants"
        });

        currentFileId = response.id;
        console.log(`📂 Archivo subido con ID: ${currentFileId}`);

        // Adjuntar el nuevo archivo al vector store
        const success = await attachFileToVectorStore(currentFileId);
        if (!success) {
            return false;
        }

        // Eliminar archivos temporales
        deleteTemporaryFiles();

        console.log("✅ Datos actualizados en el vector store.");

        // Agregar un delay antes de continuar
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 segundos de delay

        return true;
    } catch (error) {
        console.error("❌ Error al subir el archivo al vector store:", error.message);
        return false;
    }
}

// Función para adjuntar un archivo al vector store de OpenAI
async function attachFileToVectorStore(fileId: string) {
    try {
        console.log(`📡 Adjuntando archivo al vector store: ${fileId}`);
        const response = await openai.vectorStores.fileBatches.createAndPoll(VECTOR_STORE_ID, {
            file_ids: [fileId]
        });

        if (response && response.status === "completed") {
            console.log("✅ Confirmación recibida: Archivo adjuntado correctamente al vector store.");
            return true;
        } else {
            console.warn("⚠️ No se recibió una confirmación clara de OpenAI.");
            return false;
        }
    } catch (error) {
        console.error("❌ Error al adjuntar el archivo al vector store:", error.message);
        return false;
    }
}

// Función para eliminar archivos anteriores del vector store
async function deleteOldFiles() {
    try {
        console.log("🗑️ Eliminando archivo anterior del vector store relacionado con base1.json...");

        const files = await openai.files.list();
        for (const file of files.data) {
            if (file.filename === "base1.json") {
                await openai.files.del(file.id);
                console.log(`🗑️ Archivo eliminado: ${file.id}`);
            }
        }
    } catch (error) {
        console.error("❌ Error al eliminar archivo anterior del vector store:", error.message);
    }
}

// Función para eliminar archivos temporales
function deleteTemporaryFiles() {
    try {
        console.log("🗑️ Eliminando archivos temporales...");

        const files = glob.sync(path.join("temp", "base1.json"));
        for (const file of files) {
            fs.unlinkSync(file);
            console.log(`🗑️ Archivo temporal eliminado: ${file}`);
        }
    } catch (error) {
        console.error("❌ Error al eliminar archivos temporales:", error.message);
    }
}