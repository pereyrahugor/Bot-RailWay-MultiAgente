import { addKeyword, EVENTS } from "@builderbot/bot";
import { ErrorReporter } from "../utils/errorReporter";

const welcomeFlowImg = addKeyword(EVENTS.MEDIA).addAnswer(
  "Por un problema no puedo ver imágenes, me podrás escribir de que trata la imagen? Gracias ",
  { capture: false },
  async (ctx) => {
    if (!ctx?.media?.buffer || ctx.media.buffer.length === 0) {
      console.error("No se recibió buffer de imagen válido.");
      return;
    }
    console.log("Imagen recibida:", ctx);
    await new ErrorReporter(ctx.provider, ctx.groupId);
  }
);

export { welcomeFlowImg };