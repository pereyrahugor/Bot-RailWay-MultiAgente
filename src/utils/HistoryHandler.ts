import { EventEmitter } from "events";
import { supabase } from './dbHandler';

// Emitter para notificar cambios en tiempo real a otros módulos (como el de WebSockets)
export const historyEvents = new EventEmitter();

// Identificador único para este bot específico
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || "default_project";

export interface Chat {
    id: string;
    project_id: string; // Nuevo campo para multitenancy
    type: 'whatsapp' | 'webchat';
    name: string | null;
    bot_enabled: boolean;
    last_message_at: string;
    metadata: any;
}

export interface Message {
    id?: string;
    chat_id: string;
    project_id: string; // También lo añadimos a mensajes para facilitar limpiezas o auditorias
    role: 'user' | 'assistant' | 'system';
    content: string;
    type: 'text' | 'image' | 'audio' | 'video' | 'location' | 'document';
    created_at?: string;
}

export class HistoryHandler {

    static async initDatabase() {
        if (!supabase) return;

        console.log('🔍 [HistoryHandler] Verificando tablas de historial...');

        // Nota: En un entorno real, preferiríamos usar migraciones controladas.
        // Aquí intentamos verificar/crear para facilitar la implementación inicial.
        
        try {
            // Verificar si la tabla existe
            const { error: checkError } = await supabase.from('chats').select('project_id').limit(1);
            
            if (checkError && (checkError.code === '42P01' || checkError.code === 'PGRST204' || checkError.code === 'PGRST205')) {
                console.warn(`⚠️ Tablas de historial no encontradas o sin project_id. Se recomienda crearlas vía SQL Editor.`);
                // No intentamos rpc('exec_sql') aquí por seguridad, el usuario debe configurarlo.
            } else {
                console.log(`✅ Tablas de historial verificadas.`);
            }
        } catch (fatalErr) {
            console.error(`❌ Error verificando base de datos:`, fatalErr);
        }
    }
    
    /**
     * Obtiene o crea un registro de chat con reintentos para evitar fallos de red/timeout
     */
    static async getOrCreateChat(chatId: string, type: 'whatsapp' | 'webchat', name: string | null = null): Promise<Chat | null> {
        if (!supabase) return null;
        
        let attempts = 0;
        const maxAttempts = 2;

        while (attempts < maxAttempts) {
            attempts++;
            try {
                const { data, error } = await supabase
                    .from('chats')
                    .select('*')
                    .eq('id', chatId)
                    .eq('project_id', PROJECT_ID)
                    .maybeSingle();

                if (error) throw error;

                if (!data) {
                    const { data: newData, error: insertError } = await supabase
                        .from('chats')
                        .insert({
                            id: chatId,
                            project_id: PROJECT_ID,
                            type,
                            name: name || null,
                            bot_enabled: true,
                            last_message_at: new Date().toISOString()
                        })
                        .select()
                        .single();
                    
                    if (insertError) throw insertError;
                    return newData;
                }

                // Actualizar nombre si es null y ahora tenemos uno
                if (name && !data.name) {
                    await supabase.from('chats').update({ name }).eq('id', chatId).eq('project_id', PROJECT_ID);
                }

                return data;
            } catch (err: any) {
                const isNetworkError = err.message?.includes('fetch failed') || err.name === 'ConnectTimeoutError';
                if (isNetworkError && attempts < maxAttempts) {
                    console.warn(`[HistoryHandler] Reintentando getOrCreateChat (${attempts}/${maxAttempts}) por error de red...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    continue;
                }
                console.error('[HistoryHandler] Error en getOrCreateChat:', err);
                return null;
            }
        }
        return null;
    }

    /**
     * Guarda un mensaje en la base de datos
     */
    static async saveMessage(chatId: string, role: 'user' | 'assistant' | 'system', content: string, type: string = 'text', contactName: string | null = null) {
        if (!supabase) return;
        try {
            // Asegurar que el chat existe
            const chat = await this.getOrCreateChat(chatId, (chatId.includes('@') || chatId.length > 20) ? 'whatsapp' : 'webchat', contactName);
            
            if (!chat) {
                console.error(`[HistoryHandler] No se pudo guardar el mensaje porque el chat ${chatId} no existe ni pudo ser creado.`);
                return;
            }

            const { error } = await supabase
                .from('messages')
                .insert({
                    chat_id: chatId,
                    project_id: PROJECT_ID,
                    role,
                    content,
                    type,
                    created_at: new Date().toISOString()
                });

            if (error) throw error;

            // Actualizar timestamp del último mensaje en el chat (sin esperar para no ralentizar el flujo principal)
            supabase
                .from('chats')
                .update({ last_message_at: new Date().toISOString() })
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID)
                .then(({ error: updateErr }) => {
                    if (updateErr) console.warn('[HistoryHandler] No se pudo actualizar last_message_at:', updateErr.message);
                });

            // Emitir evento para WebSockets
            historyEvents.emit('new_message', { chatId, role, content, type });

        } catch (err) {
            console.error('[HistoryHandler] Error en saveMessage:', err);
        }
    }

    /**
     * Verifica si el bot está habilitado para un usuario
     */
    static async isBotEnabled(chatId: string): Promise<boolean> {
        if (!supabase) return true;
        try {
            const { data, error } = await supabase
                .from('chats')
                .select('bot_enabled')
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID)
                .maybeSingle();

            if (error) throw error;
            return data ? data.bot_enabled : true;
        } catch (err) {
            console.error('[HistoryHandler] Error en isBotEnabled:', err);
            return true;
        }
    }

    /**
     * Cambia el estado del bot (Intervención humana)
     */
    static async toggleBot(chatId: string, enabled: boolean) {
        if (!supabase) return { success: false, error: 'Supabase no configurado' };
        try {
            const { error } = await supabase
                .from('chats')
                .update({ bot_enabled: enabled })
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID);
            
            if (error) throw error;
            
            // Emitir evento para WebSockets
            historyEvents.emit('bot_toggled', { chatId, bot_enabled: enabled });

            return { success: true };
        } catch (err) {
            console.error('[HistoryHandler] Error en toggleBot:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Lista todos los chats activos
     */
    static async listChats() {
        if (!supabase) return [];
        try {
            const { data, error } = await supabase
                .from('chats')
                .select('*')
                .eq('project_id', PROJECT_ID)
                .order('last_message_at', { ascending: false });
            
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('[HistoryHandler] Error en listChats:', err);
            return [];
        }
    }

    /**
     * Obtiene los últimos mensajes de un chat específico
     */
    static async getMessages(chatId: string, limit: number = 50) {
        if (!supabase) return [];
        try {
            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .eq('chat_id', chatId)
                .eq('project_id', PROJECT_ID)
                .order('created_at', { ascending: false }) // Primero los más nuevos para el LIMIT
                .limit(limit);
            
            if (error) throw error;
            return (data || []).reverse(); // Revertir para orden cronológico
        } catch (err) {
            console.error('[HistoryHandler] Error en getMessages:', err);
            return [];
        }
    }
}

// Inicializar base de datos al cargar el modulo
HistoryHandler.initDatabase();
