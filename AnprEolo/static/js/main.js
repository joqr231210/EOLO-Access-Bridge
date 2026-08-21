function addRow() {
  const table = document.getElementById("camera-table-body");
  const rowCount = table.rows.length + 1;
  const row = document.createElement("tr");

  row.innerHTML = `
    <td><input type="text" name="name_dynamic_${rowCount}" placeholder="Ej. Cámara Nueva" required></td>
    <td><input type="text" name="rtsp_dynamic_${rowCount}" placeholder="rtsp://..." size="60" required></td>
    <td>
      <select name="type_dynamic_${rowCount}">
        <option value="Entrada">Entrada</option>
        <option value="Salida">Salida</option>
      </select>
    </td>
    <td><input type="text" name="prefix_dynamic_${rowCount}" placeholder="ABC" maxlength="3" style="width: 60px; text-transform: uppercase;"></td>
    <td>
      <button type="button" class="btn btn-danger" onclick="deleteRow(this)">
        <i class="ph ph-trash"></i> Eliminar
      </button>
    </td>
  `;

  table.appendChild(row);
  row.style.animation = 'slideInUp 0.3s ease-out';
}

function addBarrierRow() {
  const table = document.getElementById("barrier-table");
  const rowCount = table.rows.length;
  const row = table.insertRow(rowCount);

  // Generar opciones de cámaras
  let camOptions = '<option value="">-- Ninguna --</option>';
  if (typeof cameraNames !== 'undefined') {
    cameraNames.forEach(name => {
      camOptions += `<option value="${name}">${name}</option>`;
    });
  }

  const cells = [
    '<input type="text" name="b_id_dynamic_' + rowCount + '" placeholder="id_barra" required>',
    '<input type="text" name="b_num_dynamic_' + rowCount + '" placeholder="1" required>',
    '<input type="text" name="b_ip_dynamic_' + rowCount + '" placeholder="IP:Puerto" required>',
    '<input type="text" name="b_user_dynamic_' + rowCount + '" placeholder="admin">',
    '<input type="password" name="b_pass_dynamic_' + rowCount + '" placeholder="pass">',
    `<select name="b_cam_dynamic_${rowCount}">${camOptions}</select>`,
    '<button type="button" class="btn btn-danger" onclick="deleteRow(this)"><i class="ph ph-trash"></i> Eliminar</button>'
  ];

  cells.forEach((content, i) => {
    row.insertCell(i).innerHTML = content;
  });

  row.style.animation = 'slideInUp 0.3s ease-out';
}

function deleteRow(btn) {
  const row = btn.parentNode.parentNode;
  row.style.opacity = '0';
  setTimeout(() => row.parentNode.removeChild(row), 300);
}

async function syncPlates() {
  const btn = document.getElementById("btn-sync");
  const status = document.getElementById("sync-status");
  if(!btn || !status) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="ph ph-spinner-gap ph-spin"></i> Sincronizando...';
  status.style.display = "block";
  status.style.color = "var(--text-secondary)";
  status.textContent = "Iniciando sincronización...";

  try {
    const response = await fetch("/sync_plates", { method: "POST" });
    const data = await response.json();

    if (response.ok) {
      status.style.color = "var(--success)";
      status.textContent = "✓ " + data.message;
      setTimeout(() => location.reload(), 2000); // Reload to show new plates
    } else {
      status.style.color = "var(--danger)";
      status.textContent = "✕ Error: " + (data.error || "Desconocido");
    }
  } catch (error) {
    status.style.color = "var(--danger)";
    status.textContent = "✕ Error de conexión: " + error.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Sincronizar de Nube';
  }
}

// Mobile Menu Toggle
document.addEventListener('DOMContentLoaded', () => {
  const mobileBtn = document.getElementById('mobile-menu-btn');
  const sidebar = document.querySelector('.sidebar');

  if(mobileBtn && sidebar) {
    mobileBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
});
