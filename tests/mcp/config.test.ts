import { describe, expect, it } from 'vitest';
import { loopbackServiceUrl } from '../../apps/mcp-server/src/config';

describe('MCP service URL policy', () => {
  it('accepts only the IPv4 loopback HTTP service origin', () => {
    expect(loopbackServiceUrl('http://127.0.0.1:1430')).toBe('http://127.0.0.1:1430');
    expect(loopbackServiceUrl('http://localhost:1430/')).toBe('http://127.0.0.1:1430');
  });

  it.each([
    'https://127.0.0.1:1430',
    'http://[::1]:1430',
    'http://example.com:1430',
    'http://127.0.0.1:1430/api',
    'http://127.0.0.1:1430?x=1',
    'http://user:pass@127.0.0.1:1430',
    'http://127.0.0.1',
    'not a url',
  ])('rejects %s', value => {
    expect(() => loopbackServiceUrl(value)).toThrow('PLANNER_SERVICE_URL must be http://127.0.0.1:<port>');
  });
});
