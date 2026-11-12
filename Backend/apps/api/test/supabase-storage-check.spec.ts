import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { SupabaseStorageProvider } from '../src/integrations/storage/supabase-storage.provider';

/**
 * The storage self-check, against a real HTTP server rather than a mocked
 * `fetch`.
 *
 * This exists because of a live failure: a technician's upload came back 502,
 * and the only clue in the log was Supabase's own
 * `{"statusCode":"500","error":"Internal","message":"Internal Server Error"}`
 * — which names neither the bucket, the project, nor the cause. The deploy
 * had looked healthy for hours.
 *
 * So `check()` asks `GET /bucket/{name}`, which answers differently for each
 * way this goes wrong, and /health/ready reports it. These tests pin that the
 * reason actually tells someone what to change.
 */
describe('SupabaseStorageProvider.check', () => {
  let server: Server;
  let baseUrl: string;
  let respond: (url: string) => { status: number; body: string };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const { status, body } = respond(req.url ?? '');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const provider = (bucket = 'sample-images'): SupabaseStorageProvider =>
    new SupabaseStorageProvider(baseUrl, 'service-role-key', bucket);

  it('asks about the bucket, and writes nothing while doing it', async () => {
    const seen: string[] = [];
    respond = (url) => {
      seen.push(url);
      return { status: 200, body: JSON.stringify({ public: false }) };
    };

    await provider().check();

    expect(seen).toEqual(['/storage/v1/bucket/sample-images']);
  });

  it('passes a private bucket', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ public: false }) });

    await expect(provider().check()).resolves.toEqual({ ok: true, reason: null });
  });

  it('names the missing bucket, and says to create it private', async () => {
    // This is the actual production failure. A 404 here is what the 500 on
    // upload was really telling us.
    respond = () => ({ status: 404, body: '{"error":"not found"}' });

    const result = await provider('sample-images').check();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('sample-images');
    expect(result.reason).toContain('does not exist');
    expect(result.reason).toMatch(/private/i);
  });

  it('distinguishes bad credentials from a missing bucket', async () => {
    for (const status of [401, 403]) {
      respond = () => ({ status, body: '{"message":"Unauthorized"}' });

      const result = await provider().check();

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('service_role');
      // Must NOT send someone hunting for a bucket that exists.
      expect(result.reason).not.toContain('does not exist');
    }
  });

  it('refuses a public bucket, because the images are confidential', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ public: true }) });

    const result = await provider().check();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('PUBLIC');
  });

  it('reports an unreachable project rather than throwing', async () => {
    // A wrong SUPABASE_URL must not take readiness down with an exception.
    const unreachable = new SupabaseStorageProvider(
      'http://127.0.0.1:9',
      'key',
      'sample-images',
    );

    const result = await unreachable.check();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SUPABASE_URL');
  });

  it('never puts the service-role key in the reason', async () => {
    // The reason is surfaced on /health/ready, which is public.
    const secret = 'super-secret-service-role-key';
    const withSecret = new SupabaseStorageProvider(baseUrl, secret, 'nope');
    respond = () => ({ status: 404, body: '{}' });

    const result = await withSecret.check();

    expect(result.reason).not.toContain(secret);
  });

  it('passes an unexpected status through with its body, not a guess', async () => {
    respond = () => ({ status: 418, body: '{"message":"teapot"}' });

    const result = await provider().check();

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('418');
    expect(result.reason).toContain('teapot');
  });
});
