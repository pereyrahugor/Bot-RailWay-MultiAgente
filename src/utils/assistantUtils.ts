export const ASSISTANT_MAP = {
    asistente1: process.env.ASSISTANT_1,
    asistente2: process.env.ASSISTANT_2,
    asistente3: process.env.ASSISTANT_3,
    asistente4: process.env.ASSISTANT_4,
    asistente5: process.env.ASSISTANT_5,
};

export function analizarDestinoRecepcionista(respuesta: string) {
    const lower = respuesta.toLowerCase();
    if (/derivar(?:ndo)?\s+a\s+asistente\s*1\b/.test(lower)) return 'asistente1';
    if (/derivar(?:ndo)?\s+a\s+asistente\s*2\b/.test(lower)) return 'asistente2';
    if (/derivar(?:ndo)?\s+a\s+asistente\s*3\b/.test(lower)) return 'asistente3';
    if (/derivar(?:ndo)?\s+a\s+asistente\s*4\b/.test(lower)) return 'asistente4'; 
    if (/derivar(?:ndo)?\s+a\s+asistente\s*5\b/.test(lower)) return 'asistente5';
    if (/derivar|derivando/.test(lower)) return 'ambiguous';
    return null;
}

export function extraerResumenRecepcionista(respuesta: string) {
    const match = respuesta.match(/GET_RESUMEN[\s\S]+/i);
    return match ? match[0].trim() : "Continúa con la atención del cliente.";
}
