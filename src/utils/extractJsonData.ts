/**
 * Extrae datos de un resumen en formato texto plano, devolviendo un objeto genérico
 * con todas las claves y valores detectados (clave: valor) en cada línea.
 */
export type GenericResumenData = Record<string, string>;

const extraerDatosResumen = (resumen: string): GenericResumenData => {
    const data: GenericResumenData = {};
    const lines = resumen.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^\s*([\wÁÉÍÓÚáéíóúñÑ ._-]+)\s*[:=]\s*(.+)$/);
        if (match) {
            const key = match[1].trim().replace(/^[-–—\s]+/, '');
            const value = match[2].trim();
            data[key] = value;
            // Si la clave es 'Tipo', también guardar como 'tipo' en minúsculas
            if (key.toLowerCase() === 'tipo') {
                data['tipo'] = value;
            }
        }
    }
    console.log('[extractJsonData] data extraído:', data);
    return data;
};

export { extraerDatosResumen };