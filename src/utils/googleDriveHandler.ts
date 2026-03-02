import { google } from "googleapis";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { finished } from "stream/promises";

// Construir credenciales desde variables de entorno
const credentials = {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.file"
    ],
});

const drive = google.drive({ version: "v3", auth });

/**
 * Descarga un archivo desde Google Drive dado su ID.
 * @param fileId ID del archivo en Google Drive.
 * @returns Path local del archivo descargado.
 */
export const downloadFileFromDrive = async (fileId: string): Promise<string> => {
    try {
        // Asegurar que existe el directorio temporal
        const tempDir = path.join(process.cwd(), "temp", "drive");
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Obtener metadatos del archivo para saber el nombre original
        const fileMetadata = await drive.files.get({
            fileId: fileId,
            fields: "name, mimeType",
        });

        const fileName = fileMetadata.data.name || `${fileId}.pdf`;
        const filePath = path.join(tempDir, fileName);

        console.log(`[Drive] Iniciando descarga de archivo ID: ${fileId} (${fileName})...`);

        // Descargar el contenido del archivo
        const res = await drive.files.get(
            { fileId: fileId, alt: "media" },
            { responseType: "stream" }
        );

        const dest = fs.createWriteStream(filePath);
        // @ts-ignore
        res.data.pipe(dest);
        
        await finished(dest);

        console.log(`✅ [Drive] Archivo descargado con éxito: ${filePath}`);
        return filePath;
    } catch (error: any) {
        console.error("❌ [Drive] Error al descargar de Google Drive:", error.message);
        throw error;
    }
};
