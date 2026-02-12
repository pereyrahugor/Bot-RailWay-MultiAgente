/**
 * Obtiene partido, localidad y dirección a partir de latitud y longitud usando la API de Google Maps Reverse Geocoding.
 * @param lat Latitud
 * @param lng Longitud
 * @returns { partido: string, localidad: string, direccion: string } o null si no se encuentra
 *
 * Requiere credenciales: process.env.GOOGLE_MAPS_API_KEY
 */
import { Client } from "@googlemaps/google-maps-services-js";
import { addKeyword, EVENTS } from "@builderbot/bot";
import { userQueues, userLocks, handleQueue } from "../utils/queue";
import { reset } from "../utils/timeOut";

const setTime = Number(process.env.timeOutCierre) * 60 * 1000;

export async function getAddressFromCoordinates(lat: number, lng: number) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    console.log('API KEY utilizada:', apiKey);
    console.log('Parámetros recibidos:', lat, lng);
    const client = new Client({});
    try {
        const response = await client.reverseGeocode({
            params: {
                latlng: { lat, lng },
                key: apiKey,
            },
            timeout: 5000,
        });
        console.log('Respuesta completa de Google Maps API:', JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error('Error al consultar Google Maps API:', error);
        if (error.response) {
            console.error('Respuesta de error:', JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

export const locationFlow = addKeyword(EVENTS.LOCATION).addAction(
    async (ctx, { flowDynamic, provider, gotoFlow, state }) => {
        reset(ctx, gotoFlow, setTime);
        console.log("📍 Ubicación recibida:", ctx.message);
        
        const latitude = ctx.message.location?.degreesLatitude || ctx.message.locationMessage?.degreesLatitude;
        const longitude = ctx.message.location?.degreesLongitude || ctx.message.locationMessage?.degreesLongitude;
        
        if (latitude && longitude) {
            console.log('Llamando a getAddressFromCoordinates con:', latitude, longitude);
            try {
                const mapsData = await getAddressFromCoordinates(latitude, longitude);
                if (mapsData && mapsData.results && mapsData.results.length > 0) {
                    const result = mapsData.results[0];
                    const formatted = result.formatted_address;
                    
                    let localidad = '';
                    let partido = '';
                    let provincia = '';
                    
                    for (const comp of result.address_components) {
                        if ((comp.types as string[]).includes('locality')) localidad = comp.long_name;
                        if ((comp.types as string[]).includes('administrative_area_level_2')) partido = comp.long_name;
                        if ((comp.types as string[]).includes('administrative_area_level_1')) provincia = comp.long_name;
                    }
                    
                    let direccionModificada = formatted;
                    if (localidad && partido && provincia) {
                        const partes = formatted.split(", ");
                        const idxLocalidad = partes.findIndex(p => p === localidad);
                        const idxProvincia = partes.findIndex(p => p === provincia);
                        
                        if (idxLocalidad !== -1 && idxProvincia !== -1 && idxProvincia > idxLocalidad) {
                            const nuevasPartes = [...partes];
                            nuevasPartes.splice(idxProvincia, 0, partido);
                            direccionModificada = nuevasPartes.join(", ");
                        } else if (idxLocalidad !== -1) {
                            const nuevasPartes = [...partes];
                            nuevasPartes.splice(idxLocalidad + 1, 0, partido);
                            direccionModificada = nuevasPartes.join(", ");
                        } else if (idxProvincia !== -1) {
                            const nuevasPartes = [...partes];
                            nuevasPartes.splice(idxProvincia, 0, partido);
                            direccionModificada = nuevasPartes.join(", ");
                        } else {
                            const idxPais = partes.length - 1;
                            const nuevasPartes = [...partes];
                            nuevasPartes.splice(idxPais, 0, partido);
                            direccionModificada = nuevasPartes.join(", ");
                        }
                    }
                    
                    // @ts-ignore
                    ctx.direccionDetectada = direccionModificada;
                    ctx.body = `Se recibió la siguiente ubicación: ${direccionModificada}`;
                    
                    const userId = ctx.from;
                    if (!userQueues.has(userId)) {
                      userQueues.set(userId, []);
                    }
                    
                    userQueues.get(userId).push({ ctx, flowDynamic, state, provider, gotoFlow });
                    
                    if (!userLocks.get(userId) && userQueues.get(userId).length === 1) {
                      await handleQueue(userId);
                    }
                    
                    console.log('Dirección modificada:', direccionModificada);
                } else {
                    await flowDynamic('No se pudo obtener una dirección a partir de la ubicación enviada.');
                    console.log('No se obtuvo respuesta válida de Google Maps API.');
                }
            } catch (err) {
                await flowDynamic('Ocurrió un error al consultar la dirección. Intenta nuevamente más tarde.');
                console.error('Error inesperado en el flujo de ubicación:', err);
            }
        } else {
            await flowDynamic('No se detectó una ubicación válida.');
        }
    }
);
