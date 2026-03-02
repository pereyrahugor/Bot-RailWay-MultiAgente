export const userQueues = new Map<string, any[]>();
export const userLocks = new Map<string, boolean>();

let globalProcessCallback: ((item: any) => Promise<void>) | null = null;

/**
 * Registra la función que procesará los elementos de la cola.
 * Ayuda a resolver dependencias circulares.
 */
export const registerProcessCallback = (cb: (item: any) => Promise<void>) => {
    globalProcessCallback = cb;
};

/**
 * Maneja la cola de mensajes para un usuario específico de forma secuencial.
 */
export const handleQueue = async (userId: string) => {
    if (!userQueues.has(userId)) return;
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) return;

    userLocks.set(userId, true);

    try {
        while (queue && queue.length > 0) {
            const item = queue.shift();
            try {
                if (globalProcessCallback) {
                    await globalProcessCallback(item);
                } else {
                    console.warn("[QueueManager] No se ha registrado un callback de procesamiento.");
                }
            } catch (error) {
                console.error(`Error procesando elemento de cola para ${userId}:`, error);
            }
        }
    } finally {
        userLocks.set(userId, false);
        // Si la cola está vacía, la eliminamos para liberar memoria
        if (queue && queue.length === 0) {
            userQueues.delete(userId);
        }
    }
};
