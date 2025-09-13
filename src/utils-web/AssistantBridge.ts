
import express from 'express';
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
  public setupWebChat(app: any, server: http.Server) {
    // Servir el archivo webchat.html en /webchat (Polka no tiene sendFile)

    app.get('/webchat', (req, res) => {
      const filePath = path.join(process.cwd(), 'src', 'webchat.html');
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(filePath));
    });

    this.io = new Server(server, {
      cors: { origin: "*" }
    });

    this.io.on('connection', (socket) => {
      console.log('💬 Cliente web conectado');

      socket.on('message', async (msg: string) => {
        try {
          console.log(`📩 Mensaje web: ${msg}`);
          // Usar lógica principal del bot para webchat
          // Centralizar historial y estado igual que WhatsApp
          const ip = socket.handshake.address || '';
          if (!global.webchatHistories) global.webchatHistories = {};
          const historyKey = `webchat_${ip}`;
          if (!global.webchatHistories[historyKey]) global.webchatHistories[historyKey] = { history: [], thread_id: null };
          const _store = global.webchatHistories[historyKey];
          const _history = _store.history;
          const state = {
            get: function (key) {
              if (key === 'history') return _history;
              if (key === 'thread_id') return _store.thread_id;
              return undefined;
            },
            setThreadId: function (id) {
              _store.thread_id = id;
            },
            update: async function (msg, role = 'user') {
              if (_history.length > 0) {
                const last = _history[_history.length - 1];
                if (last.role === role && last.content === msg) return;
              }
              _history.push({ role, content: msg });
              if (_history.length >= 6) {
                const last3 = _history.slice(-3);
                if (last3.every(h => h.role === 'user' && h.content === msg)) {
                  _history.length = 0;
                  _store.thread_id = null;
                }
              }
            },
            clear: async function () { _history.length = 0; _store.thread_id = null; }
          };
          const provider = undefined;
          const gotoFlow = () => {};
          let replyText = '';
          const flowDynamic = async (arr) => {
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
            const appModule = await import('../app');
            await appModule.processUserMessage(ctx, { flowDynamic, state, provider, gotoFlow });
            if (ctx.lastThreadId) {
              state.setThreadId(ctx.lastThreadId);
            }
          }
          socket.emit('reply', replyText);
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