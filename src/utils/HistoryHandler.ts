import { EventEmitter } from "events";
import { supabase } from './dbHandler';

// Emitter para notificar cambios en tiempo real a otros módulos (como el de WebSockets)
export const historyEvents = new EventEmitter();

// Identificador único para este bot específico
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || "default_project";

export interface Chat {
    id: string;
    project_id: string;
    type: 'whatsapp' | 'webchat';
    name: string | null;
    bot_enabled: boolean;
    last_message_at: string;
    last_human_message_at?: string | null;
    metadata: any;
}

export interface Message {
    id?: string;
    chat_id: string;
    project_id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    type: 'text' | 'image' | 'audio' | 'video' | 'location' | 'document';
    created_at?: string;
}

export class HistoryHandler {

    /**
     * Inicializa las tablas necesarias en Supabase si no existen (vía RPC exec_sql)
     */
    static async initDatabase() {
        if (!supabase) return;

        console.log('🔍 [HistoryHandler] Verificando tablas de historial...');

        const tables = [
            {
                name: 'chats',
                sql: `CREATE TABLE IF NOT EXISTS chats (
                    id TEXT,
                    project_id TEXT,
                    type TEXT NOT NULL,
                    name TEXT,
                    bot_enabled BOOLEAN DEFAULT true,
                    last_message_at TIMESTAMPTZ DEFAULT NOW(),
                    last_human_message_at TIMESTAMPTZ,
                    metadata JSONB DEFAULT '{}'::jsonb,
                    PRIMARY KEY (id, project_id)
                );`
            },
            {
                name: 'tags',
                sql: `CREATE TABLE IF NOT EXISTS tags (
                    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                    project_id TEXT,
                    name TEXT NOT NULL,
                    color TEXT DEFAULT '#000000',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );`
            },
            {
                name: 'chat_tags',
                sql: `CREATE TABLE IF NOT EXISTS chat_tags (
                    chat_id TEXT,
                    tag_id uuid REFERENCES tags(id) ON DELETE CASCADE,
                    project_id TEXT,
                    PRIMARY KEY (chat_id, tag_id, project_id),
                    FOREIGN KEY (chat_id, project_id) REFERENCES chats(id, project_id)
                );`
            },
            {
                name: 'messages',
                sql: `CREATE TABLE IF NOT EXISTS messages (
                    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                    chat_id TEXT,
                    project_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    type TEXT DEFAULT 'text',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    FOREIGN KEY (chat_id, project_id) REFERENCES chats(id, project_id)
                );`
            }
        ];

        for (const table of tables) {
            try {
                // Verificar si la tabla existe
                const { error: checkError } = await supabase.from(table.name).select('*').limit(1);
                
                if (checkError && (checkError.code === '42P01' || checkError.code === 'PGRST204' || checkError.code === 'PGRST205')) {
                    console.log(`⚠️ Tabla '${table.name}' no encontrada. Intentando crearla vía RPC exec_sql...`);
                    const { error: rpcError } = await supabase.rpc('exec_sql', { query: table.sql });
                    
                    if (rpcError) {
                        console.error(`❌ Error al crear tabla '${table.name}':`, rpcError.message);
                        if (rpcError.message.includes('function') && rpcError.message.includes('does not exist')) {
                            console.error(`💡 TIP: Debes crear la función 'exec_sql' en el SQL Editor de Supabase.`);
                        }
                    } else {
                        console.log(`✅ Tabla '${table.name}' creada exitosamente.`);
                    }
                } else {
                    // Migración rápida para last_human_message_at si falta
                    if (table.name === 'chats') {
                        const { error: colErr } = await supabase.from('chats').select('last_human_message_at').limit(1);
                        if (colErr && colErr.code === '42703') {
                            await supabase.rpc('exec_sql', { query: `ALTER TABLE chats ADD COLUMN last_human_message_at TIMESTAMPTZ;` });
                        }
                    }
                    console.log(`✅ Tabla '${table.name}' verificada.`);
                }
            } catch (fatalErr) {
                console.error(`❌ Error verificando tabla '${table.name}':`, fatalErr);
            }
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

            // Actualizar timestamp del último mensaje en el chat
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
            const updateData: any = { bot_enabled: enabled };
            if (enabled === false) {
                updateData.last_human_message_at = new Date().toISOString();
            }

            const { error } = await supabase
                .from('chats')
                .update(updateData)
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID);
            
            if (error) throw error;
            
            // Emitir evento para WebSockets
            historyEvents.emit('bot_toggled', { chatId, bot_enabled: enabled });

            return { success: true };
        } catch (err: any) {
            console.error('[HistoryHandler] Error en toggleBot:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Lista todos los chats activos con paginación y tags
     */
    static async listChats(limit: number = 20, offset: number = 0) {
        if (!supabase) return [];
        try {
            const { data, error } = await supabase
                .from('chats')
                .select('*, chat_tags(tag_id, tags(*))')
                .eq('project_id', PROJECT_ID)
                .order('last_message_at', { ascending: false })
                .range(offset, offset + limit - 1);
            
            if (error) throw error;

            return (data || []).map(chat => ({
                ...chat,
                tags: chat.chat_tags ? (chat.chat_tags as any[]).map(ct => ct.tags).filter(t => t !== null) : []
            }));
        } catch (err) {
            console.error('[HistoryHandler] Error en listChats:', err);
            return [];
        }
    }

    /**
     * Obtiene los últimos mensajes de un chat específico con paginación
     */
    static async getMessages(chatId: string, limit: number = 50, offset: number = 0) {
        if (!supabase) return [];
        try {
            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .eq('chat_id', chatId)
                .eq('project_id', PROJECT_ID)
                .order('created_at', { ascending: false })
                .range(offset, offset + limit - 1);
            
            if (error) throw error;
            return (data || []).reverse(); 
        } catch (err) {
            console.error('[HistoryHandler] Error en getMessages:', err);
            return [];
        }
    }

    // --- Tag Management ---

    static async getTags() {
        if (!supabase) return [];
        try {
            const { data, error } = await supabase
                .from('tags')
                .select('*')
                .eq('project_id', PROJECT_ID)
                .order('name');
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('[HistoryHandler] Error en getTags:', err);
            return [];
        }
    }

    static async createTag(name: string, color: string) {
        if (!supabase) return { success: false, error: 'No db' };
        try {
            const { data, error } = await supabase
                .from('tags')
                .insert({ name, color, project_id: PROJECT_ID })
                .select()
                .single();
            if (error) throw error;
            historyEvents.emit('tag_created', data);
            return { success: true, tag: data };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    static async deleteTag(id: string) {
        if (!supabase) return { success: false };
        try {
            const { error } = await supabase
                .from('tags')
                .delete()
                .eq('id', id)
                .eq('project_id', PROJECT_ID);
            if (error) throw error;
            historyEvents.emit('tag_deleted', { id });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    static async addTagToChat(chatId: string, tagId: string) {
        if (!supabase) return { success: false };
        try {
            const { error } = await supabase
                .from('chat_tags')
                .insert({ chat_id: chatId, tag_id: tagId, project_id: PROJECT_ID });
            if (error) throw error;
            historyEvents.emit('chat_tag_added', { chatId, tagId });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    static async removeTagFromChat(chatId: string, tagId: string) {
        if (!supabase) return { success: false };
        try {
            const { error } = await supabase
                .from('chat_tags')
                .delete()
                .eq('chat_id', chatId)
                .eq('tag_id', tagId)
                .eq('project_id', PROJECT_ID);
            if (error) throw error;
            historyEvents.emit('chat_tag_removed', { chatId, tagId });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    static async saveThreadId(chatId: string, threadId: string) {
        if (!supabase) return;
        try {
            const { data } = await supabase
                .from('chats')
                .select('metadata')
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID)
                .maybeSingle();

            const currentMetadata = data?.metadata || {};
            const updatedMetadata = { ...currentMetadata, thread_id: threadId };

            await supabase
                .from('chats')
                .update({ metadata: updatedMetadata })
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID);
        } catch (err) {
            console.error('[HistoryHandler] Error en saveThreadId:', err);
        }
    }

    static async getThreadId(chatId: string): Promise<string | null> {
        if (!supabase) return null;
        try {
            const { data } = await supabase
                .from('chats')
                .select('metadata')
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID)
                .maybeSingle();

            return data?.metadata?.thread_id || null;
        } catch (err) {
            console.error('[HistoryHandler] Error en getThreadId:', err);
            return null;
        }
    }
}

// Inicializar base de datos al cargar el modulo
HistoryHandler.initDatabase();
