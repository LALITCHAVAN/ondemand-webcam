import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { parse as parseCookie } from 'cookie';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { z } from 'zod';
import { db, hashToken, id, logEvent, now, randomToken } from './db.js';
import { clearSession, createUser, getCookieSessionId, getUser, getUserBySession, login, setSession, COOKIE } from './auth.js';

const PORT = Number(process.env.PORT ?? 3000);
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173';
const TTL = Number(process.env.VIEWER_TOKEN_TTL_SECONDS ?? 3600);
const app = express();
const server = http.createServer(app);

app.use(helmet({ crossOriginResourcePolicy:false }));
app.use(cors({ origin: ORIGIN, credentials:true }));
app.use(express.json({ limit:'32kb' }));
app.use(cookieParser(process.env.SESSION_SECRET ?? 'development-session-secret'));
const apiLimit = rateLimit({ windowMs:Number(process.env.RATE_LIMIT_WINDOW_MS??60000), max:Number(process.env.RATE_LIMIT_MAX??30), standardHeaders:true, legacyHeaders:false });
app.use('/api', apiLimit);

const authRequired = (req:any,res:any,next:any) => { const user=getUser(req); if(!user) return res.status(401).json({error:'Authentication required'}); req.user=user; next(); };

app.get('/api/health', (_req,res)=>res.json({ok:true}));
app.post('/api/auth/register', (req,res)=>{
 const parsed=z.object({email:z.string().email(),password:z.string().min(12).max(200)}).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Use a valid email and a password of at least 12 characters.'});
 try { const uid=createUser(parsed.data.email,parsed.data.password); const sid=login(parsed.data.email,parsed.data.password)!; setSession(res,sid); return res.status(201).json({user:{id:uid,email:parsed.data.email.toLowerCase()}}); }
 catch { return res.status(409).json({error:'An account with that email already exists.'}); }
});
app.post('/api/auth/login',(req,res)=>{
 const parsed=z.object({email:z.string().email(),password:z.string().min(1)}).safeParse(req.body);
 if(!parsed.success) return res.status(400).json({error:'Invalid credentials.'});
 const sid=login(parsed.data.email,parsed.data.password); if(!sid) return res.status(401).json({error:'Invalid email or password.'});
 setSession(res,sid); const user=getUserBySession(sid); res.json({user});
});
app.post('/api/auth/logout',(req,res)=>{clearSession(req,res);res.status(204).end();});
app.get('/api/auth/me',(req,res)=>{const user=getUser(req); if(!user)return res.status(401).json({error:'Not signed in'});res.json({user});});

app.get('/api/rooms',authRequired,(req:any,res)=>{
 const rooms=db.prepare('SELECT id,created_at,active,auto_approve FROM rooms WHERE owner_id=? ORDER BY created_at DESC').all(req.user.id);
 res.json({rooms});
});
app.patch('/api/rooms/:roomId/settings',authRequired,(req:any,res)=>{
 const parsed=z.object({autoApprove:z.boolean()}).safeParse(req.body);
 if(!parsed.success)return res.status(400).json({error:'Invalid setting'});
 const room=db.prepare('SELECT id FROM rooms WHERE id=? AND owner_id=?').get(req.params.roomId,req.user.id);
 if(!room)return res.status(404).json({error:'Room not found'});
 db.prepare('UPDATE rooms SET auto_approve=? WHERE id=?').run(parsed.data.autoApprove?1:0,req.params.roomId);
 res.json({autoApprove:parsed.data.autoApprove});
});
app.get('/api/rooms/:roomId/logs',authRequired,(req:any,res)=>{
 const room=db.prepare('SELECT id FROM rooms WHERE id=? AND owner_id=?').get(req.params.roomId,req.user.id);
 if(!room)return res.status(404).json({error:'Room not found'});
 const logs=db.prepare('SELECT event,actor,created_at,metadata FROM access_logs WHERE room_id=? ORDER BY created_at DESC LIMIT 50').all(req.params.roomId);
 res.json({logs});
});

app.post('/api/rooms',authRequired,(req:any,res)=>{
 const roomId=id(); const ts=now();
 db.prepare('INSERT INTO rooms(id,owner_id,created_at) VALUES(?,?,?)').run(roomId,req.user.id,ts);
 const raw=randomToken(); db.prepare('INSERT INTO viewer_tokens(id,room_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(id(),roomId,hashToken(raw),ts+TTL,ts);
 logEvent(roomId,'room_created','owner');
 res.status(201).json({roomId,viewerToken:raw,expiresAt:ts+TTL});
});
app.post('/api/rooms/:roomId/token',authRequired,(req:any,res)=>{
 const room=db.prepare('SELECT id FROM rooms WHERE id=? AND owner_id=? AND active=1').get(req.params.roomId,req.user.id);
 if(!room)return res.status(404).json({error:'Room not found'});
 const raw=randomToken(),ts=now(); db.prepare('INSERT INTO viewer_tokens(id,room_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(id(),req.params.roomId,hashToken(raw),ts+TTL,ts);
 res.json({viewerToken:raw,expiresAt:ts+TTL});
});
app.get('/api/view/:token',(req,res)=>{
 const row=db.prepare('SELECT r.id room_id,r.active,vt.expires_at FROM viewer_tokens vt JOIN rooms r ON r.id=vt.room_id WHERE vt.token_hash=? AND vt.expires_at>?').get(hashToken(req.params.token),now()) as any;
 if(!row || !row.active)return res.status(404).json({error:'Room not found or viewer link expired'});
 res.json({roomId:row.room_id,expiresAt:row.expires_at});
});

const io=new Server(server,{cors:{origin:ORIGIN,credentials:true}});
type SocketState={role:'owner'|'viewer';roomId:string;userId?:string;tokenHash?:string;approved?:boolean};
const sockets=new Map<string,SocketState>();
const ownerByRoom=new Map<string,string>();
const viewerByRoom=new Map<string,string>();

function roomOwner(roomId:string){return db.prepare('SELECT owner_id FROM rooms WHERE id=? AND active=1').get(roomId) as any;}
function tokenValid(roomId:string,tokenHash:string){return !!db.prepare('SELECT 1 FROM viewer_tokens WHERE room_id=? AND token_hash=? AND expires_at>?').get(roomId,tokenHash,now());}

io.use((socket,next)=>{
 const auth=socket.handshake.auth as any;
 const cookies=parseCookie(socket.handshake.headers.cookie ?? '');
 const sessionCookie = getCookieSessionId(cookies);
 if(auth?.role==='owner'){
  const user=getUserBySession(sessionCookie ?? '');
  const room=roomOwner(String(auth.roomId??''));
  if(!user || !room || room.owner_id!==user.id)return next(new Error('Unauthorized owner socket'));
  sockets.set(socket.id,{role:'owner',roomId:auth.roomId,userId:user.id}); ownerByRoom.set(auth.roomId,socket.id); return next();
 }
 if(auth?.role==='viewer'){
  const roomId=String(auth.roomId??''), token=String(auth.token??'');
  if(!roomOwner(roomId) || !tokenValid(roomId,hashToken(token)))return next(new Error('Unauthorized viewer socket'));
  sockets.set(socket.id,{role:'viewer',roomId,tokenHash:hashToken(token),approved:false}); return next();
 }
 next(new Error('Missing socket role'));
});

function targetApprove(viewerId:string){
 const target=sockets.get(viewerId);
 if(!target || target.role!=='viewer')return;
 const ownerId=ownerByRoom.get(target.roomId);
 if(!ownerId || viewerByRoom.get(target.roomId)!==viewerId)return;
 target.approved=true;
 io.to(viewerId).emit('access:approved');
 io.to(ownerId).emit('viewer:auto-approved',{viewerId});
 logEvent(target.roomId,'access_auto_approved','owner');
}

io.on('connection',socket=>{
 const state=sockets.get(socket.id)!;
 if(state.role==='owner') logEvent(state.roomId,'owner_connected','owner');
 if(state.role==='viewer') logEvent(state.roomId,'viewer_connected','viewer');

 socket.on('viewer:request',()=>{
  if(state.role!=='viewer')return;
  const ownerId=ownerByRoom.get(state.roomId);
  if(!ownerId)return socket.emit('access:owner-offline');
  if(viewerByRoom.has(state.roomId) && viewerByRoom.get(state.roomId)!==socket.id)return socket.emit('access:busy');
  viewerByRoom.set(state.roomId,socket.id);
  const roomSettings=db.prepare('SELECT auto_approve FROM rooms WHERE id=?').get(state.roomId) as any;
  io.to(ownerId).emit('viewer:request',{viewerId:socket.id,requestedAt:Date.now(),autoApproved:!!roomSettings?.auto_approve});
  logEvent(state.roomId,'access_requested','viewer');
  if(roomSettings?.auto_approve){ targetApprove(socket.id); } else socket.emit('access:pending');
 });
 socket.on('owner:decision',(payload:{viewerId:string,approved:boolean})=>{
  if(state.role!=='owner')return;
  const target=sockets.get(payload.viewerId);
  if(!target || target.role!=='viewer' || target.roomId!==state.roomId)return;
  if(payload.approved){
   if(viewerByRoom.get(state.roomId)!==payload.viewerId)return;
   target.approved=true; io.to(payload.viewerId).emit('access:approved'); logEvent(state.roomId,'access_approved','owner');
  } else { target.approved=false; io.to(payload.viewerId).emit('access:rejected'); viewerByRoom.delete(state.roomId); logEvent(state.roomId,'access_rejected','owner'); }
 });
 socket.on('owner:signal',(payload:{to:string,data:any})=>{
  if(state.role!=='owner')return; const target=sockets.get(payload.to); if(target?.role==='viewer'&&target.roomId===state.roomId&&target.approved)io.to(payload.to).emit('webrtc:signal',{from:socket.id,data:payload.data});
 });
 socket.on('viewer:signal',(payload:{to:string,data:any})=>{
  if(state.role!=='viewer'||!state.approved)return; const target=sockets.get(payload.to); if(target?.role==='owner'&&target.roomId===state.roomId)io.to(payload.to).emit('webrtc:signal',{from:socket.id,data:payload.data});
 });
 socket.on('owner:camera-state',(payload:{state:string})=>{if(state.role==='owner')io.to(state.roomId).emit('owner:camera-state',{state:payload.state});});
 socket.on('owner:stop',(payload?:{viewerId?:string})=>{
  if(state.role!=='owner')return; const vid=payload?.viewerId??viewerByRoom.get(state.roomId); if(vid){const target=sockets.get(vid); if(target)target.approved=false;io.to(vid).emit('access:revoked');} viewerByRoom.delete(state.roomId); logEvent(state.roomId,'camera_stopped','owner');
 });
 socket.on('viewer:stop',()=>{
  if(state.role!=='viewer')return; state.approved=false; if(viewerByRoom.get(state.roomId)===socket.id)viewerByRoom.delete(state.roomId); const ownerId=ownerByRoom.get(state.roomId); if(ownerId)io.to(ownerId).emit('viewer:stopped',{viewerId:socket.id}); logEvent(state.roomId,'viewer_disconnected','viewer');
 });
 socket.on('disconnect',()=>{
  sockets.delete(socket.id);
  if(state.role==='owner'){
   if(ownerByRoom.get(state.roomId)===socket.id)ownerByRoom.delete(state.roomId);
   const vid=viewerByRoom.get(state.roomId); if(vid){io.to(vid).emit('access:owner-offline');viewerByRoom.delete(state.roomId);}
   logEvent(state.roomId,'owner_disconnected','owner');
  } else {
   if(viewerByRoom.get(state.roomId)===socket.id){viewerByRoom.delete(state.roomId);const oid=ownerByRoom.get(state.roomId);if(oid)io.to(oid).emit('viewer:stopped',{viewerId:socket.id});}
  }
 });
});

const clientDist=path.resolve(process.cwd(),'../client/dist');
if(process.env.NODE_ENV==='production'){
 app.use(express.static(clientDist));
 app.get(/.*/,(req,res)=>{if(req.path.startsWith('/api'))return res.status(404).end();res.sendFile(path.join(clientDist,'index.html'));});
}
server.listen(PORT,()=>console.log(`Server listening on http://localhost:${PORT}`));
