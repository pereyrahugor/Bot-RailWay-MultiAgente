// Archivo JS para funcionalidades de webreset.html
console.log('webreset.js cargado');

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('reiniciarBtn');
  const modal = document.getElementById('modal');
  const si = document.getElementById('confirmSi');
  const no = document.getElementById('confirmNo');

  btn.addEventListener('click', () => {
    modal.classList.remove('hidden');
  });

  no.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  si.addEventListener('click', async () => {
    modal.classList.add('hidden');
    console.log('Botón SI presionado, enviando fetch a /api/restart-bot');
    try {
      const res = await fetch('/api/restart-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      console.log('Respuesta recibida de /api/restart-bot:', res);
      const data = await res.json();
      console.log('Body de respuesta:', data);
      if (data.success) {
        // Mostrar mensaje y contador regresivo en la página
        let countdown = 45;
        const msgDiv = document.createElement('div');
        msgDiv.style.textAlign = 'center';
        msgDiv.style.marginTop = '2rem';
        msgDiv.innerHTML = `<strong>Reinicio solicitado correctamente.<br>En breve será redireccionado.<br>Redirigiendo en <span id="countdown">${countdown}</span> segundos...</strong>`;
        document.body.appendChild(msgDiv);
        const interval = setInterval(() => {
          countdown--;
          document.getElementById('countdown').textContent = countdown;
          if (countdown <= 0) {
            clearInterval(interval);
            window.location.href = "/";
          }
        }, 1000);
      } else {
        alert('Error al solicitar reinicio: ' + (data.error || 'Error desconocido'));
      }
    } catch (err) {
      console.error('Error en fetch /api/restart-bot:', err);
      alert('Error de red o servidor: ' + err.message);
    }
  });
});
