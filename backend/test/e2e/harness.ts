import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Black-box e2e: the tests talk HTTP to the real compiled server.
 *
 * Booting Nest inside Vitest is not an option — Vitest transforms with esbuild, which does not
 * implement emitDecoratorMetadata, so every constructor injection would resolve to undefined.
 * (That is the same reason `npm run start:dev` goes through the Nest CLI and not tsx.) Running
 * `dist/main.js` also gets the Fastify plugins, the global pipes and the exception filter into
 * the picture, which an in-process Nest instance would only partly exercise.
 */
const PORT = Number(process.env['E2E_PORT'] ?? 3101);
export const API = `http://127.0.0.1:${PORT}/api`;

let server: ChildProcess | undefined;

export async function startServer(): Promise<void> {
  server = spawn('node', ['dist/main.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DEMO_MODE: 'true',
      // The suite logs in a few hundred times from one address. The limit is verified by a unit
      // test over the guard itself, which is where a fixed-window counter belongs.
      THROTTLE_LOGIN_MAX: '100000',
      DATABASE_URL: process.env['DATABASE_URL_TEST'] ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  server.stdout?.on('data', (c: Buffer) => logs.push(c.toString()));
  server.stderr?.on('data', (c: Buffer) => logs.push(c.toString()));

  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`server exited with ${server.exitCode}:\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${API}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await delay(200);
  }
  throw new Error(`server did not become ready:\n${logs.join('')}`);
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  server.kill('SIGTERM');
  for (let i = 0; i < 25 && server.exitCode === null; i++) await delay(100);
  if (server.exitCode === null) server.kill('SIGKILL');
  server = undefined;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

/** Minimal client that keeps one cookie jar, so refresh rotation is observable. */
export class ApiClient {
  private cookies = new Map<string, string>();
  accessToken?: string;

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.accessToken) headers['authorization'] = `Bearer ${this.accessToken}`;
    if (this.cookies.size) {
      headers['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (eq > 0) this.cookies.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }

    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : undefined) as T,
      headers: response.headers,
    };
  }

  get = <T = unknown>(path: string) => this.request<T>('GET', path);
  post = <T = unknown>(path: string, body?: unknown) => this.request<T>('POST', path, body);
  put = <T = unknown>(path: string, body?: unknown) => this.request<T>('PUT', path, body);
  patch = <T = unknown>(path: string, body?: unknown) => this.request<T>('PATCH', path, body);
  delete = <T = unknown>(path: string, body?: unknown) => this.request<T>('DELETE', path, body);

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  /** Logs in and keeps the access token for subsequent calls. */
  async login(username: string, password = 'demo'): Promise<ApiResponse<{ accessToken: string }>> {
    const response = await this.post<{ accessToken: string }>('/auth/login', { username, password });
    if (response.status < 300) this.accessToken = response.body.accessToken;
    return response;
  }
}
