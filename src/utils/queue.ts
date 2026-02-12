export const userQueues = new Map();
export const userLocks = new Map();
export const userAssignedAssistant = new Map();

let _processUserMessage: any;

export const setProcessUserMessage = (fn: any) => {
    _processUserMessage = fn;
};

export const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    if (!queue || userLocks.get(userId) || !_processUserMessage) return;

    userLocks.set(userId, true);
    while (queue.length > 0) {
        const { ctx, flowDynamic, state, provider, gotoFlow } = queue.shift();
        try {
            await _processUserMessage(ctx, { flowDynamic, state, provider, gotoFlow });
        } catch (error) {
            console.error(`Error procesando el mensaje de ${userId}:`, error);
        }
    }
    userLocks.set(userId, false);
};
