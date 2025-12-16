// Supabase Adapter for Baileys Session Persistence
import { createClient } from '@supabase/supabase-js';
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

export const useSupabaseAuthState = async (
    supabaseUrl: string, 
    supabaseKey: string,
    projectId: string, 
    sessionId: string = 'default',
    botName: string | null = null
): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void>, clearSession: () => Promise<void> }> => {

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Helper para escribir en DB
    const writeData = async (data: any, key: string) => {
        console.log(`[SupabaseAdapter] 💾 Attempting to save data for key: ${key}`);
        try {
            if (data === null || data === undefined) {
                console.log(`[SupabaseAdapter] ⚠️ Data is null/undefined for key: ${key}`);
                return; 
            }
            const { error } = await supabase.rpc('save_whatsapp_session', {
                p_project_id: projectId,
                p_session_id: sessionId,
                p_key_id: key,
                p_data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
                p_bot_name: botName
            });
            if (error) {
                console.error(`[SupabaseAdapter] ❌ RPC Error for ${key}:`, error);
                throw error;
            }
            console.log(`[SupabaseAdapter] ✅ Data saved successfully for key: ${key}`);
        } catch (error) {
            console.error('[SupabaseAdapter] ❌ Error saving data:', key, error);
        }
    };

    // Helper para leer de DB
    const readData = async (key: string) => {
        try {
            const { data, error } = await supabase.rpc('get_whatsapp_session', {
                p_project_id: projectId,
                p_session_id: sessionId
            });
            if (error) throw error;
            if (!data || !Array.isArray(data)) return null;
            const row = data.find((r: any) => r.key_id === key);
            return row ? JSON.parse(JSON.stringify(row.data), BufferJSON.reviver) : null;
        } catch (error) {
            console.error('[SupabaseAdapter] Error reading data:', key, error);
            return null; 
        }
    };

    const clearSession = async () => {
         try {
            const { error } = await supabase.rpc('delete_whatsapp_session', {
                p_project_id: projectId,
                p_session_id: sessionId
            });
            if (error) throw error;
            console.log(`[SupabaseAdapter] Session cleared.`);
        } catch (error) {
            console.error('[SupabaseAdapter] Error clearing session:', error);
        }
    };

    // Cargar credenciales iniciales o crear nuevas
    const creds: AuthenticationCreds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};
                    try {
                        const { data: allRows, error } = await supabase.rpc('get_whatsapp_session', {
                            p_project_id: projectId,
                            p_session_id: sessionId
                        });
                        if (error) throw error;
                        
                        const memoryMap = new Map();
                        if (allRows && Array.isArray(allRows)) {
                             allRows.forEach((r: any) => {
                                 memoryMap.set(r.key_id, JSON.parse(JSON.stringify(r.data), BufferJSON.reviver));
                             });
                        }
                        ids.forEach((id) => {
                            const key = `${type}-${id}`;
                            const val = memoryMap.get(key);
                            if (val) data[id] = val;
                        });
                    } catch(e) { console.error('[SupabaseAdapter] Error in keys.get:', e); }
                    return data;
                },
                set: async (data) => {
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(writeData(value, key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        },
        clearSession
    };
};
