/** RFC 9457 problem+json errors. type is https://hamalert.org/problems/{slug}. */
export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  title: string;
  type: string;
  detail?: string;
  errors?: FieldError[];
  headers?: Record<string, string>;

  constructor(status: number, title: string, opts: {
    type?: string;
    detail?: string;
    errors?: FieldError[];
    headers?: Record<string, string>;
  } = {}) {
    super(opts.detail || title);
    this.status = status;
    this.title = title;
    this.type = opts.type || `https://hamalert.org/problems/${slug(title)}`;
    this.detail = opts.detail;
    this.errors = opts.errors;
    this.headers = opts.headers;
  }
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function problemBody(err: ApiError, instance?: string) {
  return {
    type: err.type,
    title: err.title,
    status: err.status,
    ...(err.detail ? {detail: err.detail} : {}),
    ...(instance ? {instance} : {}),
    ...(err.errors ? {errors: err.errors} : {}),
  };
}

export function badRequest(errors: FieldError[], detail = 'Validation failed'): ApiError {
  return new ApiError(400, 'Bad Request', {
    type: 'https://hamalert.org/problems/validation',
    detail,
    errors,
  });
}

export function unauthorized(detail = 'Missing, expired or revoked token, or wrong credentials'): ApiError {
  return new ApiError(401, 'Unauthorized', {
    type: 'https://hamalert.org/problems/unauthorized',
    detail,
  });
}

export function notFound(detail = 'No such resource in this account'): ApiError {
  return new ApiError(404, 'Not Found', {
    type: 'https://hamalert.org/problems/not-found',
    detail,
  });
}

export function conflict(detail: string): ApiError {
  return new ApiError(409, 'Conflict', {
    type: 'https://hamalert.org/problems/conflict',
    detail,
  });
}

export function tooMany(retryAfter: number, detail = 'Login is paused after too many failures'): ApiError {
  return new ApiError(429, 'Too Many Requests', {
    type: 'https://hamalert.org/problems/rate-limit',
    detail,
    headers: {'retry-after': String(Math.max(1, retryAfter))},
  });
}
