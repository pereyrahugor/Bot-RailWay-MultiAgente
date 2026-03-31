
import fs from 'fs';
import path from 'path';
import serve from 'serve-static';
import bodyParser from 'body-parser';
import multer from 'multer';

const upload = multer({ dest: 'uploads/' });

/**
 * Middleware de compatibilidad para Polka (agrega res.json, res.send, res.sendFile)
 */
export const compatibilityMiddleware = (req: any, res: any, next: () => void) => {
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.send = (body: any) => {
        if (res.headersSent) return res;
        if (typeof body === 'object') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(body || null));
        } else {
            res.end(body || '');
        }
        return res;
    };
    res.json = (data: any) => {
        if (res.headersSent) return res;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data || null));
        return res;
    };
    res.sendFile = (filepath: string) => {
        if (res.headersSent) return;
        try {
            if (fs.existsSync(filepath)) {
                const ext = path.extname(filepath).toLowerCase();
                const mimeTypes: Record<string, string> = {
                    '.html': 'text/html',
                    '.js': 'application/javascript',
                    '.css': 'text/css',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.svg': 'image/svg+xml',
                    '.json': 'application/json'
                };
                res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
                fs.createReadStream(filepath)
                    .on('error', (err) => {
                        console.error(`[ERROR] Stream error in sendFile (${filepath}):`, err);
                        if (!res.headersSent) {
                            res.statusCode = 500;
                            res.end('Internal Server Error');
                        }
                    })
                    .pipe(res);
            } else {
                console.error(`[ERROR] sendFile: File not found: ${filepath}`);
                res.statusCode = 404;
                res.end('Not Found');
            }
        } catch (e) {
            console.error(`[ERROR] Error in sendFile (${filepath}):`, e);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.end('Internal Error');
            }
        }
    };
    next();
};

/**
 * Master Interceptor para el bypass de archivos en el Backoffice.
 * Captura la ruta de envío de mensaje con archivo ANTES del body-parser global.
 */
export const fileUploadInterceptor = (req: any, res: any, next: () => void) => {
    if (req.url.startsWith('/api/backoffice/send-message') && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            console.log("📂 [INTERCEPTOR] Capturando subida de archivo para Backoffice...");
            return upload.single('file')(req, res, (err) => {
                if (err) {
                    console.error("❌ [INTERCEPTOR] Error en Multer:", err);
                    return res.status(400).json({ success: false, error: err.message });
                }
                next();
            });
        }
    }
    next();
};

/**
 * Configura las rutas estáticas y logging básico
 */
export const setupStaticRoutes = (app: any) => {
    const cwd = process.cwd();
    app.use("/js", serve(path.join(cwd, "src", "js")));
    app.use("/style", serve(path.join(cwd, "src", "style")));
    app.use("/assets", serve(path.join(cwd, "src", "assets")));
    app.use("/uploads", serve(path.join(cwd, "uploads")));

    app.use((req: any, res: any, next: () => void) => {
        if (req.url === "/" || req.url === "") {
            res.writeHead(302, { 'Location': '/dashboard' });
            return res.end();
        }
        next();
    });
};
