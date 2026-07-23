function setNavState() {
  const nav = document.querySelector('.site-nav');
  nav?.classList.toggle('is-scrolled', window.scrollY > 24);
}

async function validateInvite(inviteInput, inviteButton) {
  const code = inviteInput?.value.trim();
  if (!code || !inviteButton) return;
  const originalText = inviteButton.textContent;
  inviteButton.textContent = 'Checking';
  inviteButton.disabled = true;
  try {
    const response = await fetch('/api/validate-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const { valid, redirect } = await response.json();
    if (valid) {
      window.location.href = redirect || '/contact';
      return;
    }
    inviteInput.value = '';
    inviteInput.placeholder = 'Code not recognized';
  } catch {
    inviteInput.placeholder = 'Unable to validate';
  } finally {
    inviteButton.textContent = originalText;
    inviteButton.disabled = false;
  }
}

function controlledRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hydrateFormFields() {
  document.querySelectorAll('[data-source-page-url]').forEach((field) => { field.value = window.location.href; });
  document.querySelectorAll('[data-submission-nonce]').forEach((field) => {
    if (!field.value) field.value = controlledRandomId();
  });
}

function attachAccessFormHandlers() {
  document.querySelectorAll('[data-access-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      hydrateFormFields();
      const error = form.querySelector('.form-error');
      if (!form.reportValidity()) {
        if (error) error.textContent = 'Please complete all required fields and acknowledge the required terms before submitting.';
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      const original = button?.textContent || '';
      if (button) { button.disabled = true; button.textContent = 'Submitting'; }
      try {
        const response = await fetch(form.action, { method: 'POST', body: new FormData(form), credentials: 'same-origin' });
        const payload = await response.json();
        if (!response.ok || !payload.accepted) throw new Error(payload.error || 'Submission could not be accepted.');
        window.location.href = payload.redirect || '/thank-you';
      } catch (submitError) {
        if (error) error.textContent = submitError.message || 'Submission could not be accepted.';
        if (button) { button.disabled = false; button.textContent = original; }
      }
    });
  });
}

function initializeIntelligenceReveal() {
  const intelligenceSection = document.querySelector('.intelligence-field-section');
  if (intelligenceSection && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) intelligenceSection.classList.add('is-visible');
      });
    }, { threshold: 0.22 });
    observer.observe(intelligenceSection);
  } else {
    intelligenceSection?.classList.add('is-visible');
  }
}

setNavState();
window.addEventListener('scroll', setNavState, { passive: true });

const inviteInput = document.getElementById('invite-code');
const inviteButton = document.getElementById('invite-submit');
inviteButton?.addEventListener('click', () => validateInvite(inviteInput, inviteButton));
inviteInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') validateInvite(inviteInput, inviteButton); });

hydrateFormFields();
attachAccessFormHandlers();
initializeIntelligenceReveal();
