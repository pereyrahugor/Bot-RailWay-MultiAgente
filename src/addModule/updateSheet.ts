import fs from "fs";
import { google } from "googleapis";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";
import * as glob from "glob";

dotenv.config();

// Permitir múltiples IDs separados por coma y espacios
const SHEET_IDS = (process.env.SHEET_ID_UPDATE || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID ?? "";
let currentFileId: string | null = null;

// Construir credenciales desde variables de entorno
const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const openai = new OpenAI();

// Función principal para procesar todos los sheets
export async function updateAllSheets() {
    for (const SHEET_ID of SHEET_IDS) {
        await processSheetById(SHEET_ID);
    }
}

// Procesa un sheet por ID, obtiene el nombre real y ejecuta la lógica
async function processSheetById(SHEET_ID: string) {
    try {
        // Obtener metadatos para el nombre real de la hoja principal
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        const sheetTitle = meta.data.sheets?.[0]?.properties?.title || "Sheet1";
        const SHEET_NAME = sheetTitle;
        const TXT_PATH = path.join("temp", `${SHEET_NAME}.json`);

        console.log(`📌 Obteniendo datos de Google Sheets: ${SHEET_ID} (${SHEET_NAME})`);

        // Paso 1: Obtener un rango grande para detectar la última fila y columna con datos
        const initialRange = `${SHEET_NAME}!A1:ZZ10000`;
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: initialRange,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.warn("⚠️ No se encontraron datos en la hoja de cálculo.");
            return [];
        }

        // Calcular última fila y columna con datos reales
        let lastRow = rows.length;
        let lastCol = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.every(cell => (cell === undefined || cell === null || String(cell).trim() === ""))) {
                lastRow = i;
                break;
            }
            if (row.length > lastCol) lastCol = row.length;
        }
        if (lastCol === 0) lastCol = 1;

        // Convertir número de columna a letra
        const colToLetter = (col: number) => {
            let temp = "";
            let n = col;
            while (n > 0) {
                const rem = (n - 1) % 26;
                temp = String.fromCharCode(65 + rem) + temp;
                n = Math.floor((n - 1) / 26);
            }
            return temp;
        };
        const lastColLetter = colToLetter(lastCol);
        const dynamicRange = `${SHEET_NAME}!A1:${lastColLetter}${lastRow}`;

        // Volver a pedir los datos usando el rango exacto
        const fullResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: dynamicRange,
        });
        const fullRows = fullResponse.data.values;
        if (!fullRows || fullRows.length === 0) {
            console.warn("⚠️ No se encontraron datos en el rango calculado.");
            return [];
        }
        // Validar headers
        const headers = fullRows[0].map((h: string) => (h || "").trim());
        const validHeaders = headers.filter(h => h.length > 0);
        if (validHeaders.length === 0) {
            console.warn("⚠️ La primera fila no contiene encabezados válidos.");
            return [];
        }

        // Formatear los datos obtenidos de forma flexible, convirtiendo valores numéricos
        const formattedData = fullRows.slice(1)
            .filter(row => row && row.length > 0 && row.some(cell => (cell || "").trim() !== ""))
            .map((row) => {
                const obj: Record<string, any> = {};
                headers.forEach((header, idx) => {
                    let value = (row[idx] || "").trim();
                    // Si el valor parece un número (con o sin formato de moneda), convertir a number
                    if (/^\$?\s*[\d.,]+$/.test(value)) {
                        value = value.replace(/[^\d,]/g, "");
                        if (value.includes(",")) {
                            value = value.replace(/\./g, "");
                            value = value.replace(/,/, ".");
                        }
                        const num = Number(value);
                        obj[header] = isNaN(num) ? value : num;
                    } else {
                        // Si el valor contiene comas y al menos dos elementos, convertir a array
                        if (typeof value === "string" && value.includes(",")) {
                            const arr = value.split(",").map(v => v.trim()).filter(v => v.length > 0);
                            if (arr.length > 1) {
                                obj[header] = arr;
                            } else {
                                obj[header] = value;
                            }
                        } else {
                            obj[header] = value;
                        }
                    }
                });
                return obj;
            });

        // Verificar que la carpeta "temp" exista
        const dirPath = path.join("temp");
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // Guardar los datos en un archivo de texto en formato JSON simple
        const jsonData = JSON.stringify(formattedData, null, 2);
        fs.writeFileSync(TXT_PATH, jsonData, "utf8");
        console.log(`📂 Datos guardados en archivo de texto: ${TXT_PATH}`);

        // Enviar el archivo de texto al vector store
        const success = await uploadDataToAssistant(TXT_PATH, SHEET_ID);
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
        if (currentFileId && stateId === currentFileId) {
            console.log("📂 Utilizando archivo existente con ID:", currentFileId);
            return true;
        }
        await deleteOldFiles(filePath);
        console.log("🚀 Subiendo archivo al vector store...");
        const fileStream = fs.createReadStream(filePath);
        const response = await openai.files.create({
            file: fileStream,
            purpose: "assistants"
        });
        currentFileId = response.id;
        console.log(`📂 Archivo subido con ID: ${currentFileId}`);
        const success = await attachFileToVectorStore(currentFileId);
        if (!success) {
            return false;
        }
        deleteTemporaryFiles(filePath);
        console.log("✅ Datos actualizados en el vector store.");
        await new Promise(resolve => setTimeout(resolve, 2000));
        return true;
    } catch (error) {
        console.error("❌ Error al subir el archivo al vector store:", error.message);
        return false;
    }
}

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

async function deleteOldFiles(filePath: string) {
    try {
        const fileName = path.basename(filePath);
        console.log(`🗑️ Eliminando archivo anterior del vector store relacionado con ${fileName}...`);
        const files = await openai.files.list();
        for (const file of files.data) {
            if (file.filename === fileName) {
                await openai.files.del(file.id);
                console.log(`🗑️ Archivo eliminado: ${file.id}`);
            }
        }
    } catch (error) {
        console.error("❌ Error al eliminar archivo anterior del vector store:", error.message);
    }
}

function deleteTemporaryFiles(filePath: string) {
    try {
        const fileName = path.basename(filePath);
        console.log("🗑️ Eliminando archivos temporales...");
        const files = glob.sync(path.join("temp", fileName));
        for (const file of files) {
            fs.unlinkSync(file);
            console.log(`🗑️ Archivo temporal eliminado: ${file}`);
        }
    } catch (error) {
        console.error("❌ Error al eliminar archivos temporales:", error.message);
    }
}