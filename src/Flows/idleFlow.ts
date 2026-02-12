import { addKeyword, EVENTS } from '@builderbot/bot';
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { GenericResumenData, extraerDatosResumen } from '../utils/extractJsonData';
import { addToSheet } from '../utils/googleSheetsResumen';
import fs from 'fs';
import path from 'path';
import { ReconectionFlow } from './reconectionFlow';
import { groupProvider } from '../providers/instances';
import { ASSISTANT_MAP } from '../utils/assistantUtils';
import { userAssignedAssistant } from '../utils/queue';

//** Variables de entorno para el envio de msj de resumen a grupo de WS */
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? process.env.ID_GRUPO_RESUMEN ?? '';
const ID_GRUPO_RESUMEN_2 = process.env.ID_GRUPO_RESUMEN_2 ?? '';

//** Flow para cierre de conversación, generación de resumen y envio a grupo de WS */

const idleFlow = addKeyword(EVENTS.ACTION).addAction(
    async (ctx, { endFlow, provider, state }) => {
        const userId = ctx.from;
        // Filtrar contactos ignorados
        if (
            /@broadcast$/.test(userId) ||
            /@newsletter$/.test(userId) ||
            /@channel$/.test(userId) ||
            /@lid$/.test(userId)
        ) return endFlow();

        console.log("Ejecutando idleFlow...");

        try {
            const assigned = userAssignedAssistant.get(ctx.from) || 'asistente1';
            const asistenteEnUso = ASSISTANT_MAP[assigned];
            const resumen = await toAsk(asistenteEnUso, "GET_RESUMEN", state);

            if (!resumen) {
                console.warn("No se pudo obtener el resumen.");
                return endFlow();
            }

            let data: GenericResumenData;
            try {
                data = JSON.parse(resumen);
            } catch (error) {
                data = extraerDatosResumen(resumen);
            }

            const tipo = (data.tipo ?? '').replace(/[^A-Z0-9_]/gi, '').toUpperCase();
            data.linkWS = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;

            if (tipo.includes('NO_REPORTAR_BAJA')) {
                await addToSheet(data);
                return endFlow();
            } else if (tipo.includes('NO_REPORTAR_SEGUIR')) {
                const reconFlow = new ReconectionFlow({
                    ctx, state, provider,
                    maxAttempts: 3,
                    onSuccess: async (newData) => {
                        if (typeof ctx.gotoFlow === 'function') {
                            if (ctx.type === 'voice_note' || ctx.type === 'VOICE_NOTE') {
                                const mod = await import('./welcomeFlowVoice');
                                await ctx.gotoFlow(mod.welcomeFlowVoice);
                            } else {
                                const mod = await import('./welcomeFlowTxt');
                                await ctx.gotoFlow(mod.welcomeFlowTxt);
                            }
                        }
                    },
                    onFail: async () => { await addToSheet(data); }
                });
                return await reconFlow.start();
            } else {
                // SI_RESUMEN, SI_RESUMEN_G2 o DEFAULT
                const targetGroup = tipo.includes('G2') ? ID_GRUPO_RESUMEN_2 : ID_GRUPO_RESUMEN;
                const resumenConLink = `${resumen}\n\n🔗 [Chat del usuario](${data.linkWS})`;

                try {
                    // USAR groupProvider para enviar a grupos
                    if (groupProvider) {
                        await groupProvider.sendText(targetGroup, resumenConLink);
                        console.log(`✅ Resumen enviado al grupo ${targetGroup}`);

                        const fotoOVideo = data["Foto o video"]?.trim() || '';
                        if (/^s[ií]$/i.test(fotoOVideo)) {
                            const lastImage = state.get('lastImage');
                            const lastVideo = state.get('lastVideo');

                            if (lastImage && fs.existsSync(lastImage)) {
                                setTimeout(async () => {
                                    try {
                                        await groupProvider.sendImage(targetGroup, lastImage);
                                        fs.unlinkSync(lastImage);
                                    } catch (e) {
                                        console.error(`[idleFlow] Error enviando imagen:`, e);
                                    }
                                }, 2000);
                            }

                            if (lastVideo && fs.existsSync(lastVideo)) {
                                setTimeout(async () => {
                                    try {
                                        await groupProvider.sendVideo(targetGroup, lastVideo);
                                        fs.unlinkSync(lastVideo);
                                    } catch (e) {
                                        console.error(`[idleFlow] Error enviando video:`, e);
                                    }
                                }, 2500);
                            }
                        }
                    } else {
                        console.error("❌ No hay groupProvider configurado para enviar el resumen.");
                    }
                } catch (err) {
                    console.error(`❌ Error enviando resumen al grupo:`, err?.message || err);
                }
                
                await addToSheet(data);
                return;
            }
        } catch (error) {
            console.error("Error en idleFlow:", error);
            return endFlow();
        }
    }
);

export { idleFlow };