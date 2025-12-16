// Custom Provider for Supabase Persistence
import { BaileysProvider } from 'builderbot-provider-sherpa';
import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { useSupabaseAuthState } from '../utils/supabaseAdapter';
import { EventEmitter } from 'events';
import pino from 'pino';

const logger = pino({ level: 'error' });

export class SupabaseBaileysProvider extends BaileysProvider {
    saveCreds: any = null;
    clearSession: any = null;
    private initialized = false;

    constructor(args: any = {}) {
        super(args);
        this.initProvider();
    }

    protected async initProvider() {
        if (this.initialized) return;
        this.initialized = true;

        console.log('[SupabaseBaileysProvider] 🚀 Iniciando Provider...');
        
        const projectId = process.env.RAILWAY_PROJECT_ID || 'local-dev';
        const botName = process.env.BOT_NAME || 'Unknown Bot';

        const { state, saveCreds, clearSession } = await useSupabaseAuthState(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_KEY!,
            projectId,
            'default',
            botName
        );
        
        this.saveCreds = saveCreds;
        this.clearSession = clearSession;

        this.vendor = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger as any),
            },
            logger: logger as any,
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            ...this.globalVendorArgs
        }) as any;

        // Listeners esenciales
        this.vendor.ev.on('creds.update', () => {
            console.log('[SupabaseBaileysProvider] 🔄 creds.update event received');
            this.saveCreds();
        });

        this.vendor.ev.on('connection.update', async (update: any) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.emit('require_action', {
                    title: 'Escanea el código QR',
                    instructions: ['Escanea el QR para vincular el bot.'],
                    payload: { qr },
                });
            }

            if (connection === 'open') {
                this.emit('ready', true);
                console.log(`[SupabaseBaileysProvider] ✅ Bot conectado.`);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('[SupabaseBaileysProvider] 🔄 Reconectando...');
                    this.initialized = false; // Allow re-initialization
                    this.initProvider();
                } else {
                    console.log('[SupabaseBaileysProvider] ❌ Desconectado (Logout).');
                    if (this.clearSession) await this.clearSession();
                    this.emit('auth_failure', { instructions: ['Sesión cerrada.'] });
                    this.initialized = false; // Allow re-initialization
                    this.initProvider(); 
                }
            }
        });

        // Manejo de mensajes entrantes
        this.vendor.ev.on('messages.upsert', async ({ messages, type }: any) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                if (!msg.message) continue;
                
                const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                const from = msg.key.remoteJid;
                
                this.emit('message', {
                    body,
                    from,
                    name: msg.pushName || 'User',
                    type: Object.keys(msg.message)[0],
                    payload: msg 
                });
            }
        });
    }
}
