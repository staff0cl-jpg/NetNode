type TranslateFn = (key: string) => string;

const redactText = (value: unknown, fallback = 'Unknown error') =>
  String(value || fallback)
    .replace(/(password|community|secret|token|passphrase)\s*[:=]\s*[^,\s;]+/gi, '$1=<redacted>')
    .replace(/(ssh:\/\/[^:\s]+:)[^@\s]+@/gi, '$1<redacted>@')
    .slice(0, 500);

const detailToText = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return redactText(value.message);
  if (typeof value === 'object') {
    const payload = value as Record<string, unknown>;
    return redactText(payload.error || payload.message || payload.detail || '');
  }
  return redactText(value);
};

const isTimeoutLike = (text: string, httpStatus?: number, detail?: unknown) => {
  if (httpStatus === 504 || httpStatus === 408) return true;
  const lower = text.toLowerCase();
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('gateway_timeout') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('ecconn') ||
    lower.includes('etimedout') ||
    lower.includes('aborterror')
  ) {
    return true;
  }
  if (detail && typeof detail === 'object') {
    const payload = detail as Record<string, unknown>;
    const code = String(payload.code || '').toLowerCase();
    if (code === 'gateway_timeout' || code.includes('timeout')) return true;
  }
  return false;
};

export const readApiPayload = async (response: Response, fallback: string) => {
  const raw = await response.text();
  const contentType = response.headers.get('content-type') || '';
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const looksLikeHtml = /text\/html/i.test(contentType) || /^\s*<!doctype html/i.test(raw) || /^\s*<html/i.test(raw);
    if (looksLikeHtml) {
      if (response.status === 504) {
        return {
          error: 'Gateway timeout from proxy',
          detail: 'The backend task took too long for the reverse proxy timeout.',
          source: 'proxy',
          code: 'gateway_timeout',
        };
      }
      return {
        error: 'Unexpected HTML error response from proxy',
        source: 'proxy',
        code: 'proxy_html_error',
      };
    }
    return { error: redactText(raw, fallback) };
  }
};

export const friendlyErrorMessage = (args: {
  t: TranslateFn;
  httpStatus?: number;
  detail?: unknown;
  fallbackKey?: string;
}) => {
  const { t, httpStatus, detail, fallbackKey = 'friendlyErrorGeneric' } = args;
  const text = detailToText(detail);
  const lower = text.toLowerCase();

  if (httpStatus === 401) return t('friendlyErrorAuthSignin');
  if (httpStatus === 403) return t('friendlyErrorAuthForbidden');

  if (httpStatus === 409 && lower.includes('discovery') && lower.includes('already') && lower.includes('progress')) {
    return t('friendlyErrorDiscoveryAlreadyRunning');
  }

  if (isTimeoutLike(lower, httpStatus, detail)) {
    return t('friendlyErrorNetworkTimeout');
  }

  return t(fallbackKey);
};

export const logTechnicalError = (context: string, detail: unknown, httpStatus?: number) => {
  if (httpStatus) {
    console.error(`${context} (http ${httpStatus})`, detail);
    return;
  }
  console.error(context, detail);
};
