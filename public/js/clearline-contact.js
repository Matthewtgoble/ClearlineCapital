function controlledRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function removeSensitiveUrlParams() {
  const url = new URL(window.location.href);
  const sensitiveParams = ['token', 'code', 'invite', 'invitation', 'invitation_code', 'submission_id', 'email', 'name', 'auth', 'authorization', 'signature', 'secret', 'cookie', 'clearline_access_session'];
  let changed = false;
  for (const key of sensitiveParams) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

function hydrateFormFields() {
  const safeUrl = window.location.href;
  document.querySelectorAll('[data-source-page-url]').forEach((field) => { field.value = safeUrl; });
  document.querySelectorAll('[data-submission-nonce]').forEach((field) => {
    if (!field.value) field.value = controlledRandomId();
  });
}

async function validateAccessSession() {
  const overlay = document.getElementById('fade-overlay');
  try {
    const response = await fetch('/api/validate-token', { method: 'POST', credentials: 'same-origin' });
    const { valid } = await response.json();
    if (!valid) {
      overlay?.classList.add('visible');
      setTimeout(() => window.location.replace('/'), 250);
    }
  } catch {
    window.location.replace('/');
  }
}

function attachSubmitHandler() {
  const form = document.querySelector('[data-access-form]');
  if (!form) return;

  form.addEventListener('submit', async function handleSubmit(event) {
    event.preventDefault();
    hydrateFormFields();

    const error = this.querySelector('.form-error');
    if (!this.reportValidity()) {
      if (error) error.textContent = 'Please complete all required fields and acknowledge the required terms before submitting.';
      return;
    }

    const button = this.querySelector('button[type="submit"]');
    const original = button?.textContent || '';
    if (button) { button.disabled = true; button.textContent = 'Submitting'; }

    try {
      const response = await fetch(this.action, { method: 'POST', body: new FormData(this), credentials: 'same-origin' });
      const payload = await response.json();
      if (!response.ok || !payload.accepted) throw new Error(payload.error || 'Submission could not be accepted.');
      window.location.href = payload.redirect || '/thank-you';
    } catch (submitError) {
      if (error) error.textContent = submitError.message || 'Submission could not be accepted.';
      if (button) { button.disabled = false; button.textContent = original; }
    }
  });
}

removeSensitiveUrlParams();
hydrateFormFields();
attachSubmitHandler();
validateAccessSession();
