import { historyEvents } from '../utils/HistoryHandler';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
// Eliminado: processUserMessageWeb. Usar lógica principal para ambos canales.
import fs from 'fs';
export interface Message {
  id: string;
  text: string;
  timestamp: number;
  from: 'frontend' | 'assistant';
}

export class AssistantBridge {
  private messageQueue: Message[] = [];
  private io: Server | null = null;

  constructor() {}

  // Inicializa el webchat en el servidor principal
  public setupWebChat(app: any, server: http.Server, processUserMessage: Function) {
    // Servir el archivo webchat.html en /webchat (Polka no tiene sendFile)

    this.io = new Server(server, {
      cors: { origin: "*" }
    });

    // Suscribirse a eventos globales de historial para notificar en tiempo real
    historyEvents.on('new_message', (data) => {
      this.io?.emit('new_message', data);
    });

    historyEvents.on('bot_toggled', (data) => {
      this.io?.emit('bot_toggled', data);
    });

    historyEvents.on('tag_created', (data) => {
      this.io?.emit('tag_created', data);
    });

    historyEvents.on('tag_deleted', (data) => {
      this.io?.emit('tag_deleted', data);
    });

    historyEvents.on('chat_tag_added', (data) => {
      this.io?.emit('chat_tag_added', data);
    });

    historyEvents.on('chat_tag_removed', (data) => {
      this.io?.emit('chat_tag_removed', data);
    });

    this.io.on('connection', (socket) => {
      console.log('💬 Cliente web conectado');

      socket.on('message', async (msg: string) => {
        try {
          console.log(`📩 Mensaje web: ${msg}`);
          // Usar lógica principal del bot para webchat
          // Centralizar historial y estado igual que WhatsApp
          const ip = socket.handshake.address || '';
          if (!(global as any).webchatHistories) (global as any).webchatHistories = {};
          const historyKey = `webchat_${ip}`;
          if (!(global as any).webchatHistories[historyKey]) (global as any).webchatHistories[historyKey] = { history: [], thread_id: null };
          const _store = (global as any).webchatHistories[historyKey];
          const _history = _store.history;
          
          // Crear un wrapper de estado compatible con AiManager
          const state = {
            get: function (key: string) {
              if (key === 'history') return _history;
              if (key === 'thread_id') return _store.thread_id;
              return undefined;
            },
            setThreadId: function (id: string) {
              _store.thread_id = id;
            },
            update: async function (key: string, value: any) {
              if (key === 'thread_id') _store.thread_id = value;
            },
            clear: async function () { 
              _history.length = 0; 
              _store.thread_id = null; 
            }
          };

          const provider = undefined;
          const gotoFlow = (flow: any) => { console.log(`[Webchat] GotoFlow suggested: ${flow?.name}`); };
          let replyText = '';
          const flowDynamic = async (arr: any) => {
            if (Array.isArray(arr)) {
              replyText = arr.map(a => a.body).join('\n');
            } else if (typeof arr === 'string') {
              replyText = arr;
            }
          };

          if (msg.trim().toLowerCase() === "#reset" || msg.trim().toLowerCase() === "#cerrar") {
            await state.clear();
            replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
          } else {
            const ctx: { from: string; body: string; type: string; thread_id: any; lastThreadId?: string } = { 
              from: ip, 
              body: msg, 
              type: 'webchat', 
              thread_id: state.get('thread_id') 
            };
            
            // Llamar a la función procesadora inyectada
            await processUserMessage(ctx, { flowDynamic, state, provider, gotoFlow });
            
            if (ctx.lastThreadId) {
              state.setThreadId(ctx.lastThreadId);
            }
          }
          socket.emit('reply', replyText);
          this.saveMessage(msg, 'frontend');
          this.saveMessage(replyText, 'assistant');
        } catch (err) {
          console.error("❌ Error procesando mensaje:", err);
          socket.emit('reply', "Hubo un error procesando tu mensaje.");
        }
      });

      socket.on('disconnect', () => {
        console.log('👋 Cliente web desconectado');
      });
    });
  }

  // Guarda mensajes en la cola interna
  public saveMessage(text: string, from: 'frontend' | 'assistant') {
    const msg: Message = {
      id: this.generateId(),
      text,
      timestamp: Date.now(),
      from,
    };
    this.messageQueue.push(msg);
  }

  // Acceso a historial de mensajes
  public getMessages(): Message[] {
    return this.messageQueue;
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }
}