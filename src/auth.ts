/* Shared-password auth with free-form username (same model as SP Tracker):
   a UI/route guardrail, not identity proof. Two tiers: admin (env allowlist)
   and user (everyone else). */
import type { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { pool, query } from './db.js';

const PgSession = connectPgSimple(session);

export function sessionMiddleware() {
  return session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  });
}

declare module 'express-session' {
  interface SessionData { authed?: boolean; username?: string; }
}

export const normUser = (u: any): string => String(u || '').toLowerCase().replace(/[^a-z]/g, '');
const ADMIN_USERS = new Set((process.env.ADMIN_USERS || 'Troy Steiss').split(',').map(normUser).filter(Boolean));
export const isAdminUser = (u?: string): boolean => !!u && ADMIN_USERS.has(normUser(u));

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session && req.session.authed && req.session.username) return next();
  res.status(401).json({ error: 'unauthorized' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.session && req.session.authed && isAdminUser(req.session.username)) return next();
  res.status(403).json({ error: 'This action is limited to admins' });
}

export async function login(req: Request, res: Response) {
  const { username, password } = req.body || {};
  const expected = process.env.APP_PASSWORD || 'northdakota';
  const user = typeof username === 'string' ? username.trim().slice(0, 60) : '';
  if (!user) return res.status(400).json({ error: 'Username is required' });
  if (!(typeof password === 'string' && password === expected)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  req.session.authed = true;
  req.session.username = user;
  query(
    `insert into app_users(key, display, role, last_seen) values($1,$2,$3,now())
     on conflict (key) do update set display=excluded.display, last_seen=now(), updated_at=now()`,
    [normUser(user), user, isAdminUser(user) ? 'admin' : 'user']
  ).catch(() => {});
  res.json({ ok: true, username: user, isAdmin: isAdminUser(user) });
}

export function logout(req: Request, res: Response) {
  req.session.destroy(() => res.json({ ok: true }));
}

export async function status(req: Request, res: Response) {
  let appTitle = '';
  try { appTitle = (await query<{ app_title: string }>('select app_title from app_meta where id=1')).rows[0]?.app_title || ''; } catch {}
  const authed = !!(req.session && req.session.authed && req.session.username);
  res.json({
    authed,
    username: authed ? req.session.username : '',
    isAdmin: authed ? isAdminUser(req.session.username) : false,
    appTitle,
  });
}
