import type {
  ApiError, CreateRoomRequest, CreateRoomResponse, GetRoomResponse,
} from '@pointe/shared';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError; status: number };

async function readError(res: Response, status: number): Promise<ApiResult<never>> {
  try {
    const body = (await res.json()) as ApiError;
    return { ok: false, error: body, status };
  } catch {
    return { ok: false, error: { code: 'UNKNOWN', message: res.statusText || 'Request failed' }, status };
  }
}

export async function createRoom(req: CreateRoomRequest): Promise<ApiResult<CreateRoomResponse>> {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    credentials: 'same-origin',
  });
  if (!res.ok) return readError(res, res.status);
  return { ok: true, data: (await res.json()) as CreateRoomResponse };
}

export async function getRoom(slug: string): Promise<ApiResult<GetRoomResponse>> {
  const res = await fetch(`/api/rooms/${slug}`, { credentials: 'same-origin' });
  if (!res.ok) return readError(res, res.status);
  return { ok: true, data: (await res.json()) as GetRoomResponse };
}

/** Build the WS URL for a slug from the current page origin. wss in prod, ws in dev. */
export function buildWsUrl(slug: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/rooms/${slug}/ws`;
}
