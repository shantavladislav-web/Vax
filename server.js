const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'vax.db');
const ADMIN_PASS = process.env.ADMIN_PASS || '148800';
const COLORS = ['#00e5ff','#ff2d78','#7b2fff','#00ff88','#ffb800','#ff6b35','#a8ff3e','#ff3ea8','#00bfff','#ff4500'];
const DEFAULT_GROUPS = [
  { id: 'g_general', name: 'Загальний', emoji: '💬' },
  { id: 'g_games',   name: 'Ігри',      emoji: '🎮' },
  { id: 'g_music',   name: 'Музика',     emoji: '🎵' },
];

let db;
const sessions = new Map(); // userId → { name, color, ws }
const wsToUser = new Map();

// ── INIT DB ───────────────────────────────────────────
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, color TEXT);
    CREATE TABLE IF NOT EXISTS groups_tbl (id TEXT PRIMARY KEY, name TEXT, emoji TEXT DEFAULT '💬', is_default INTEGER DEFAULT 0, created_by TEXT);
    CREATE TABLE IF NOT EXISTS group_members (group_id TEXT, user_id TEXT, PRIMARY KEY(group_id, user_id));
    CREATE TABLE IF NOT EXISTS group_messages (id TEXT PRIMARY KEY, group_id TEXT, from_id TEXT, from_name TEXT, from_color TEXT, text TEXT, image_data TEXT, msg_type TEXT DEFAULT 'text', time TEXT);
    CREATE TABLE IF NOT EXISTS dm_messages (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, from_name TEXT, from_color TEXT, text TEXT, image_data TEXT, msg_type TEXT DEFAULT 'text', time TEXT);
    CREATE TABLE IF NOT EXISTS banned_users (id TEXT PRIMARY KEY);
  `);

  for (const g of DEFAULT_GROUPS) {
    db.run(`INSERT OR IGNORE INTO groups_tbl (id,name,emoji,is_default) VALUES (?,?,?,1)`, [g.id, g.name, g.emoji]);
  }

  saveDb();
}

// Save DB to disk every 30 seconds and after writes
let saveTimer;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) { console.error('DB save error:', e); }
  }, 500);
}

function q(sql, params=[]) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) { console.error('Query error:', sql, e.message); return []; }
}

function run(sql, params=[]) {
  try { db.run(sql, params); saveDb(); } catch(e) { console.error('Run error:', sql, e.message); }
}

function get(sql, params=[]) { return q(sql, params)[0] || null; }

// ── HELPERS ───────────────────────────────────────────
function send(ws, p)    { if (ws?.readyState === 1) ws.send(JSON.stringify(p)); }
function sendTo(uid, p) { const s = sessions.get(uid); if (s?.ws?.readyState === 1) send(s.ws, p); }

function broadcastGroup(gid, p, exUid=null) {
  const msg = JSON.stringify(p);
  q(`SELECT user_id FROM group_members WHERE group_id=?`, [gid]).forEach(({ user_id }) => {
    if (user_id === exUid) return;
    const s = sessions.get(user_id);
    if (s?.ws?.readyState === 1) s.ws.send(msg);
  });
}

function broadcastAll(p, exUid=null) {
  const msg = JSON.stringify(p);
  for (const [uid, s] of sessions)
    if (uid !== exUid && s?.ws?.readyState === 1) s.ws.send(msg);
}

function isOnline(uid) { const s = sessions.get(uid); return !!(s?.ws?.readyState === 1); }

function rowToMsg(r) {
  if (!r) return null;
  return { id: r.id, from: { id: r.from_id, name: r.from_name, color: r.from_color }, text: r.text||undefined, imageData: r.image_data||undefined, msgType: r.msg_type, time: r.time };
}

function getGroupInfo(gid) {
  const g = get(`SELECT * FROM groups_tbl WHERE id=?`, [gid]); if (!g) return null;
  const members = q(`SELECT gm.user_id, u.name, u.color FROM group_members gm LEFT JOIN users u ON u.id=gm.user_id WHERE gm.group_id=?`, [gid])
    .map(r => ({ id: r.user_id, name: r.name, color: r.color, online: isOnline(r.user_id) }));
  const lastRow = get(`SELECT * FROM group_messages WHERE group_id=? ORDER BY time DESC LIMIT 1`, [gid]);
  return { id: g.id, name: g.name, emoji: g.emoji||'💬', isDefault: !!g.is_default, createdBy: g.created_by, memberCount: members.length, members, lastMsg: rowToMsg(lastRow) };
}

function getUserGroups(uid) {
  return q(`SELECT group_id FROM group_members WHERE user_id=?`, [uid]).map(r => getGroupInfo(r.group_id)).filter(Boolean);
}

function allContacts(exUid) {
  return q(`SELECT * FROM users WHERE id!=?`, [exUid]).map(u => ({ id: u.id, name: u.name, color: u.color, online: isOnline(u.id) }));
}

// ── WEBSOCKET ─────────────────────────────────────────
wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const userId = wsToUser.get(ws);
    const sesUser = userId ? sessions.get(userId) : null;

    if (d.type === 'register') {
      const name = String(d.name||'Анонім').slice(0,24).trim();
      const uid  = d.userId || uuidv4().slice(0,12);
      if (get(`SELECT 1 FROM banned_users WHERE id=?`, [uid])) { send(ws, { type:'banned' }); ws.close(); return; }
      const existing = get(`SELECT * FROM users WHERE id=?`, [uid]);
      const color = existing?.color || COLORS[Math.floor(Math.random()*COLORS.length)];
      run(`INSERT OR REPLACE INTO users (id,name,color) VALUES (?,?,?)`, [uid, name, color]);
      for (const g of DEFAULT_GROUPS) run(`INSERT OR IGNORE INTO group_members (group_id,user_id) VALUES (?,?)`, [g.id, uid]);
      sessions.set(uid, { name, color, ws });
      wsToUser.set(ws, uid);
      send(ws, { type:'init', user:{id:uid,name,color}, groups:getUserGroups(uid), contacts:allContacts(uid) });
      broadcastAll({ type:'contact_online', user:{id:uid,name,color,online:true} }, uid);
      return;
    }

    if (!sesUser||!userId) return;
    const user = { id:userId, ...sesUser };

    if (d.type === 'group_msg') {
      const gid = String(d.groupId||'');
      if (!get(`SELECT 1 FROM group_members WHERE group_id=? AND user_id=?`,[gid,userId])) return;
      const text = String(d.text||'').slice(0,4000).trim(); if (!text) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      run(`INSERT INTO group_messages (id,group_id,from_id,from_name,from_color,text,msg_type,time) VALUES (?,?,?,?,?,?,?,?)`,
        [id,gid,userId,user.name,user.color,text,'text',time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, text, msgType:'text', time };
      broadcastGroup(gid, { type:'group_msg', groupId:gid, msg }, userId);
    }

    else if (d.type === 'group_img') {
      const gid = String(d.groupId||'');
      if (!get(`SELECT 1 FROM group_members WHERE group_id=? AND user_id=?`,[gid,userId])) return;
      const img = String(d.imageData||''); if (!img||img.length>7000000) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      run(`INSERT INTO group_messages (id,group_id,from_id,from_name,from_color,image_data,msg_type,time) VALUES (?,?,?,?,?,?,?,?)`,
        [id,gid,userId,user.name,user.color,img,'image',time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, imageData:img, msgType:'image', time };
      broadcastGroup(gid, { type:'group_msg', groupId:gid, msg }, userId);
    }

    else if (d.type === 'dm') {
      const toId = String(d.toId||''); if (!toId||toId===userId) return;
      const text = String(d.text||'').slice(0,4000).trim(); if (!text) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      run(`INSERT INTO dm_messages (id,from_id,to_id,from_name,from_color,text,msg_type,time) VALUES (?,?,?,?,?,?,?,?)`,
        [id,userId,toId,user.name,user.color,text,'text',time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, text, msgType:'text', time };
      send(ws, { type:'dm_msg', dmWith:toId, msg });
      sendTo(toId, { type:'dm_msg', dmWith:userId, msg, fromName:user.name, fromColor:user.color });
    }

    else if (d.type === 'dm_img') {
      const toId = String(d.toId||''); if (!toId||toId===userId) return;
      const img = String(d.imageData||''); if (!img||img.length>7000000) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      run(`INSERT INTO dm_messages (id,from_id,to_id,from_name,from_color,image_data,msg_type,time) VALUES (?,?,?,?,?,?,?,?)`,
        [id,userId,toId,user.name,user.color,img,'image',time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, imageData:img, msgType:'image', time };
      send(ws, { type:'dm_msg', dmWith:toId, msg });
      sendTo(toId, { type:'dm_msg', dmWith:userId, msg, fromName:user.name, fromColor:user.color });
    }

    else if (d.type === 'get_group') {
      const gid = String(d.groupId||'');
      const rows = q(`SELECT * FROM group_messages WHERE group_id=? ORDER BY time DESC LIMIT 100`, [gid]).reverse();
      send(ws, { type:'group_history', groupId:gid, messages:rows.map(rowToMsg), info:getGroupInfo(gid) });
    }

    else if (d.type === 'get_dm') {
      const toId = String(d.toId||'');
      const rows = q(`SELECT * FROM dm_messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY time DESC LIMIT 100`,
        [userId,toId,toId,userId]).reverse();
      send(ws, { type:'dm_history', toId, messages:rows.map(rowToMsg) });
    }

    else if (d.type === 'create_group') {
      const name = String(d.name||'').slice(0,32).trim(); if (!name) return;
      const emoji = String(d.emoji||'💬').slice(0,4);
      const memberIds = Array.isArray(d.members)?d.members:[];
      if (!memberIds.includes(userId)) memberIds.push(userId);
      const gid = 'g_'+uuidv4().slice(0,8);
      run(`INSERT INTO groups_tbl (id,name,emoji,is_default,created_by) VALUES (?,?,?,0,?)`, [gid,name,emoji,userId]);
      memberIds.forEach(uid => { if(get(`SELECT 1 FROM users WHERE id=?`,[uid])) run(`INSERT OR IGNORE INTO group_members (group_id,user_id) VALUES (?,?)`,[gid,uid]); });
      const info = getGroupInfo(gid);
      memberIds.forEach(uid => sendTo(uid, { type:'group_created', group:info }));
    }

    else if (d.type === 'rename_group') {
      const gid = String(d.groupId||'');
      const g = get(`SELECT * FROM groups_tbl WHERE id=?`,[gid]); if (!g||g.is_default) return;
      run(`UPDATE groups_tbl SET name=?,emoji=? WHERE id=?`, [String(d.name||'').slice(0,32)||g.name, String(d.emoji||g.emoji).slice(0,4), gid]);
      broadcastAll({ type:'group_updated', group:getGroupInfo(gid) });
    }

    else if (d.type === 'delete_group') {
      const gid = String(d.groupId||'');
      const g = get(`SELECT * FROM groups_tbl WHERE id=?`,[gid]); if (!g||g.is_default) return;
      const members = q(`SELECT user_id FROM group_members WHERE group_id=?`,[gid]).map(r=>r.user_id);
      run(`DELETE FROM groups_tbl WHERE id=?`,[gid]);
      run(`DELETE FROM group_members WHERE group_id=?`,[gid]);
      run(`DELETE FROM group_messages WHERE group_id=?`,[gid]);
      members.forEach(uid => sendTo(uid, { type:'group_deleted', groupId:gid }));
    }

    else if (d.type === 'typing') {
      if (d.groupId) broadcastGroup(d.groupId, { type:'typing', groupId:d.groupId, userId, name:user.name }, userId);
      else if (d.toId) sendTo(d.toId, { type:'dm_typing', fromId:userId, name:user.name });
    }
  });

  ws.on('close', () => {
    const uid = wsToUser.get(ws);
    if (uid) { const s=sessions.get(uid); if(s) s.ws=null; broadcastAll({ type:'contact_offline', userId:uid }, uid); wsToUser.delete(ws); }
  });
});

// ── ADMIN ─────────────────────────────────────────────
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));

app.post('/api/admin/login', (req,res) => {
  req.body.password===ADMIN_PASS ? res.json({ok:true}) : res.status(403).json({ok:false});
});

app.post('/api/admin/stats', (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const users = q(`SELECT * FROM users`).map(u=>({id:u.id,name:u.name,color:u.color,online:isOnline(u.id),banned:!!get(`SELECT 1 FROM banned_users WHERE id=?`,[u.id])}));
  const grps  = q(`SELECT * FROM groups_tbl`).map(g=>({
    id:g.id, name:g.name, emoji:g.emoji, isDefault:!!g.is_default,
    memberCount: q(`SELECT COUNT(*) as c FROM group_members WHERE group_id=?`,[g.id])[0]?.c||0,
    msgCount:    q(`SELECT COUNT(*) as c FROM group_messages WHERE group_id=?`,[g.id])[0]?.c||0,
  }));
  res.json({ ok:true, stats:{ onlineCount:[...sessions.values()].filter(s=>s.ws?.readyState===1).length, totalUsers:users.length, groupCount:grps.length, users, groups:grps }});
});

app.post('/api/admin/ban', (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const uid=req.body.userId;
  run(`INSERT OR IGNORE INTO banned_users (id) VALUES (?)`,[uid]);
  const s=sessions.get(uid); if(s?.ws){send(s.ws,{type:'banned'});s.ws.close();}
  broadcastAll({type:'contact_offline',userId:uid});
  res.json({ok:true});
});

app.post('/api/admin/unban', (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  run(`DELETE FROM banned_users WHERE id=?`,[req.body.userId]);
  res.json({ok:true});
});

app.post('/api/admin/delete-group', (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const gid=req.body.groupId;
  const members=q(`SELECT user_id FROM group_members WHERE group_id=?`,[gid]).map(r=>r.user_id);
  run(`DELETE FROM groups_tbl WHERE id=?`,[gid]);
  run(`DELETE FROM group_members WHERE group_id=?`,[gid]);
  run(`DELETE FROM group_messages WHERE group_id=?`,[gid]);
  members.forEach(uid=>sendTo(uid,{type:'group_deleted',groupId:gid}));
  res.json({ok:true});
});

app.post('/api/admin/rename-group', (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const g=get(`SELECT * FROM groups_tbl WHERE id=?`,[req.body.groupId]); if(!g) return res.status(404).json({ok:false});
  run(`UPDATE groups_tbl SET name=? WHERE id=?`,[String(req.body.name||'').slice(0,32)||g.name, req.body.groupId]);
  broadcastAll({type:'group_updated',group:getGroupInfo(req.body.groupId)});
  res.json({ok:true});
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  server.listen(PORT, () => console.log(`VAX v3 running on port ${PORT}`));
});
