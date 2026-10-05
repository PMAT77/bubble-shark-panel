const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'streamticket',
  'refresh_token',
  'refreshtoken',
  'password',
  'newpassword',
  'challengeanswer',
  'authorization',
  'apikey',
  'api_key',
  'secret',
])

/** Returns a request URL that is safe to include in application logs. */
export function sanitizeRequestUrlForLog(requestUrl: string): string {
  try {
    const url = new URL(requestUrl, 'http://bubblesharkpanel.local')
    for (const [key] of url.searchParams) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    return `${url.pathname}${url.search}`
  }
  catch {
    return requestUrl
  }
}
