import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { db, id, now } from './db.js';

export const COOKIE = 'ow_session';
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'development-session-secret';
const ttl = 60 * 60 * 24 * 7;

function hashPassword(password: string) {
 const salt = crypto.randomBytes(16).toString('hex');
 const hash = crypto.scryptSync(password, salt, 64).toString('hex');
 return `${salt}:${hash}`;
}
function verifyPassword(password: string, stored: string) {
 const [salt, expected] = stored.split(':');
 const actual = crypto.scryptSync(password, salt, 64).toString('hex');
 return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function verifySignedValue(value: string, signature: string) {
 const expected = crypto
   .createHmac('sha256', SESSION_SECRET)
   .update(value)
   .digest('base64')
   .replace(/=+$/, '');
 const actualBuffer = Buffer.from(signature);
 const expectedBuffer = Buffer.from(expected);
 return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function getCookieSessionId(cookies: Record<string, string | undefined>) {
 const signedValue = cookies[COOKIE];
 if (!signedValue?.startsWith('s:')) return null;

 const signatureSeparator = signedValue.lastIndexOf('.');
 if (signatureSeparator < 2) return null;

 const value = signedValue.slice(2, signatureSeparator);
 const signature = signedValue.slice(signatureSeparator + 1);
 if (!value || !signature || !verifySignedValue(value, signature)) return null;

 return value;
}

export function getRequestSessionId(req: Request) {
 return req.signedCookies?.[COOKIE] ?? req.cookies?.[COOKIE] ?? null;
}

export function createUser(email: string, password: string) {
 const userId = id();
 db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)')
   .run(userId, email.toLowerCase(), hashPassword(password), now());
 return userId;
}
export function login(email: string, password: string) {
 const row = db.prepare('SELECT id,password_hash FROM users WHERE email=?').get(email.toLowerCase()) as any;
 if (!row || !verifyPassword(password, row.password_hash)) return null;
 const sessionId = id();
 db.prepare('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sessionId,row.id,now()+ttl,now());
 return sessionId;
}
export function getUser(req: Request) {
 const sid = getRequestSessionId(req);
 if (!sid) return null;
 return getUserBySession(sid);
}
export function getUserBySession(sid: string) {
 const row = db.prepare('SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?').get(sid,now()) as any;
 return row ?? null;
}
export function setSession(res: Response, sessionId: string) {
 res.cookie(COOKIE, sessionId, { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', maxAge:ttl*1000, path:'/', signed: true });
}
export function clearSession(req: Request, res: Response) {
 const sid = getRequestSessionId(req);
 if (sid) db.prepare('DELETE FROM sessions WHERE id=?').run(sid);
 res.clearCookie(COOKIE, { httpOnly:true, sameSite:'lax', secure:process.env.NODE_ENV==='production', path:'/' });
}
