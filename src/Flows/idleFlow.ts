import { addKeyword, EVENTS } from '@builderbot/bot';
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { ResumenData } from '~/utils/googleSheetsResumen';
import { extraerDatosResumen } from '~/utils/extractJsonData';
//import { addToSheet } from '~/utils/googleSheetsResumen';
import fs from 'fs';
import path from 'path';
import { ReconectionFlow } from './reconectionFlow';
import { userAssignedAssistant, ASSISTANT_MAP, analizarDestinoRecepcionista } from '../app';

//** Variables de entorno para el envio de msj de resumen a grupo de WS */
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_RESUMEN ?? '';
const msjCierre = process.env.msjCierre || "¡Gracias por tu consulta! Si necesitas algo más, estamos para ayudarte.";

//** Flow para cierre de conversación, generación de resumen y envio a grupo de WS */
const idleFlow = addKeyword(EVENTS.ACTION).addAction(
    async (ctx, { endFlow, provider, state }) => {
        console.log("Ejecutando idleFlow...");

        try {
            // Determinar el asistente en uso según la lógica multiagente
            const asistenteEnUso = ASSISTANT_MAP[userAssignedAssistant.get(ctx.from) || 'asistente1'];
            // Si el state tiene algún indicio de destino previo, podrías usarlo aquí
            // (Personaliza esta lógica si tienes un campo de destino en el state)
            const resumen = await toAsk(asistenteEnUso, "GET_RESUMEN", state);

            // Verifica que haya resumen y grupo destino
            if (resumen && ID_GRUPO_RESUMEN) {

                let data: ResumenData;
                try {
                    // Intentamos parsear JSON
                    data = JSON.parse(resumen);
                } catch (error) {
                    // Si no es JSON, extrae los datos manualmente
                    console.warn("⚠️ El resumen no es JSON. Se extraerán los datos manualmente.");
                    data = extraerDatosResumen(resumen);
                }

                // Si el campo nombre está vacío o tiene valores inválidos, inicia el ciclo de reconexión
                const nombreInvalido = !data.nombre || data.nombre.trim() === "" ||
                    data.nombre.trim() === "- Nombre:" ||
                    data.nombre.trim() === "- Interés:" ||
                    data.nombre.trim() === "- Nombre de la Empresa:" ||
                    data.nombre.trim() === "- Cargo:";
                if (nombreInvalido) {
                    const reconFlow = new ReconectionFlow({
                        ctx,
                        state,
                        provider,
                        maxAttempts: 3, // Máximo de intentos de reconexión
                        onSuccess: async (newData) => {
                            // Determinar destino usando la lógica multiagente
                            const destino = analizarDestinoRecepcionista(resumen);
                            const asistenteDestino = ASSISTANT_MAP[destino];
                            // Si hay un asistente destino válido, puedes continuar el flujo con ese asistente aquí
                            // Por ahora, se mantiene el envío de resumen y guardado en Sheets
                            const whatsappLink = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                            newData.linkWS = whatsappLink;
                            const resumenConLink = `${resumen}\n\n🔗 [Chat del usuario](${whatsappLink})`;
                            try {
                                await provider.sendText(ID_GRUPO_RESUMEN, resumenConLink);
                                console.log(`✅ TEST: Resumen enviado a ${ID_GRUPO_RESUMEN} con enlace de WhatsApp`);
                            } catch (err) {
                                console.error(`❌ TEST: No se pudo enviar el resumen al grupo ${ID_GRUPO_RESUMEN}:`, err?.message || err);
                            }
                            console.log('📝 Datos a guardar en Google Sheets:', newData);
                            //await addToSheet(newData);
                            // Aquí podrías invocar el siguiente flujo con el asistente adecuado si lo deseas
                            return;
                        },
                        onFail: async () => {
                            // Al llegar al máximo de intentos, enviar aviso al grupo y guardar en Google Sheets
                            const whatsappLink = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                            const aviso = `El contacto ${whatsappLink} no respondió.`;
                            try {
                                await provider.sendText(ID_GRUPO_RESUMEN, aviso);
                                console.log(`✅ Aviso enviado al grupo ${ID_GRUPO_RESUMEN}: ${aviso}`);
                            } catch (err) {
                                console.error(`❌ No se pudo enviar el aviso al grupo ${ID_GRUPO_RESUMEN}:`, err?.message || err);
                            }
                            // Guardar en Google Sheets aunque no se envíe el resumen
                            console.log('📝 Datos a guardar en Google Sheets (sin respuesta):', data);
                            //await addToSheet(data);
                            return;
                        }
                    });
                    // Ejecuta el ciclo de reconexión y termina el flujo aquí
                    await reconFlow.start();
                    return endFlow(msjCierre);
                }

                // Si el nombre no está vacío, continúa el flujo normal
                // Construir el enlace de WhatsApp con el ID del usuario
                const whatsappLink = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                data.linkWS = whatsappLink;

                // Formatear el resumen con el enlace
                const resumenConLink = `${resumen}\n\n🔗 [Chat del usuario](${whatsappLink})`;

                // Enviar el resumen modificado al grupo de WhatsApp
                try {
                    await provider.sendText(ID_GRUPO_RESUMEN, resumenConLink);
                    console.log(`✅ TEST: Resumen enviado a ${ID_GRUPO_RESUMEN} con enlace de WhatsApp`);
                } catch (err) {
                    console.error(`❌ TEST: No se pudo enviar el resumen al grupo ${ID_GRUPO_RESUMEN}:`, err?.message || err);
                }

                // Guardar en Google Sheets
                console.log('📝 Datos a guardar en Google Sheets:', data);
                //await addToSheet(data);
            } else {
                // Si no hay resumen o falta el ID del grupo, mostrar advertencia
                console.warn("No se pudo obtener el resumen o falta ID_GRUPO_RESUMEN.");
            }
        } catch (error) {
            // Captura errores generales del flujo
            console.error("Error al obtener el resumen de OpenAI:", error);
        }

        // Mensaje de cierre del flujo
        return endFlow(msjCierre);
    }
);

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

export { idleFlow, userAssignedAssistant };