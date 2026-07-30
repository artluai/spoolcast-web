const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Content-Type': 'application/json; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...securityHeaders, ...extraHeaders },
  });
}

export async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(415, 'Content-Type must be application/json.');
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > 1_000_000) {
    throw new ApiError(413, 'Request body is too large.');
  }

  try {
    return await request.json();
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.');
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function errorResponse(error) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  console.error(error);
  return json({ error: 'The board could not complete that request.' }, 500);
}
