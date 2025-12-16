// src/utils/JsonBlockFinder.ts

export class JsonBlockFinder {
    static buscarBloquesJSONEnTexto(texto: string): any | null {
        // 1. Buscar bloques entre etiquetas [JSON-RESERVA], [JSON-DISPONIBLE], [JSON-MODIFICAR], [JSON-CANCELAR]
        const etiquetas = [
            { type: 'create_event' },
            { type: 'available_event' },
            { type: 'modify_event' },
            { type: 'cancel_event' }
        ];
        for (const { type } of etiquetas) {
            // Corregido: buscar etiquetas literales [JSON-RESERVA], etc.
                const regex = new RegExp(`\\[${type}\\]([\\s\\S]*?)\\[/${type}\\]`, 'g');
            let match;
            while ((match = regex.exec(texto)) !== null) {
                try {
                    const parsed = JSON.parse(match[1]);
                    if (parsed.type === type) {
                        return parsed;
                    }
                } catch (e) {
                    // No es JSON válido, sigue buscando
                }
            }
        }
        // 2. Buscar bloques JSON sueltos en el texto
        const bloques = [...texto.matchAll(/\{[\s\S]*?\}/g)].map(m => m[0]);
        for (const block of bloques) {
            try {
                const parsed = JSON.parse(block);
                if (["create_event", "available_event", "modify_event", "cancel_event"].includes(parsed.type)) {
                    return parsed;
                }
            } catch (e) {
                // No es JSON válido, sigue buscando
            }
        }
        return null;
    }

    static buscarBloquesJSONProfundo(obj: any): any | null {
        if (!obj) return null;
        if (typeof obj === 'string') {
            return JsonBlockFinder.buscarBloquesJSONEnTexto(obj);
        }
        if (typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const encontrado = JsonBlockFinder.buscarBloquesJSONProfundo(obj[key]);
                if (encontrado) return encontrado;
            }
        }
        return null;
    }
}
