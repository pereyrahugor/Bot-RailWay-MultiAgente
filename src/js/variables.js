document.addEventListener('DOMContentLoaded', async () => {
    console.log('Variables panel loaded');

    const cancelBtn = document.getElementById('cancel-btn');
    const variablesForm = document.getElementById('variables-form');
    const updateBtn = document.getElementById('update-btn');

    let initialVariables = {};

    // Cargar variables actuales
    async function loadVariables() {
        try {
            const response = await fetch('/api/variables');
            const data = await response.json();

            if (data.success && data.variables) {
                initialVariables = data.variables;
                // Poblar el formulario
                Object.keys(initialVariables).forEach(key => {
                    const input = document.getElementById(key) || document.getElementsByName(key)[0];
                    if (input) {
                        input.value = initialVariables[key];
                    }
                });
            } else {
                alert('Error al cargar variables: ' + (data.error || 'Error desconocido'));   
            }
        } catch (err) {
            console.error('Error fetching variables:', err);
            alert('Error de conexión al obtener variables.');
        }
    }

    await loadVariables();

    // Lógica para mostrar/ocultar contraseñas
    document.querySelectorAll('.toggle-password').forEach(button => {
        button.addEventListener('click', () => {
            const wrapper = button.closest('.input-wrapper');
            const input = wrapper.querySelector('input, textarea');

            if (input.tagName.toLowerCase() === 'input') {
                const type = input.getAttribute('type') === 'password' ? 'text' : 'password'; 
                input.setAttribute('type', type);
            } else {
                // Para textarea (GOOGLE_PRIVATE_KEY)
                input.classList.toggle('hidden-content');
            }

            // Cambiar el icono (opcional)
            button.textContent = button.textContent === '👁️' ? '🙈' : '👁️';
        });
    });

    // Botón Cancelar: vuelve al dashboard
    cancelBtn.addEventListener('click', () => {
        window.location.href = '/dashboard';
    });

    // Manejo del formulario
    variablesForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData(variablesForm);
        const changedVariables = {};
        const changedKeys = [];

        formData.forEach((value, key) => {
            // Solo agregar si el valor es diferente al inicial
            if (value !== initialVariables[key]) {
                changedVariables[key] = value;
                changedKeys.push(key);
            }
        });

        if (changedKeys.length === 0) {
            alert('No se detectaron cambios en las variables.');
            return;
        }

        const confirmMsg = `Se han modificado las siguientes variables:\n\n${changedKeys.join('\n')}\n\nEl bot se reiniciará automáticamente para aplicar los cambios. ¿Deseas continuar?`;                                                                                            
        if (!confirm(confirmMsg)) {
            return;
        }

        updateBtn.disabled = true;
        updateBtn.textContent = 'Actualizando...';

        try {
            const response = await fetch('/api/update-variables', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ variables: changedVariables })
            });

            const data = await response.json();

            if (data.success) {
                alert('✅ Variables actualizadas correctamente. El bot se está reiniciando...');
                // Redirigir al dashboard después de un momento
                setTimeout(() => {
                    window.location.href = '/dashboard';
                }, 3000);
            } else {
                alert('❌ Error: ' + (data.error || 'Error desconocido'));
                updateBtn.disabled = false;
                updateBtn.textContent = 'Actualizar y Reiniciar';
            }
        } catch (err) {
            console.error('Error updating variables:', err);
            alert('Error de conexión al actualizar variables.');
            updateBtn.disabled = false;
            updateBtn.textContent = 'Actualizar y Reiniciar';
        }
    });
});
