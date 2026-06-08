/* ════════════════════════════════════════════════════
   MIXDM Frontend — safety.js
   Safety Warning Modal and confirmation logic
   ════════════════════════════════════════════════════ */

// ── Safety Confirmation Modal ──────────────────────────────
function showSafetyWarning(message) {
  return new Promise((resolve) => {
    const overlay = $('safety-modal-overlay');
    const msgEl = $('safety-modal-message');
    const btnCancel = $('safety-btn-cancel');
    const btnConfirm = $('safety-btn-confirm');

    msgEl.textContent = t('safety_message', message);
    overlay.classList.add('show');

    const cleanup = (value) => {
      overlay.classList.remove('show');
      btnCancel.removeEventListener('click', onCancel);
      btnConfirm.removeEventListener('click', onConfirm);
      resolve(value);
    };

    const onCancel = () => cleanup(false);
    const onConfirm = () => cleanup(true);

    btnCancel.addEventListener('click', onCancel);
    btnConfirm.addEventListener('click', onConfirm);
  });
}
