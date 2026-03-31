/**
 * Middleware de autenticación robusto para el backoffice.
 * Verifica el token en los headers o en la query string.
 */
export const backofficeAuth = (req: any, res: any, next: () => void) => {
    // Asegurar parsing de query si Polka/Node no lo ha expuesto aún
    const q: any = {};
    try {
        const url = new URL(req.url || '', 'http://localhost');
        url.searchParams.forEach((v, k) => q[k] = v);
    } catch (e) { /* fallback a vacío */ }
    req.query = q;

    let token = req.headers['authorization'] || q.token || '';
    if (typeof token === 'string') {
        if (token.startsWith('token=')) token = token.slice(6);
        else if (token.startsWith('Bearer ')) token = token.slice(7);
    }
    
    if (token && token === process.env.BACKOFFICE_TOKEN) {
        return next();
    }
    
    console.warn(`[AUTH] Intento fallido de acceso al backoffice. Token recibido: ${token ? 'presente(***)' : 'ausente'}`);
    
    // Si res.status o res.json no existen (middleware antes de compatibilidad), los manejamos manualmente
    if (typeof res.status === 'function') {
        res.status(401).json({ success: false, error: "Unauthorized" });
    } else {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: "Unauthorized" }));
    }
};
