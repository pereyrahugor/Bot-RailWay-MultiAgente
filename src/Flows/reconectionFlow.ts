// Clase para manejar la lógica de reconexión cuando el campo nombre está vacío
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { extraerDatosResumen, GenericResumenData } from '../utils/extractJsonData';
import { analizarDestinoRecepcionista, ASSISTANT_MAP } from "../utils/assistantUtils";
import { userAssignedAssistant } from "../utils/queue";

// Opciones para configurar el flujo de reconexión
interface ReconectionOptions {
    ctx: any; // Contexto del usuario
    state: any; // Estado de la conversación
    provider: any; // Proveedor de mensajería
    maxAttempts?: number; // Máximo de intentos de reconexión
    timeoutMs?: number; // Tiempo de espera entre intentos (ms)
    onSuccess: (data: GenericResumenData) => Promise<void>; // Callback si se obtiene el nombre
    onFail: () => Promise<void>; // Callback si se alcanzan los intentos máximos
}

// Clase principal para el ciclo de reconexión
export class ReconectionFlow {
    private attempts = 0; // Contador de intentos realizados
    private readonly maxAttempts: number; // Máximo de intentos permitidos
    private readonly timeoutMs: number; // Tiempo de espera entre intentos
    private readonly ctx: any; // Contexto del usuario
    private readonly state: any; // Estado de la conversación
    private readonly provider: any; // Proveedor de mensajería
    private readonly onSuccess: (data: GenericResumenData) => Promise<void>; // Acción al obtener nombre
    private readonly onFail: () => Promise<void>; // Acción al fallar todos los intentos

    constructor(options: ReconectionOptions) {
        this.ctx = options.ctx;
        this.state = options.state;
        this.provider = options.provider;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.timeoutMs = options.timeoutMs ?? 60000;
        this.onSuccess = options.onSuccess;
        this.onFail = options.onFail;
    }

    // Inicia el ciclo de reconexión
    async start() {
        // Intentar restaurar el estado previo si existe
        if (this.state && this.state.reconectionFlow) {
            this.restoreState(this.state.reconectionFlow);
            console.log('[ReconectionFlow] Estado restaurado:', this.state.reconectionFlow);
        }
        const originalCtx = { ...this.ctx };
        const originalFrom = originalCtx.from;
        const jid = originalFrom && originalFrom.endsWith('@s.whatsapp.net')
            ? originalFrom
            : `${originalFrom}@s.whatsapp.net`;
        console.log(`[ReconectionFlow] originalCtx.from:`, originalFrom, '| jid usado:', jid);

        // Mensajes y timeouts desde variables de entorno
        const msjSeguimiento1 = process.env.msjSeguimiento1 || '';
        const msjSeguimiento2 = process.env.msjSeguimiento2 || '';
        const msjSeguimiento3 = process.env.msjSeguimiento3 || '';
        const timeOutSeguimiento2 = Number(process.env.timeOutSeguimiento2) * 60 * 1000;
        const timeOutSeguimiento3 = Number(process.env.timeOutSeguimiento3) * 60 * 1000;

        while (this.attempts < this.maxAttempts) {
            this.attempts++;
            // Guardar el estado actual de reconexión en el state global
            if (this.state) {
                this.state.reconectionFlow = this.getState();
            }
            let msg = '';
            let timeout = this.timeoutMs;
            switch (this.attempts) {
                case 1:
                    msg = msjSeguimiento1;
                    timeout = timeOutSeguimiento2;
                    break;
                case 2:
                    msg = msjSeguimiento2;
                    timeout = timeOutSeguimiento3;
                    break;
                case 3:
                default:
                    msg = msjSeguimiento3
                    timeout = 60000; // 1 minuto para el siguiente msj
                    break;
            }
            if (typeof timeout !== 'number' || isNaN(timeout)) timeout = this.timeoutMs;
            if (jid) {
                try {
                    console.log(`[ReconectionFlow] Enviando mensaje de reconexión a:`, jid);
                    await this.provider.sendText(jid, msg);
                } catch (err) {
                    console.error(`[ReconectionFlow] Error enviando mensaje de reconexión a ${jid}:`, err);
                }
            } else {
                console.warn('[ReconectionFlow] Contexto inválido, no se puede enviar mensaje de reconexión.');
            }
            console.log(`[ReconectionFlow] Intento ${this.attempts} de ${this.maxAttempts} para ${jid} | Timeout: ${timeout}ms`);

            // Espera el timeout o la respuesta del usuario, lo que ocurra primero
            const userResponded = await this.waitForUserResponse(jid, timeout);
            if (userResponded) {
                // Limpiar el estado de reconexión al éxito
                if (this.state) delete this.state.reconectionFlow;
                // Determinar el asistente destino según la lógica multiagente
                const asistenteEnUso = ASSISTANT_MAP[userAssignedAssistant.get(this.ctx.from) || 'asistente1'];
                const resumen = await toAsk(asistenteEnUso, "GET_RESUMEN", this.state);
                const data: GenericResumenData = extraerDatosResumen(resumen);
                await this.onSuccess(data);
                return;
            }

            // Si no respondió, intentar obtener el resumen nuevamente desde el asistente asignado
            const asistenteEnUso = ASSISTANT_MAP[userAssignedAssistant.get(this.ctx.from) || 'asistente1'];
            const resumen = await toAsk(asistenteEnUso, "GET_RESUMEN", this.state);
            const data: GenericResumenData = extraerDatosResumen(resumen);
            const nombreInvalido = !data.nombre || data.nombre.trim() === "" ||
                data.nombre.trim() === "- Nombre:" ||
                data.nombre.trim() === "- Interés:" ||
                data.nombre.trim() === "- Nombre de la Empresa:" ||
                data.nombre.trim() === "- Cargo:";
            if (!nombreInvalido) {
                if (this.state) delete this.state.reconectionFlow;
                await this.onSuccess(data);
                return;
            }
        }
        // Limpiar el estado de reconexión al fallar
        if (this.state) delete this.state.reconectionFlow;
        await this.onFail();
    }

    /**
     * Espera la respuesta del usuario o el timeout, lo que ocurra primero.
     * Sólo considera mensajes de usuario reales (no vacíos, no de bots, no de grupos, no de broadcasts, no de sistemas).
     */
    private waitForUserResponse(jid: string, timeout: number): Promise<boolean> {
        return new Promise((resolve) => {
            let responded = false;
            // Suscribirse a los mensajes entrantes del usuario
            const onMessage = async (msg: any) => {
                // Filtro robusto de mensajes
                const msgFrom = msg.from && msg.from.endsWith('@s.whatsapp.net') ? msg.from : `${msg.from}@s.whatsapp.net`;
                // Ignorar mensajes de grupos, broadcasts, sistemas, bots o vacíos
                if (
                    msgFrom !== jid ||
                    msg.isGroup ||
                    msg.isBroadcast ||
                    msg.isSystem ||
                    msg.isBot ||
                    !msg.body || typeof msg.body !== 'string' || msg.body.trim() === ''
                ) {
                    return;
                }
                // Enviar el mensaje recibido al asistente asignado como "hola, [msj]"
                const userMsg = msg.body;
                const prompt = `hola, ${userMsg}`;
                try {
                    const asistenteEnUso = ASSISTANT_MAP[userAssignedAssistant.get(this.ctx.from) || 'asistente1'];
                    await toAsk(asistenteEnUso, prompt, this.state);
                } catch (err) {
                    console.error('[ReconectionFlow] Error enviando mensaje al asistente:', err);
                }
                responded = true;
                if (this.provider.off) this.provider.off('message', onMessage);
                clearTimeout(timer);
                resolve(true);
            };
            if (this.provider.on) this.provider.on('message', onMessage);

            // Timeout
            const timer = setTimeout(() => {
                if (!responded) {
                    if (this.provider.off) this.provider.off('message', onMessage);
                    resolve(false);
                }
            }, timeout);
        });
    }

    /**
     * Devuelve el estado serializable del flujo de reconexión para persistencia.
     */
    public getState() {
        return {
            attempts: this.attempts,
            // Puedes agregar más campos si necesitas persistir más información
        };
    }

    /**
     * Restaura el estado serializable del flujo de reconexión.
     */
    public restoreState(state: any) {
        if (state && typeof state.attempts === 'number') {
            this.attempts = state.attempts;
        }
    }
}