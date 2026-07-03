import { describe, expect, it, vi } from 'vitest';
import { createDestinationMcpHandler } from '../../../src/server/http.js';

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

function mockReq(dest: string) {
  return { params: { dest }, method: 'POST', body: { jsonrpc: '2.0' }, headers: {} };
}

describe('createDestinationMcpHandler', () => {
  const names = ['S4D', 'S4P'];

  it('404s for a destination not on the allowlist and never resolves it', async () => {
    const resolveFactory = vi.fn();
    const handler = createDestinationMcpHandler({ names, resolveFactory });
    const res = mockRes();
    await handler(mockReq('OTHER') as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(String((res.body as { error: string }).error)).toContain('S4D, S4P');
    expect(resolveFactory).not.toHaveBeenCalled();
  });

  it('502s with the reason when destination initialization fails', async () => {
    const resolveFactory = vi.fn(async () => {
      throw new Error('Destination Service returned HTTP 404');
    });
    const handler = createDestinationMcpHandler({ names, resolveFactory });
    const res = mockRes();
    await handler(mockReq('S4D') as never, res as never);
    expect(resolveFactory).toHaveBeenCalledWith('S4D');
    expect(res.statusCode).toBe(502);
    expect(String((res.body as { error: string }).error)).toContain('failed to initialize');
    expect(String((res.body as { error: string }).error)).toContain('404');
  });

  it('resolves the factory for an allowlisted destination and serves the request', async () => {
    // The factory's server.connect throwing a sentinel proves the request
    // reached the MCP-serving path with THIS destination's server factory.
    const sentinel = new Error('sentinel: connect reached');
    const serverFactory = vi.fn(() => ({
      connect: vi.fn(async () => {
        throw sentinel;
      }),
    }));
    const resolveFactory = vi.fn(async () => serverFactory as never);
    const handler = createDestinationMcpHandler({ names, resolveFactory });
    const res = mockRes();
    await handler(mockReq('S4P') as never, res as never);
    expect(resolveFactory).toHaveBeenCalledWith('S4P');
    expect(serverFactory).toHaveBeenCalledTimes(1);
    // serveMcpRequest catches the sentinel and responds 500
    expect(res.statusCode).toBe(500);
  });
});
