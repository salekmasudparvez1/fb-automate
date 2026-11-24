import type { Request, Response } from 'express';
import { createServerApp } from '../server.ts';

let appPromise: ReturnType<typeof createServerApp> | null = null;

export default async function handler(req: Request, res: Response) {
  if (!appPromise) {
    appPromise = createServerApp({ standalone: false });
  }
  const app = await appPromise;
  return app(req, res);
}
