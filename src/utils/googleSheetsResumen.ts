import { google } from "googleapis";
import moment from "moment";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { GenericResumenData } from "./extractJsonData";


// Construir credenciales desde variables de entorno
const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;

const credentials = {
    client_email: clientEmail,
    private_key: privateKey,
};

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// ID de la hoja de cálculo desde .env
const SHEET_ID = process.env.SHEET_ID_RESUMEN ?? "";

/**
 * Función para agregar datos genéricos a Google Sheets
 * @param {GenericResumenData} data - Datos dinámicos que se enviarán a Sheets
 */
export const addToSheet = async (data: GenericResumenData): Promise<void> => {
    try {
        const sheets = google.sheets({ version: "v4", auth });

        // Obtener la fecha y hora actual
        const fechaHora: string = moment().format("YYYY-MM-DD HH:mm:ss");

        // Siempre poner fecha en A y linkWS en B, el resto en el orden recibido (sin duplicar linkWS)
        const linkWS = data.linkWS || '';
        // Excluir linkWS de los datos extra
        const keys = Object.keys(data).filter(key => key !== 'linkWS');
        const values = [[fechaHora, linkWS, ...keys.map(key => data[key])]];
        // Insertar en Google Sheets

        // Usar un rango por defecto si no está definido en el entorno
        const range = process.env.SHEET_RESUMEN_RANGE && process.env.SHEET_RESUMEN_RANGE.trim() !== ""
            ? process.env.SHEET_RESUMEN_RANGE
            : "Hoja1!A1";

        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range,
            valueInputOption: "RAW",
            requestBody: { values },
        });

        console.log("✅ Datos enviados a Google Sheets con éxito.");
    } catch (error) {
        console.error("❌ Error al enviar datos a Google Sheets:", error);
    }
};
