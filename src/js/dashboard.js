async function fetchStatus() {
    try {
        const res = await fetch('/api/dashboard-status');
        const data = await res.json();
        document.getElementById('session-status').textContent = data.active ? '✅ Activa (Archivos encontrados)' : '⏳ Esperando Escaneo';
        if (data.error) {
            document.getElementById('session-error').innerHTML = `<div class='error-box'>⚠️ Error al verificar sesión: ${data.error}</div>`;
        }
        if (!data.active) {
            document.getElementById('qr-section').style.display = '';
            document.getElementById('session-info').style.display = 'none';

            // Intentar recargar el QR si no se ha cargado
            const qrImg = document.querySelector('.qr');
            qrImg.src = '/qr.png?t=' + Date.now();
            qrImg.style.display = 'inline-block';
            qrImg.nextElementSibling.style.display = 'none';
        } else {
            document.getElementById('qr-section').style.display = 'none';
            document.getElementById('session-info').style.display = '';
            document.getElementById('session-info').textContent = 'El bot ha detectado archivos de sesión. Si WhatsApp no responde, usa la opción de reinicio abajo.';
        }
    } catch (e) {
        document.getElementById('session-status').textContent = 'Error';
        document.getElementById('session-error').innerHTML = `<div class='error-box'>No se pudo obtener el estado del bot.</div>`;
    }
}
fetchStatus();
setInterval(fetchStatus, 5000);

// Redirigir a /webreset al hacer click en el botón de reinicio
document.getElementById('go-reset').addEventListener('click', function() {
    window.location.href = '/webreset';
});
