const request = require('supertest');

jest.mock('../services/redisClient', () => ({
  isRedisEnabled: () => false,
  getJson: jest.fn(),
  setJson: jest.fn(),
  DEFAULT_CACHE_TTL_SECONDS: 300
}));

const app = require('../index');

describe('root route availability', () => {
  it('serves the SPA shell at /', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="app"></div>');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('serves carwatch helper page', async () => {
    const res = await request(app).get('/carwatch-helper');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await request(app).get('/definitely-not-real');
    expect(res.status).toBe(404);
  });
});
