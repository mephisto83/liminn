import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { TransferServer, ReceivedText, ReceivedFile } from '../server';

describe('TransferServer HTTP API', () => {
  let server: TransferServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new TransferServer();
    const port = await server.start(0); // ephemeral
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.stop();
  });

  describe('GET /api/ping', () => {
    it('responds 200 with ok', async () => {
      const res = await request(baseUrl).get('/api/ping');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('POST /api/text', () => {
    it('accepts a valid message and invokes onTextReceived with normalized item', async () => {
      const received: ReceivedText[] = [];
      server.onText((item) => received.push(item));

      const res = await request(baseUrl)
        .post('/api/text')
        .send({ from: 'alice-host', text: 'hello world' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        from: 'alice-host',
        text: 'hello world',
      });
      expect(received[0].id).toMatch(/^txt-/);
      expect(received[0].timestamp).toBeGreaterThan(0);
      expect(received[0].fromId).toBeUndefined();
    });

    it('forwards fromId when the sender provides one', async () => {
      const received: ReceivedText[] = [];
      server.onText((item) => received.push(item));

      await request(baseUrl)
        .post('/api/text')
        .send({ from: 'alice-host', fromId: 'alice-machine-uuid', text: 'tagged' })
        .set('Content-Type', 'application/json');

      expect(received[0].fromId).toBe('alice-machine-uuid');
    });

    it('treats an empty-string fromId as absent rather than a valid id', async () => {
      const received: ReceivedText[] = [];
      server.onText((item) => received.push(item));

      await request(baseUrl)
        .post('/api/text')
        .send({ from: 'alice-host', fromId: '', text: 'empty id' })
        .set('Content-Type', 'application/json');

      expect(received[0].fromId).toBeUndefined();
    });

    it('rejects a request with no text body with 400', async () => {
      const received: ReceivedText[] = [];
      server.onText((item) => received.push(item));

      const res = await request(baseUrl)
        .post('/api/text')
        .send({ from: 'alice-host' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
      expect(received).toHaveLength(0);
    });

    it('defaults missing from field to "Unknown"', async () => {
      const received: ReceivedText[] = [];
      server.onText((item) => received.push(item));

      await request(baseUrl)
        .post('/api/text')
        .send({ text: 'anonymous message' })
        .set('Content-Type', 'application/json');

      expect(received[0].from).toBe('Unknown');
    });

    it('still responds 200 even if no onText callback is set (does not throw)', async () => {
      // No server.onText() — simulates a race where HTTP arrives before listener setup
      const res = await request(baseUrl)
        .post('/api/text')
        .send({ from: 'x', text: 'y' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/file', () => {
    it('rejects a request with no file attached with 400', async () => {
      const received: ReceivedFile[] = [];
      server.onFile((item) => received.push(item));

      const res = await request(baseUrl)
        .post('/api/file')
        .field('from', 'alice-host');

      expect(res.status).toBe(400);
      expect(received).toHaveLength(0);
    });

    it('accepts an uploaded file and invokes onFileReceived', async () => {
      const received: ReceivedFile[] = [];
      server.onFile((item) => received.push(item));

      // Unique basename avoids collision with prior runs in ~/Liminn Received
      const uniqueName = `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;

      const res = await request(baseUrl)
        .post('/api/file')
        .field('from', 'alice-host')
        .field('fromId', 'alice-machine-uuid')
        .attach('file', Buffer.from('file contents here'), uniqueName);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        from: 'alice-host',
        fromId: 'alice-machine-uuid',
        filename: uniqueName,
        size: Buffer.from('file contents here').length,
      });
    });
  });
});
