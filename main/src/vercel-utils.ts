import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export type VercelRequestLike = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
};

export type VercelResponseLike = ServerResponse<IncomingMessage> & {
  json(payload: unknown): void;
  send(payload: unknown): void;
  status(code: number): VercelResponseLike;
};

export function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function getRequestUrl(req: Pick<VercelRequestLike, "headers" | "url">): URL {
  const protocol = getHeaderValue(req.headers["x-forwarded-proto"]) ?? "http";
  const host = req.headers.host ?? "localhost";
  return new URL(req.url ?? "/", `${protocol}://${host}`);
}

export async function readRawBody(req: VercelRequestLike): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (req.body instanceof Uint8Array) {
    return Buffer.from(req.body);
  }

  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }

  if (req.body && typeof req.body === "object") {
    return Buffer.from(JSON.stringify(req.body));
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export async function readJsonBody<T>(req: VercelRequestLike): Promise<T> {
  const raw = await readRawBody(req);
  return JSON.parse(raw.toString("utf8")) as T;
}

export async function readFormData(req: VercelRequestLike): Promise<FormData> {
  const raw = await readRawBody(req);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(key, entry));
      continue;
    }

    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const request = new Request(getRequestUrl(req), {
    method: req.method ?? "POST",
    headers,
    body: new Uint8Array(raw),
  });

  return request.formData();
}

export function sendJson(res: VercelResponseLike, statusCode: number, payload: unknown): void {
  res.status(statusCode).json(payload);
}

export function sendMethodNotAllowed(
  res: VercelResponseLike,
  allowed: string,
  method: string | undefined,
): void {
  res.setHeader("Allow", allowed);
  sendJson(res, 405, {
    message: `Method ${method ?? "UNKNOWN"} is not allowed`,
  });
}
