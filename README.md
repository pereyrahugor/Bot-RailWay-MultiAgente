
# WhatsApp Multiagente AI Bot (BuilderBot.app)

<p align="center">
  <img src="https://builderbot.vercel.app/assets/thumbnail-vector.png" height="80">
</p>

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/0aizfD?referralCode=yO-oOz)

Este proyecto implementa un bot de WhatsApp multiagente usando BuilderBot y OpenAI Assistants. El sistema permite que un asistente recepcionista derive conversaciones a otros asistentes especializados, manteniendo el contexto y el hilo de la conversación.

## Características principales

- Arquitectura multiagente: un recepcionista identifica la intención y deriva a asistentes expertos.
- Integración con OpenAI Assistants para respuestas inteligentes.
- Flujos conversacionales personalizables y escalables.
- Manejo de seguimientos automáticos y cierre de conversaciones configurable por variables de entorno.
- Soporte para integración con Google Sheets y almacenamiento de datos.
- Despliegue sencillo en Railway, Docker o local.

## Estructura de agentes

- **Recepcionista**: Primer punto de contacto, clasifica la intención del usuario.
- **Asistentes especializados**: Atienden consultas específicas (ventas, reservas, soporte, etc.).
- **Derivación automática**: El recepcionista decide a qué asistente derivar según la intención detectada.

## Variables de entorno obligatorias

Configura tu archivo `.env` con las siguientes variables para controlar los mensajes y tiempos de los flujos:

```env
ASSISTANT_1=
ASSISTANT_2=
ASSISTANT_3=
ASSISTANT_ID=
OPENAI_API_KEY=
ID_GRUPO_RESUMEN=
msjCierre=
msjSeguimiento1=
msjSeguimiento2=
msjSeguimiento3=
timeOutCierre=
timeOutSeguimiento2=
timeOutSeguimiento3=
PORT=3000
```

- **msjCierre**: Mensaje final de cierre de conversación.
- **msjSeguimiento1/2/3**: Mensajes de seguimiento para cada intento en el flujo de reconexión.
- **timeOutCierre**: Tiempo (en minutos) antes de cerrar la conversación automáticamente.
- **timeOutSeguimiento2/3**: Tiempos (en minutos) entre mensajes de seguimiento en reconexión.

## Instalación y ejecución

1. Clona este repositorio.
2. Instala dependencias:
   ```sh
   pnpm install
   ```
3. Configura tu archivo `.env` con los valores requeridos.
4. Ejecuta el bot en desarrollo:
   ```sh
   pnpm run dev
   ```
5. (Opcional) Despliega en Railway o Docker.

## Flujo de trabajo multiagente

1. El usuario escribe al bot.
2. El recepcionista (ASSISTANT_1) analiza la intención.
3. Si es necesario, deriva la conversación a un asistente especializado (ASSISTANT_2, ASSISTANT_3, etc.).
4. El contexto y el hilo se mantienen durante toda la conversación.
5. Si el usuario no responde, se activan los mensajes de seguimiento y cierre según la configuración.

## Personalización

- Modifica los mensajes y tiempos en el archivo `.env` para adaptar el bot a tu flujo conversacional.
- Los flujos principales están en `src/Flows/`.
- El archivo `src/app.ts` orquesta la lógica multiagente y la derivación.

## Créditos

Desarrollado con [BuilderBot](https://www.builderbot.app/en) y OpenAI.  
Custom para Pereyra Hugo - DusckCodes.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is open-source and available under the [MIT License](LICENSE).

## Contact

F