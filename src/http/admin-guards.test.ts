/**
 * Admin-panel audit fixes:
 *  - a system form field cannot be deleted, and a required system field cannot be
 *    disabled (both would break request creation);
 *  - the materials catalog GET is reachable for settings.manage (so the admin role,
 *    which manages the catalog, can load it).
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema.js';
import { setupTenant } from '../db/tenant-setup.js';
import { createApp } from '../server/app.js';

const BOT = 'test:token';
const SECRET = 'test-secret-long-enough';

async function make() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  // owner '999' gets the all-permissions 'owner' role (has settings.manage).
  await setupTenant(db, { holdingName: 'Z', ownerTelegramId: '999', ownerName: 'Owner' });
  const app = createApp({ db, botToken: BOT, sessionSecret: SECRET, devAuth: true });
  return { app, db };
}
const login = async (app: any, tg: string): Promise<string> =>
  (await request(app).post('/api/auth/dev').send({ telegramId: tg }).expect(200)).body.token as string;
const sysField = async (app: any, tk: string) => {
  const fields = (await request(app).get('/api/admin/form-fields?screen=request_create').set('Authorization', `Bearer ${tk}`).expect(200)).body as any[];
  const f = fields.find((x) => x.system && x.required);
  expect(f).toBeTruthy();
  return f;
};

describe('admin guards — form fields (FormBuilder audit fix)', () => {
  it('a required system field cannot be deleted (400)', async () => {
    const { app } = await make();
    const tk = await login(app, '999');
    const f = await sysField(app, tk);
    await request(app).delete(`/api/admin/form-fields/${f.id}`).set('Authorization', `Bearer ${tk}`).expect(400);
  });

  it('a required system field cannot be disabled (400), but other edits still work (200)', async () => {
    const { app } = await make();
    const tk = await login(app, '999');
    const f = await sysField(app, tk);
    await request(app).put(`/api/admin/form-fields/${f.id}`).set('Authorization', `Bearer ${tk}`).send({ enabled: false }).expect(400);
    await request(app).put(`/api/admin/form-fields/${f.id}`).set('Authorization', `Bearer ${tk}`).send({ label: f.label }).expect(200);
  });
});

describe('admin guards — materials gate (Materials audit fix)', () => {
  it('GET /materials is reachable with settings.manage (the catalog manager role)', async () => {
    const { app } = await make();
    const tk = await login(app, '999');
    await request(app).get('/api/admin/materials').set('Authorization', `Bearer ${tk}`).expect(200);
  });
});
