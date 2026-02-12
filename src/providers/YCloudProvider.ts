import { ProviderClass } from '@builderbot/bot';
import axios from 'axios';

class YCloudProvider extends ProviderClass {
    globalVendorArgs: any;

    constructor(args: any = {}) {
        super();
        this.globalVendorArgs = args;
    }

    protected initProvider() {
        console.log('[YCloudProvider] Listo. Esperando Webhooks...');
    }

    public async initVendor() {
        this.vendor = {};
        setTimeout(() => {
            this.emit('ready', true);
        }, 100);
        return this.vendor;
    }

    public beforeHttpServerInit() {
    }

    public afterHttpServerInit() {
    }

    public busEvents = () => {
        return [];
    };

    public async saveFile(ctx: any, options: { path: string }) {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const media = ctx.media || ctx.payload?.image || ctx.payload?.video || ctx.payload?.document;
            
            if (!media) return null;

            const fileUrl = media.link || media.url;
            
            // Si no hay URL directa pero hay ID (formato Meta), habría que usar la API de Meta para descargar.
            // Por simplicidad y asumiendo que YCloud entrega links o que manejamos el ID como link en algunos casos:
            if (!fileUrl && media.id) {
                // Si es YCloud, podemos intentar obtener el link si no venía
                console.log(`[YCloudProvider] Media ID detectado: ${media.id}. Intentando descargar...`);
                // Aquí se podría implementar la lógica de descarga vía API de YCloud/Meta
                // Por ahora, si no hay URL, no podemos descargar fácilmente sin más config.
                return null;
            }

            if (!fileUrl) return null;

            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const fileName = `${Date.now()}-${media.id || 'file'}${path.extname(fileUrl) || '.jpg'}`;
            const fullPath = path.join(options.path, fileName);
            
            fs.writeFileSync(fullPath, response.data);
            return fullPath;
        } catch (e) {
            console.error('[YCloudProvider] Error en saveFile:', e);
            return null;
        }
    }

    /**
     * Manda mensajes a través de la API de YCloud
     */
    public async sendMessage(number: string, message: string, options: any = {}): Promise<any> {
        const apiKey = process.env.YCLOUD_API_KEY;
        const fromNumber = process.env.YCLOUD_WABA_NUMBER;

        if (!apiKey) {
            console.error('[YCloudProvider] Error: YCLOUD_API_KEY no definida.');
            return;
        }

        if (!fromNumber) {
            console.error('[YCloudProvider] Error: YCLOUD_WABA_NUMBER no definida.');
            return;
        }

        const url = 'https://api.ycloud.com/v2/whatsapp/messages';
        const cleanNumber = number.replace(/\D/g, '');

        const body: any = {
            from: fromNumber.replace(/\D/g, ''),
            to: cleanNumber,
            type: 'text',
            text: { body: message }
        };

        // Soporte para envío de imágenes si se requiere
        if (options.media) {
            body.type = 'image';
            body.image = { url: options.media };
            delete body.text;
            if (message) {
                body.image.caption = message;
            }
        }

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'X-API-Key': apiKey,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`📤 [YCloudProvider] Mensaje enviado a ${cleanNumber}`);
            return response.data;
        } catch (error: any) {
            console.error('[YCloudProvider] ❌ Error enviando mensaje:', JSON.stringify(error?.response?.data || error.message, null, 2));
            return Promise.resolve(null);
        }
    }

    /**
     * Webhook entrante
     */
    public handleWebhook = (req: any, res: any) => {
        try {
            const body = req.body;
            
            if (!res.headersSent) {
                res.statusCode = 200;
                res.end('OK');
            }

            if (!body) return;

            setImmediate(() => {
                this.processIncomingMessage(body);
            });
        } catch (e) {
            console.error('[YCloudProvider] Error en handleWebhook:', e);
        }
    }

    private processIncomingMessage = (body: any) => {
        try {
            const wabaNumberEnv = process.env.YCLOUD_WABA_NUMBER;

            // 1. Formato Nativo de YCloud
            if (body.type === 'whatsapp.inbound_message.received' && body.whatsappInboundMessage) {
                const msg = body.whatsappInboundMessage;

                if (wabaNumberEnv) {
                    const incomingDestNumber = (msg.to || '').replace(/\D/g, '');
                    const myWabaNumber = wabaNumberEnv.replace(/\D/g, '');
                    if (incomingDestNumber && incomingDestNumber !== myWabaNumber) return;
                }

                const formatedMessage: any = {
                    body: msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || msg.button?.text || '',
                    from: msg.wa_id || msg.from.replace('+', ''),
                    phoneNumber: msg.from.replace('+', ''),
                    name: msg.customerProfile?.name || 'User',
                    type: msg.type,
                    payload: msg
                };

                // Si es imagen, adjuntamos la info de media
                if (msg.type === 'image' && msg.image) {
                    formatedMessage.body = '_event_media_';
                    formatedMessage.media = msg.image;
                }

                this.emit('message', formatedMessage);
            }
            // 2. Formato Meta
            else if (body.object === 'whatsapp_business_account' || body.entry) {
                body.entry?.forEach((entry: any) => {
                    entry.changes?.forEach((change: any) => {
                        const value = change.value;
                        if (value?.messages) {
                            if (wabaNumberEnv && value.metadata) {
                                const incomingDestNumber = value.metadata.display_phone_number?.replace(/\D/g, '');
                                const myWabaNumber = wabaNumberEnv.replace(/\D/g, '');
                                if (incomingDestNumber !== myWabaNumber && value.metadata.phone_number_id !== myWabaNumber) return;
                            }

                            const contact = value.contacts?.[0];
                            const wa_id = contact?.wa_id;

                            value.messages.forEach((msg: any) => {
                                const formatedMessage: any = {
                                    body: msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || msg.button?.text || '',
                                    from: wa_id || msg.from.replace('+', ''),
                                    phoneNumber: msg.from.replace('+', ''),
                                    name: contact?.profile?.name || 'User',
                                    type: msg.type,
                                    payload: msg
                                };

                                if (msg.type === 'image' && msg.image) {
                                    formatedMessage.body = '_event_media_';
                                    formatedMessage.media = msg.image;
                                }

                                this.emit('message', formatedMessage);
                            });
                        }
                    });
                });
            }
        } catch (e) {
            console.error('[YCloudProvider] ❌ Error procesando mensaje:', e);
        }
    }
}

export { YCloudProvider };
