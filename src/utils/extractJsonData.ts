import { ResumenData } from "./googleSheetsResumen";

const extraerDatosResumen = (resumen: string): ResumenData => {
    const nombreMatch = resumen.match(/Nombre[:_]?\s*(.*)/i);
    const consultaMatch = resumen.match(/Consulta[:_]?\s*(.*)/i);
    // Acepta 'Producto Interes:', 'producto_interes:', 'producto interes:', etc.
    const productoMatch = resumen.match(/Producto[:_]?\s*(.*)/i);
    const linkWSMatch = resumen.match(/WhatsApp[:_]?\s*(.*)/i);

    return {
        nombre: nombreMatch ? nombreMatch[1].trim() : "",
        consulta: consultaMatch ? consultaMatch[1].trim() : "",
        producto: productoMatch ? productoMatch[1].trim() : "",
        linkWS: linkWSMatch ? linkWSMatch[1].trim() : "",
    };
};

export {
    extraerDatosResumen
}