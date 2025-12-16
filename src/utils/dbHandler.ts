import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { updateAllSheets } from "../addModule/updateSheet";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.warn("⚠️ Supabase credentials missing during dbHandler init.");
}

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

export async function executeDbQuery(sqlQuery: string): Promise<string> {
    if (!supabase) return "Error: Base de datos no configurada.";

    // Sanitización genérica de la query para evitar errores de sintaxis comunes (42601)
    let cleanQuery = sqlQuery
        .replace(/```sql/gi, '') // Quitar inicio de bloque de código
        .replace(/```/g, '')     // Quitar fin de bloque de código
        .trim();

    // Eliminar punto y coma final si existe, ya que algunos RPCs o drivers lo interpretan mal si se duplica
    if (cleanQuery.endsWith(';')) {
        cleanQuery = cleanQuery.slice(0, -1).trim();
    }

    console.log(`📡 Ejecutando Query SQL: ${cleanQuery}`);

    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            const { data, error } = await supabase.rpc('exec_sql_read', { query: cleanQuery });
            console.log(`🔍 [dbHandler] RPC Response (Attempt ${attempts}):`, error ? "Error" : "Success");

            if (error) {
                // Detectar error de tabla faltante (42P01) o columna faltante (42703)
                if ((error.code === '42P01' || error.code === '42703') && attempts === 1) {
                    const isMissingTable = error.code === '42P01';
                    console.warn(`⚠️ ${isMissingTable ? 'Tabla no encontrada' : 'Columna no encontrada'} (Error ${error.code}). Iniciando sincronización automática con Google Sheets...`);

                    try {
                        // Si falta columna (42703), forzamos recreación para actualizar esquema
                        await updateAllSheets({ forceRecreate: !isMissingTable });
                        console.log(`✅ Sincronización completada. Reintentando consulta...`);
                        continue; // Reintentar el loop
                    } catch (syncError: any) {
                        console.error(`❌ Error en sincronización automática:`, syncError);
                        return `Error: ${isMissingTable ? 'Tabla no encontrada' : 'Columna no encontrada'} y falló la sincronización.`;
                    }
                }
                return `Error SQL: ${error.message}`;
            }

            if (!data || data.length === 0) return "No se encontraron resultados.";
            return JSON.stringify(data, null, 2);

        } catch (err: any) {
            console.error(`❌ Error ejecutando query:`, err);
            return `Error ejecutando query: ${err.message}`;
        }
    }

    return "Error desconocido tras reintentos.";
}
