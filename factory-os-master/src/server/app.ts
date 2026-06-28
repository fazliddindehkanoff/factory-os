/** Express app factory (dependency-injected so it can be tested over pglite). */
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response, type NextFunction } from 'express';
import { buildRouter, type RouterDeps } from '../http/routes.js';
import { buildCompatRouter } from '../http/compat.routes.js';
import { legacyAuth } from '../http/legacy-auth.js';
import { mapError } from '../http/errors.js';

export function createApp(deps: RouterDeps) {
  const app = express();
  app.use(express.json({ limit: '4mb' })); // design uploads base64 attachments

  app.get('/healthz', (_req: Request, res: Response) => res.json({ ok: true }));

  if (deps.serveDesign) {
    // Serve the bundled design (public/) and answer its API contract via the compat layer.
    const publicDir = path.resolve('public');
    const hasIndex = fs.existsSync(path.join(publicDir, 'index.html'));
    if (hasIndex) app.use(express.static(publicDir));
    app.use(
      '/api',
      legacyAuth({
        db: deps.db,
        sessionSecret: deps.sessionSecret,
        botToken: deps.botToken,
        devAuth: deps.devAuth ?? false,
      }),
      buildCompatRouter(deps.db, deps.devAuth ?? false),
    );
    app.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));
    if (hasIndex) {
      app.get(/.*/, (_req: Request, res: Response) => res.sendFile(path.join(publicDir, 'index.html')));
    }
  } else {
    // New-shape API + the React Mini App (used by the test suite).
    const webDist = path.resolve('web/dist');
    const hasWeb = fs.existsSync(path.join(webDist, 'index.html'));
    if (hasWeb) app.use(express.static(webDist));
    app.use('/api', buildRouter(deps));
    app.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));
    if (hasWeb) {
      app.get(/.*/, (_req: Request, res: Response) => res.sendFile(path.join(webDist, 'index.html')));
    }
  }

  // Centralized error handler — domain errors → status codes, others → generic 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body } = mapError(err);
    if (status >= 500) console.error('[ERROR]', err);
    res.status(status).json(body);
  });

  return app;
}
