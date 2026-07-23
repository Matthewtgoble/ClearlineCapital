import { getStore } from '@netlify/blobs';
import { getContext } from '@netlify/functions';
import {
  accessCookieName,
  isExplicitLocalDevelopmentFallbackAllowed,
  json,
  readCookie,
  requireSessionSecret,
  sha256,
  thankYouCookieMaxAgeSeconds,
  thankYouCookieName,
  verifySessionCookie,
} from './session-utils.js';

const productionStoreName = 'access-submissions';
const previewStoreName = 'access-submissions-preview';
const operationalFormName = 'clearline-access-request';
const maxNetlifyFormsDeliveryAttempts = 3;
const submissionNoncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const legalAcceptanceText = 'I acknowledge the Privacy Policy and agree to the Terms of Use and Submission Terms. I understand that submitting this form does not create a confidential relationship, transaction commitment, exclusivity, compensation right, or obligation for Clearline Capital to respond or proceed.';

const requiredValues = {
  legal_acceptance_required: 'true',
  privacy_policy_effective_date: '2026-07-22',
  privacy_policy_version: 'CLC-PRIVACY-POLICY-2026-07-22-v1',
  terms_of_use_effective_date: '2026-07-22',
  terms_of_use_version: 'CLC-TERMS-OF-USE-2026-07-22-v1',
  submission_terms_effective_date: '2026-07-22',
  submission_terms_version: 'CLC-SUBMISSION-TERMS-2026-07-22-v1',
  legal_disclosures_effective_date: '2026-07-22',
  legal_disclosures_version: 'CLC-LEGAL-DISCLOSURES-2026-07-22-v1',
  combined_legal_package_version: 'CLC-PUBLIC-WEBSITE-LEGAL-PACKAGE-2026-07-22-v1',
};

const fieldLimits = {
  'full-name': 120,
  name: 120,
  phone: 40,
  email: 160,
  company: 160,
  'referred-by': 160,
  linkedin: 240,
  instagram: 80,
  'x-handle': 80,
  'why-you': 2000,
  context: 2000,
  source_page_url: 500,
  submission_nonce: 36,
};

async function parseSubmission(req) {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    return Object.fromEntries(Array.from(form.entries()).map(([key, value]) => [key, String(value)]));
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const body = await req.text();
    return Object.fromEntries(new URLSearchParams(body));
  }
  if (contentType.includes('application/json')) {
    return await req.json();
  }
  return {};
}

function sanitizeSourcePageUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    ['token', 'code', 'invite', 'invitation', 'invitation_code', 'submission_id', 'email', 'name', 'auth', 'authorization', 'signature', 'secret', 'cookie', 'clearline_access_session'].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch {
    return '';
  }
}

function rejectInvalidSession(status) {
  if (status === 'missing_access_session_secret') {
    return json(
      { accepted: false, error: 'Access temporarily unavailable.', invitation_status: 'unavailable' },
      503
    );
  }

  const responseStatus = status === 'missing' ? 401 : 403;
  return json(
    { accepted: false, error: 'Valid invitation session is required.', invitation_status: status },
    responseStatus
  );
}

function validateLengths(data) {
  for (const [field, limit] of Object.entries(fieldLimits)) {
    if ((data[field] || '').length > limit) {
      return { valid: false, field, limit };
    }
  }
  return { valid: true };
}

function activeRequestContext(handlerContext) {
  if (handlerContext?.deploy) return handlerContext;
  try {
    return getContext();
  } catch {
    return null;
  }
}

function deployMetadata(context) {
  return {
    deploy_id: context?.deploy?.id || '',
    deploy_published: typeof context?.deploy?.published === 'boolean' ? context.deploy.published : null,
  };
}

function resolveRuntime(handlerContext) {
  if (globalThis.__clearlineMockRuntime) return globalThis.__clearlineMockRuntime;

  const requestContext = activeRequestContext(handlerContext);
  const context = requestContext?.deploy?.context || '';
  const metadata = deployMetadata(requestContext);

  if (isExplicitLocalDevelopmentFallbackAllowed()) {
    return {
      valid: true,
      deploy_context: 'local-qa',
      deploy_id: 'local-qa',
      deploy_published: false,
      is_test_submission: true,
      site_url: process.env.URL || 'http://localhost',
      store_name: 'explicit-local-memory',
      local_memory: true,
    };
  }

  if (!context) {
    return { valid: false, status: 'missing_deploy_context' };
  }

  if (context === 'production') {
    return {
      valid: true,
      deploy_context: context,
      ...metadata,
      is_test_submission: false,
      site_url: process.env.URL || '',
      store_name: productionStoreName,
      local_memory: false,
    };
  }

  if (context === 'deploy-preview' || context === 'branch-deploy') {
    return {
      valid: true,
      deploy_context: context,
      ...metadata,
      is_test_submission: true,
      site_url: process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL || '',
      store_name: previewStoreName,
      local_memory: false,
    };
  }

  return { valid: false, status: 'unknown_deploy_context' };
}

function submissionStore(runtime) {
  if (globalThis.__clearlineMockSubmissionStores) return globalThis.__clearlineMockSubmissionStores[runtime.store_name];
  if (globalThis.__clearlineMockSubmissionStore) return globalThis.__clearlineMockSubmissionStore;
  if (runtime.local_memory) return null;
  return getStore(runtime.store_name);
}

async function readStoredRecord(store, submissionId) {
  if (!store?.get) return null;
  try {
    return await store.get(submissionId, { type: 'json' });
  } catch {
    return null;
  }
}

async function writeAuthoritativeRecord(store, submissionId, record, runtime) {
  if (process.env.CLEARLINE_FORCE_STORAGE_FAILURE === 'true') {
    throw new Error('forced storage failure');
  }

  if (runtime.local_memory) {
    globalThis.__clearlineLocalSubmissions ||= new Map();
    if (globalThis.__clearlineLocalSubmissions.has(submissionId)) {
      return {
        record: globalThis.__clearlineLocalSubmissions.get(submissionId),
        created: false,
        storage_status: 'existing_explicit_local_memory_fallback_record',
      };
    }
    globalThis.__clearlineLocalSubmissions.set(submissionId, record);
    return { record, created: true, storage_status: 'explicit_local_memory_fallback' };
  }

  const result = await store.setJSON(submissionId, record, { onlyIfNew: true });
  if (result?.modified === false) {
    const existing = await readStoredRecord(store, submissionId);
    return { record: existing, created: false, storage_status: 'existing_authoritative_record' };
  }
  return { record, created: true, storage_status: 'netlify_blobs' };
}

async function updateAuthoritativeRecord(store, submissionId, record, runtime) {
  if (runtime.local_memory || globalThis.__clearlineLocalSubmissions?.has(submissionId)) {
    globalThis.__clearlineLocalSubmissions.set(submissionId, record);
    return;
  }
  await store.setJSON(submissionId, record);
}

async function keyedDigest(value) {
  const secret = requireSessionSecret();
  if (!secret.valid) throw new Error(secret.status);
  const keyMaterial = new TextEncoder().encode(secret.value);
  const key = await crypto.subtle.importKey('raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deterministicSubmissionId(invitation, data, runtime) {
  const nonce = (data.submission_nonce || '').trim().toLowerCase();
  const fingerprint = await keyedDigest([
    'clearline-access-submission-v2',
    runtime.deploy_context,
    runtime.store_name,
    invitation.session.sid,
    nonce,
    requiredValues.combined_legal_package_version,
  ].join('|'));
  return `clearline-${fingerprint.slice(0, 32)}`;
}

function buildOperationalFormPayload(record) {
  return new URLSearchParams({
    'form-name': operationalFormName,
    internal_submission_id: record.submission_id,
    submitted_at_utc: record.submission_timestamp_utc,
    name: record.submitted_fields.full_name,
    email: record.submitted_fields.email,
    company: record.submitted_fields.company,
    referred_by: record.submitted_fields.referred_by,
    brief_context: record.submitted_fields.context,
    legal_acceptance_value: String(record.legal_acceptance_value),
    privacy_policy_effective_date: record.privacy_policy_effective_date,
    privacy_policy_version: record.privacy_policy_version,
    terms_of_use_effective_date: record.terms_of_use_effective_date,
    terms_of_use_version: record.terms_of_use_version,
    submission_terms_effective_date: record.submission_terms_effective_date,
    submission_terms_version: record.submission_terms_version,
    legal_disclosures_effective_date: record.legal_disclosures_effective_date,
    legal_disclosures_version: record.legal_disclosures_version,
    combined_legal_package_version: record.combined_legal_package_version,
    sanitized_source_page_url: record.source_page_url,
    invitation_status: record.token_validation_status,
  });
}

async function deliverNetlifyFormCopy(req, record) {
  if (globalThis.__clearlineMockNetlifyFormDelivery) {
    return await globalThis.__clearlineMockNetlifyFormDelivery(record);
  }

  const target = new URL('/', req.url);
  const response = await fetch(target.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildOperationalFormPayload(record),
  });

  return {
    ok: response.ok || response.status === 303,
    status: response.status,
    statusText: response.statusText,
  };
}

function structuredLog(event, details) {
  console.log(JSON.stringify({ event, ...details }));
}

export default async (req, context) => {
  if (req.method !== 'POST') return json({ accepted: false, error: 'Method not allowed.' }, 405);

  const data = await parseSubmission(req);

  if (data['bot-field']) {
    return json({ accepted: false, error: 'Submission rejected.' }, 400);
  }

  const runtime = resolveRuntime(context);
  if (!runtime.valid) {
    structuredLog('clearline_submission_context_rejected', { deploy_context_status: runtime.status });
    return json({ accepted: false, error: 'Trusted deploy context is required.', deploy_context_status: runtime.status }, 503);
  }

  const sessionCookie = readCookie(req, accessCookieName);
  const invitation = await verifySessionCookie(sessionCookie);
  if (!invitation.valid) {
    return rejectInvalidSession(invitation.status);
  }

  if (data.legal_acceptance_value !== 'true') {
    return json({ accepted: false, error: 'Legal acceptance is required.' }, 400);
  }

  if (data.legal_acceptance_text !== legalAcceptanceText) {
    return json({ accepted: false, error: 'Legal acceptance text mismatch.' }, 400);
  }

  for (const [field, value] of Object.entries(requiredValues)) {
    if (data[field] !== value) {
      return json({ accepted: false, error: `Required legal field mismatch: ${field}.` }, 400);
    }
  }

  const lengthCheck = validateLengths(data);
  if (!lengthCheck.valid) {
    return json({ accepted: false, error: `Field exceeds maximum length: ${lengthCheck.field}.`, field: lengthCheck.field, max_length: lengthCheck.limit }, 400);
  }

  const requiredFields = ['form-name', 'referred-by'];
  const identityName = data['full-name'] || data.name;
  const contextText = data['why-you'] || data.context;
  if (!identityName || !data.email || !contextText || requiredFields.some((field) => !data[field])) {
    return json({ accepted: false, error: 'Required submission fields are missing.' }, 400);
  }

  if (!submissionNoncePattern.test((data.submission_nonce || '').trim())) {
    return json({ accepted: false, error: 'Valid submission nonce is required.' }, 400);
  }

  const store = submissionStore(runtime);
  const submissionId = await deterministicSubmissionId(invitation, data, runtime);
  const nonceHash = await sha256((data.submission_nonce || '').trim().toLowerCase());
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sourcePageUrl = sanitizeSourcePageUrl(data.source_page_url || req.headers.get('referer') || '');
  const baseRecord = {
    submission_id: submissionId,
    submission_nonce_hash: nonceHash,
    submission_timestamp_utc: now,
    form_name: 'Access',
    authoritative_store: runtime.store_name,
    store_name: runtime.store_name,
    deploy_context: runtime.deploy_context,
    deploy_id: runtime.deploy_id,
    deploy_published: runtime.deploy_published,
    is_test_submission: runtime.is_test_submission,
    site_url: runtime.site_url,
    operational_form_name: operationalFormName,
    submission_route: '/api/access-submit',
    legal_acceptance_required: true,
    legal_acceptance_value: true,
    legal_acceptance_text: legalAcceptanceText,
    legal_acceptance_timestamp_utc: now,
    privacy_policy_effective_date: requiredValues.privacy_policy_effective_date,
    privacy_policy_version: requiredValues.privacy_policy_version,
    terms_of_use_effective_date: requiredValues.terms_of_use_effective_date,
    terms_of_use_version: requiredValues.terms_of_use_version,
    submission_terms_effective_date: requiredValues.submission_terms_effective_date,
    submission_terms_version: requiredValues.submission_terms_version,
    legal_disclosures_effective_date: requiredValues.legal_disclosures_effective_date,
    legal_disclosures_version: requiredValues.legal_disclosures_version,
    combined_legal_package_version: requiredValues.combined_legal_package_version,
    source_page_url: sourcePageUrl,
    invitation_code_present: true,
    invitation_valid: true,
    token_validation_status: invitation.status,
    netlify_forms_delivery_status: 'pending',
    netlify_forms_delivery_attempts: 0,
    netlify_forms_last_status_code: null,
    submitter_ip: req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '',
    user_agent: req.headers.get('user-agent') || '',
    submitted_fields: {
      full_name: data['full-name'] || data.name || '',
      phone: data.phone || '',
      email: data.email || '',
      company: data.company || '',
      referred_by: data['referred-by'] || '',
      linkedin: data.linkedin || '',
      instagram: data.instagram || '',
      x_handle: data['x-handle'] || '',
      context: data['why-you'] || data.context || '',
    },
  };

  let authoritative;
  try {
    authoritative = await writeAuthoritativeRecord(store, submissionId, baseRecord, runtime);
  } catch {
    structuredLog('clearline_submission_storage_failed', { submission_id: submissionId, deploy_context: runtime.deploy_context, store_name: runtime.store_name, storage_status: 'failed_closed' });
    return json({ accepted: false, error: 'Submission storage unavailable.', storage_status: 'failed_closed' }, 503);
  }

  let record = authoritative.record || baseRecord;
  if (!record) {
    structuredLog('clearline_submission_existing_record_unavailable', { submission_id: submissionId, deploy_context: runtime.deploy_context, store_name: runtime.store_name });
    return json({ accepted: false, error: 'Authoritative submission record unavailable.', storage_status: 'failed_closed' }, 503);
  }

  if (record.netlify_forms_delivery_status === 'delivered') {
    return json(
      { accepted: true, redirect: '/thank-you', storage_status: authoritative.storage_status, netlify_forms_delivery_status: 'delivered', idempotent: true },
      200,
      { 'Set-Cookie': `${thankYouCookieName}=${submissionId}; Path=/thank-you; HttpOnly; Secure; SameSite=Lax; Max-Age=${thankYouCookieMaxAgeSeconds}` }
    );
  }

  if ((record.netlify_forms_delivery_attempts || 0) >= maxNetlifyFormsDeliveryAttempts) {
    structuredLog('clearline_submission_forms_delivery_attempt_limit', {
      submission_id: submissionId,
      deploy_context: runtime.deploy_context,
      store_name: runtime.store_name,
      netlify_forms_delivery_status: record.netlify_forms_delivery_status,
      netlify_forms_delivery_attempts: record.netlify_forms_delivery_attempts || 0,
    });
    return json(
      { accepted: true, redirect: '/thank-you', storage_status: authoritative.storage_status, netlify_forms_delivery_status: record.netlify_forms_delivery_status, idempotent: !authoritative.created },
      200,
      { 'Set-Cookie': `${thankYouCookieName}=${submissionId}; Path=/thank-you; HttpOnly; Secure; SameSite=Lax; Max-Age=${thankYouCookieMaxAgeSeconds}` }
    );
  }

  let delivery;
  try {
    delivery = await deliverNetlifyFormCopy(req, record);
  } catch (error) {
    delivery = { ok: false, status: 0, statusText: error?.message || 'delivery failed' };
  }

  record = {
    ...record,
    netlify_forms_delivery_status: delivery.ok ? 'delivered' : 'failed',
    netlify_forms_delivery_attempts: (record.netlify_forms_delivery_attempts || 0) + 1,
    netlify_forms_last_status_code: delivery.status ?? null,
    netlify_forms_last_attempt_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };

  try {
    await updateAuthoritativeRecord(store, submissionId, record, runtime);
  } catch {
    structuredLog('clearline_submission_delivery_status_update_failed', { submission_id: submissionId, deploy_context: runtime.deploy_context, store_name: runtime.store_name, delivery_status: record.netlify_forms_delivery_status });
    return json({ accepted: false, error: 'Submission delivery status could not be recorded.', netlify_forms_delivery_status: 'pending' }, 503);
  }

  structuredLog('clearline_submission_forms_delivery', {
    submission_id: submissionId,
    deploy_context: runtime.deploy_context,
    store_name: runtime.store_name,
    netlify_forms_delivery_status: record.netlify_forms_delivery_status,
    netlify_forms_last_status_code: record.netlify_forms_last_status_code,
    netlify_forms_delivery_attempts: record.netlify_forms_delivery_attempts,
  });

  return json(
    { accepted: true, redirect: '/thank-you', storage_status: authoritative.storage_status, netlify_forms_delivery_status: record.netlify_forms_delivery_status, idempotent: !authoritative.created },
    200,
    { 'Set-Cookie': `${thankYouCookieName}=${submissionId}; Path=/thank-you; HttpOnly; Secure; SameSite=Lax; Max-Age=${thankYouCookieMaxAgeSeconds}` }
  );
};

export const config = { path: '/api/access-submit' };
