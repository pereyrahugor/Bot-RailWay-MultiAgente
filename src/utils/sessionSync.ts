import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// Configuración
const SESSION_DIR = 'bot_sessions';
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 Hora

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!;
const projectId = process.env.RAILWAY_PROJECT_ID || 'local-dev';
// Prioridad: ASSISTANT_NAME (del env), luego BOT_NAME, luego default
const botName = process.env.ASSISTANT_NAME || process.env.BOT_NAME || 'Unknown Bot';

// Cliente Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Restaura la sesión desde Supabase.
 * Soporta formato antiguo (archivos individuales) y nuevo (full_backup).
 */
export async function restoreSessionFromDb(sessionId: string = 'default') {
    console.log(`[SessionSync] 📥 Restaurando sesión '${sessionId}' para proyecto '${projectId}'...`);
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }

        const { data, error } = await supabase.rpc('get_whatsapp_session', {
            p_project_id: projectId,
            p_session_id: sessionId
        });

        if (error) {
            console.error('[SessionSync] Error RPC get_whatsapp_session:', error);
            return;
        }

        if (!data || data.length === 0) {
            console.log('[SessionSync] ℹ️ No hay sesión remota para restaurar. Se iniciará una nueva.');
            return;
        }

        let count = 0;

        // Buscar si existe un respaldo unificado
        const backupRow = data.find((r: any) => r.key_id === 'full_backup');

        if (backupRow) {
            console.log('[SessionSync] 📦 Encontrado respaldo unificado (full_backup). Extrayendo archivos...');
            const filesMap = backupRow.data; // { "file.json": content, ... }

            for (const [fileName, fileContent] of Object.entries(filesMap)) {
                 const filePath = path.join(SESSION_DIR, fileName);
                 // Escribir contenido (stringify porque es objeto en memoria)
                 fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2));
                 count++;
            }
        } else {
            console.log('[SessionSync] ℹ️ Usando formato legacy (múltiples filas)...');
            for (const row of data) {
                // Ignorar si por casualidad hay un full_backup que no detectamos (defensive)
                if (row.key_id === 'full_backup') continue;

                const fileName = `${row.key_id}.json`;
                const filePath = path.join(SESSION_DIR, fileName);
                const fileContent = JSON.stringify(row.data, null, 2);
                fs.writeFileSync(filePath, fileContent);
                count++;
            }
        }

        console.log(`[SessionSync] ✅ Restaurados ${count} archivos de sesión exitosamente.`);
    } catch (error) {
        console.error('[SessionSync] ❌ Error restaurando sesión:', error);
    }
}

export async function deleteSessionFromDb(sessionId: string = 'default') {
    console.log(`[SessionSync] 🗑️ Eliminando sesión remota '${sessionId}' para proyecto '${projectId}'...`);
    try {
        const { error } = await supabase.rpc('delete_whatsapp_session', {
            p_project_id: projectId,
            p_session_id: sessionId
        });

        if (error) {
            console.error('[SessionSync] ❌ Error eliminando sesión remota:', error);
        } else {
            console.log('[SessionSync] ✅ Sesión remota eliminada correctamente.');
        }
    } catch (error) {
        console.error('[SessionSync] ❌ Error crítico eliminando sesión remota:', error);
    }
}

/**
 * Inicia la sincronización UNIFICADA.
 * Estrategia: Sincronizar al inicio, a los 2 minutos (para capturar QR reciente), y luego cada 1 hora.
 */
export function startSessionSync(sessionId: string = 'default') {
    console.log(`[SessionSync] 🔄 Iniciando sincronización unificada.`);
    console.log(`[SessionSync] Estrategia: Inicio -> 2 min -> Cada 1 Hora.`);

    // 1. Ejecutar inmediatamente (por si ya hay datos restaurados o generados)
    syncToDb(sessionId).catch(err => console.error('[SessionSync] Error inicio:', err));

    // 2. Ejecutar a los 2 minutos (ventana típica para escanear QR y asegurar persistencia rápida)
    setTimeout(() => {
        console.log('[SessionSync] ⏱️ Checkpoint de 2 minutos ejecutándose...');
        syncToDb(sessionId);
    }, 2 * 60 * 1000);

    // 3. Ciclo perpetuo de 1 hora
    setInterval(async () => {
        await syncToDb(sessionId);
    }, SYNC_INTERVAL_MS);
}

async function syncToDb(sessionId: string) {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;

        const files = fs.readdirSync(SESSION_DIR);
        const sessionFiles = files.filter(f => f.endsWith('.json'));

        if (sessionFiles.length === 0) return;

        const sessionMap: Record<string, any> = {};
        let corruptCount = 0;

        for (const file of sessionFiles) {
            const filePath = path.join(SESSION_DIR, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            let jsonContent;

            try {
                jsonContent = JSON.parse(content);
            } catch (e) {
                // Recuperación de errores de sintaxis (basura al final de archivo)
                try {
                    const lastBrace = content.lastIndexOf('}');
                    if (lastBrace > 0) {
                        const fixedContent = content.substring(0, lastBrace + 1);
                        jsonContent = JSON.parse(fixedContent);
                    } else throw e;
                } catch (e2) {
                     corruptCount++;
                     continue; // Ignorar archivo corrupto
                }
            }

            // Guardar en el mapa: clave="nombre_archivo.json", valor=objeto_contenido
            sessionMap[file] = jsonContent;
        }

        if (Object.keys(sessionMap).length === 0) return;

        // Subir TODO el mapa en una sola transacción/fila
        const { error } = await supabase.rpc('save_whatsapp_session', {
            p_project_id: projectId,
            p_session_id: sessionId,
            p_key_id: 'full_backup', // ID especial para respaldo completo
            p_data: sessionMap,      // Objeto gigante
            p_bot_name: botName
        });

        if (error) {
            console.error(`[SessionSync] Error subiendo respaldo unificado:`, error.message);
        } else {
             // NOTIFICAR solo si creds.json está presente (indicador de salud)
             if (sessionMap['creds.json']) {
                 console.log(`[SessionSync] ✅ Sesión respaldada en DB (Single Record). Nombre: ${botName}`);
             }
        }

    } catch (error) {
        console.error('[SessionSync] Error en ciclo de sincronización:', error);
    }
}
