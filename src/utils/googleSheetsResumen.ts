import { google } from "googleapis";
import moment from "moment";
import "dotenv/config";
import fs from "fs";
import path from "path";

// Definir la estructura de los datos que enviaremos
export interface ResumenData {
    nombre: string;
    consulta: string;
    producto: string;
    linkWS: string;
}

// Cargar credenciales desde un archivo JSON
const credentialsPath = path.resolve("./././credentials/bot-test-v1-450813-c85b778a9c36.json"); // Cambia la ruta real
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// ID de la hoja de cálculo desde .env
const SHEET_ID = process.env.SHEET_ID_RESUMEN ?? "";

/**
 * Función para agregar datos a Google Sheets
 * @param {ResumenData} data - Datos del usuario que se enviarán a Sheets
 */
export const addToSheet = async (data: ResumenData): Promise<void> => {
    try {
        const sheets = google.sheets({ version: "v4", auth });

        // Obtener la fecha y hora actual
        const fechaHora: string = moment().format("YYYY-MM-DD HH:mm:ss");

        // Datos a insertar en la hoja de cálculo (según la nueva interface)
        const values = [[
            fechaHora,
            data.nombre,
            data.consulta,
            data.producto,
            data.linkWS
        ]];

        // Insertar en Google Sheets
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: process.env.SHEET_RESUMEN_RANGE ?? "",
            valueInputOption: "RAW",
            requestBody: { values },
        });

        console.log("✅ Datos enviados a Google Sheets con éxito.");
    } catch (error) {
        console.error("❌ Error al enviar datos a Google Sheets:", error);
    }
};
