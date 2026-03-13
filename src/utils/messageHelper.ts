
/**
 * Función para extraer texto de CUALQUIER tipo de mensaje en Baileys
 * Basado en la guía de detección de anuncios de Meta y formatos complejos.
 */
export const obtenerTextoDelMensaje = (msg: any): string => {
    if (!msg) return '';

    // Si el objeto es el contexto de Builderbot, buscamos el mensaje real
    let mensajeReal = msg.message || msg;

    if (!mensajeReal) return '';

    // 1. Desenvolver mensajes ocultos (Temporales, Vista Única, Documentos con Caption)
    if (mensajeReal.ephemeralMessage) {
        mensajeReal = mensajeReal.ephemeralMessage.message;
    } else if (mensajeReal.viewOnceMessage) {
        mensajeReal = mensajeReal.viewOnceMessage.message;
    } else if (mensajeReal.viewOnceMessageV2) {
        mensajeReal = mensajeReal.viewOnceMessageV2.message;
    } else if (mensajeReal.documentWithCaptionMessage) {
        mensajeReal = mensajeReal.documentWithCaptionMessage.message;
    }

    // 2. Extraer el texto de la ubicación correcta según el tipo
    return mensajeReal.conversation || // Texto normal
           mensajeReal.extendedTextMessage?.text || // Textos con links o anuncios de Meta
           mensajeReal.imageMessage?.caption || // Texto debajo de una imagen
           mensajeReal.videoMessage?.caption || // Texto debajo de un video
           mensajeReal.documentMessage?.caption || // Texto debajo de un documento
           mensajeReal.templateButtonReplyMessage?.selectedDisplayText || // Respuestas a botones (Templates antiguos)
           mensajeReal.buttonsResponseMessage?.selectedDisplayText || // Respuestas a botones normales
           mensajeReal.listResponseMessage?.title || // Respuestas a listas
           mensajeReal.interactiveResponseMessage?.body?.text || // Nuevos botones interactivos
           ''; // Retorna vacío si no encuentra coincidencias
};

/**
 * Función para obtener el mensaje real unwrapped (desenvuelto)
 */
export const obtenerMensajeUnwrapped = (msg: any): any => {
    if (!msg) return null;
    const mensajeReal = msg.message || msg;
    if (!mensajeReal) return null;

    if (mensajeReal.ephemeralMessage) {
        return mensajeReal.ephemeralMessage.message;
    } else if (mensajeReal.viewOnceMessage) {
        return mensajeReal.viewOnceMessage.message;
    } else if (mensajeReal.viewOnceMessageV2) {
        return mensajeReal.viewOnceMessageV2.message;
    } else if (mensajeReal.documentWithCaptionMessage) {
        return mensajeReal.documentWithCaptionMessage.message;
    }
    
    return mensajeReal;
};
