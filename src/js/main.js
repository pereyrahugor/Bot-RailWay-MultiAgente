const textarea = document.getElementById('input')
const input = document.getElementById('input')
const sendBtn = document.getElementById('send')
const chat = document.getElementById('chat') // style - agus

// ===== Botón volver en header =====
const headerBack = document.getElementById('backBtn')
if (headerBack) {
    headerBack.addEventListener('click', () => {
        if (history.length > 1) history.back()
        else window.location.href = 'https://asistentes.clientesneurolinks.com/' // ajustar URL
    })
}

// ===== Viewport dinámico para Chrome/Firefox/iOS =====
function setAppVh() {
    // Prioriza visualViewport si existe; si no, usa innerHeight
    const h = (window.visualViewport?.height || window.innerHeight);
    document.documentElement.style.setProperty('--app-vh', `${h}px`);
}
setAppVh();

// Eventos que disparan cambio real de alto en mobile
window.addEventListener('resize', setAppVh, { passive: true })
window.addEventListener('orientationchange', setAppVh, { passive: true })
window.addEventListener('pageshow', setAppVh, { passive: true }) // vuelve de bfcache
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppVh, { passive: true })
    window.visualViewport.addEventListener('scroll', setAppVh, { passive: true }) // FF/Chrome barras
}

/* ============================================
   AUTOSIZE: solo crecer en 2+ líneas
   ============================================ */

// Lee estilos actuales del textarea
function computeHeights() {
    const cs = getComputedStyle(textarea)
    const minH = parseFloat(cs.minHeight) || 45
    const maxH = parseFloat(cs.maxHeight) || 120
    const lineH = parseFloat(cs.lineHeight) || 20
    const vPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const vBorder = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    const oneLine = Math.ceil(lineH + vPad + vBorder)
    // Altura base = mayor entre min-height y una línea real
    const baseH = Math.max(minH, oneLine)
    return { MIN_H: minH, MAX_H: maxH, BASE_H: baseH }
}

let { MIN_H, MAX_H, BASE_H } = computeHeights()
const HYST = 1 // px de tolerancia para evitar saltitos

function autosizeSmart(el) {
    // Si está vacío, vuelve a base
    if (!el.value.trim()) {
        el.style.height = BASE_H + 'px'
        return
    }

    // Medir wrap partiendo desde base
    el.style.height = BASE_H + 'px'
    const sh = el.scrollHeight

    // Si entra en una sola línea, no crecer
    if (sh <= BASE_H + HYST) {
        el.style.height = BASE_H + 'px'
        return
    }

    // 2+ líneas: crecer hasta el tope
    el.style.height = Math.min(sh, MAX_H) + 'px'
}

// Inicializa altura base
textarea.style.height = BASE_H + 'px'

// Recalcular en input
textarea.addEventListener('input', function () {
    autosizeSmart(this)
})

// Recalcular base si cambia layout (rotación/teclado)
window.addEventListener('resize', () => {
    const prevBase = BASE_H
        ; ({ MIN_H, MAX_H, BASE_H } = computeHeights())
    // Si estaba en 1 línea, mantener base; si estaba alto, recalcular con nuevo base/tope
    if ((parseFloat(textarea.style.height) || prevBase) <= prevBase + HYST) {
        textarea.style.height = BASE_H + 'px'
    } else {
        autosizeSmart(textarea)
    }
})

/* ============================================
   UX: mantener scroll al fondo al escribir/enfocar
   ============================================ */
function scrollBottom() {
    chat.scrollTop = chat.scrollHeight
}
textarea.addEventListener('focus', () => {
    autosizeSmart(textarea) // asegura altura correcta al enfocar
    scrollBottom()
})
textarea.addEventListener('input', scrollBottom)

/* ============================================
   Envío de mensajes
   ============================================ */
async function sendMessage() {
    const msg = input.value.trim()
    if (!msg) return
    addMessage(msg, 'user')
    input.value = ''

    // Reset de altura correcto (usa BASE_H)
    autosizeSmart(textarea)

    try {
        const res = await fetch('/webchat-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        })
        const data = await res.json()
        addMessage(data.reply, 'bot')
    } catch (err) {
        addMessage('Hubo un error procesando tu mensaje.', 'bot')
    }
}

// Enter envía / Shift+Enter = nueva línea
sendBtn.onclick = sendMessage
input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendMessage()
    }
})

function addMessage(text, type) {
    const div = document.createElement('div')
    div.className = 'msg ' + type
    div.innerText = text
    chat.appendChild(div)
    chat.scrollTop = chat.scrollHeight

    // Reproducir sonido si es respuesta del bot
    if (type === 'bot') {
        let audio = document.getElementById('msgReceivedAudio');
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'msgReceivedAudio';
            audio.src = 'assets/msgReceived.mp3';
            audio.style.display = 'none';
            document.body.appendChild(audio);
        }
        audio.currentTime = 0;
        audio.play();
    }
}