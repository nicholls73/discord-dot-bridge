export class RedirectResponseError extends TypeError {
  constructor(readonly status: number) {
    super('Upstream redirect responses are not allowed.');
    this.name = 'RedirectResponseError';
  }
}

export function assertNotRedirectStatus(status: number): void {
  if (status >= 300 && status < 400) throw new RedirectResponseError(status);
}

export async function fetchWithoutRedirect(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetcher(input, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the fixed redirect error if the response body cannot be canceled.
    }
    throw new RedirectResponseError(response.status);
  }
  return response;
}
