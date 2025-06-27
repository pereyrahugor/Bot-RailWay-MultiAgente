import { BotContext, TFlow } from '@builderbot/bot/dist/types';
import { idleFlow } from '~/Flows/idleFlow';
import "dotenv/config";

// Object to store timers for each user
// Objeto para almacenar temporizadores para cada usuario
const timers = {};
// Flow for handling inactivity
// Flujo para el manejo de la inactividad

// Function to start the inactivity timer for a user
// Función para iniciar el temporizador de inactividad de un usuario
const start = (ctx: BotContext, gotoFlow: (a: TFlow) => Promise<void>, ms: number) => {
    timers[ctx.from] = setTimeout(() => {
        console.log(`Tiempo de espera finalizado del usuario: ${ctx.from}`);
        return gotoFlow(idleFlow);
    }, ms);
};

// Function to reset the inactivity timer for a user
// Función para restablecer el temporizador de inactividad de un usuario
const reset = (ctx: BotContext, gotoFlow: (a: TFlow) => Promise<void>, ms: number) => {
    stop(ctx);
    if (timers[ctx.from]) {
        console.log(`Contador reseteado del usuario: ${ctx.from}`)
        clearTimeout(timers[ctx.from]);
    }
    start(ctx, gotoFlow, ms);
    return ctx;
};

// Function to stop the inactivity timer for a user
// Función para detener el temporizador de inactividad para un usuario
const stop = (ctx: BotContext) => {
    if (timers[ctx.from]) {
        clearTimeout(timers[ctx.from]);
    }
};

export {
    start,
    reset,
    stop,
}
