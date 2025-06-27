# README-CONTEXT.txt

Este archivo es para dejar notas de contexto, ideas, decisiones de diseño, tareas pendientes, o cualquier información relevante para el desarrollo y mantenimiento del proyecto.

Puedes escribir aquí cualquier cosa que quieras que el equipo (o una IA como yo) tenga en cuenta mientras trabajamos en el código.

---

## Ejemplo de uso
- [2025-06-23] Recordar que el bot debe responder en menos de 30 segundos para evitar timeouts de WhatsApp.
- [2025-06-23] Se está usando la API de Google Sheets para cargar datos de ventas y alquiler.
- [2025-06-23] Si se agrega un nuevo flujo, actualizar la función `createFlow` en `app.ts`.

---

Agrega tus notas debajo de esta línea:

/**
 * ⚙️ Contexto para GitHub Copilot:
 * Este proyecto implementa un sistema multiagente usando BuilderBot + OpenAI Assistants.
 * 
 * 🔹 Objetivo:
 * Un asistente "Recepcionista" se encarga de identificar la intención del usuario
 * (por ejemplo: reservas, reclamos, ventas, etc.) y luego deriva el mensaje a un
 * segundo asistente especializado, según el caso, manteniendo el contexto del hilo.
 * 
 * 🔹 Flujo:
 * 1. BuilderBot recibe el mensaje de WhatsApp (ctx).
 * 2. El flujo principal llama a `toAsk(ASSISTANT_RECEPCION, ctx.body, state)` para que
 *    el asistente recepcionista determine qué asistente debe encargarse.
 * 3. Si el recepcionista responde algo como: "Derivar a ASISTENTE_RESERVAS", se
 *    ejecuta `toAsk(ASISTENTE_RESERVAS, ctx.body, state)` usando el mismo mensaje y estado.
 * 4. El hilo (state, thread) permanece activo y se mantiene en la misma sesión del usuario.
 * 
 * 🔹 Consideraciones:
 * - Cada asistente de OpenAI está configurado con su prompt específico.
 * - Se utiliza `state` para conservar los datos de contexto a lo largo del flujo.
 * - El módulo `getAssistantResponse` implementa un timeout por usuario y maneja la continuidad.
 * 
 * 🔹 Implementación:
 * Ver archivo app.ts, función `getAssistantResponse()` y función `processUserMessage()`.
 * También revisar cómo se gestionan los flujos de derivación en `welcomeFlowTxt` o similares.
 */
