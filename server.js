const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── POSTGRES ───────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function q(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}
async function q1(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0] || null;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, color TEXT
    );
    CREATE TABLE IF NOT EXISTS groups_tbl (
      id TEXT PRIMARY KEY, name TEXT, emoji TEXT DEFAULT '💬',
      is_default BOOLEAN DEFAULT FALSE, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT, user_id TEXT, PRIMARY KEY(group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY, group_id TEXT, from_id TEXT,
      from_name TEXT, from_color TEXT, text TEXT,
      image_data TEXT, msg_type TEXT DEFAULT 'text', time TEXT
    );
    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT,
      from_name TEXT, from_color TEXT, text TEXT,
      image_data TEXT, msg_type TEXT DEFAULT 'text', time TEXT
    );
    CREATE TABLE IF NOT EXISTS banned_users (id TEXT PRIMARY KEY);
  `);

  const defaults = [
    { id: 'g_general', name: 'Загальний', emoji: '💬' },
    { id: 'g_games',   name: 'Ігри',      emoji: '🎮' },
    { id: 'g_music',   name: 'Музика',     emoji: '🎵' },
  ];
  for (const g of defaults) {
    await pool.query(
      `INSERT INTO groups_tbl (id,name,emoji,is_default) VALUES ($1,$2,$3,TRUE) ON CONFLICT (id) DO NOTHING`,
      [g.id, g.name, g.emoji]
    );
  }
  console.log('DB ready');
}

// ── STATE ──────────────────────────────────────────────
const sessions = new Map(); // userId → { name, color, ws }
const wsToUser = new Map();
const COLORS = ['#00e5ff','#ff2d78','#7b2fff','#00ff88','#ffb800','#ff6b35','#a8ff3e','#ff3ea8','#00bfff','#ff4500'];
const ADMIN_PASS = process.env.ADMIN_PASS || '148800';
const DEFAULT_GROUP_IDS = ['g_general', 'g_games', 'g_music'];

function send(ws, p)    { if (ws?.readyState === 1) ws.send(JSON.stringify(p)); }
function sendTo(uid, p) { const s = sessions.get(uid); if (s?.ws?.readyState === 1) send(s.ws, p); }
function isOnline(uid)  { const s = sessions.get(uid); return !!(s?.ws?.readyState === 1); }

async function broadcastGroup(gid, p, exUid = null) {
  const members = await q(`SELECT user_id FROM group_members WHERE group_id=$1`, [gid]);
  const msg = JSON.stringify(p);
  members.forEach(({ user_id }) => {
    if (user_id === exUid) return;
    const s = sessions.get(user_id);
    if (s?.ws?.readyState === 1) s.ws.send(msg);
  });
}

function broadcastAll(p, exUid = null) {
  const msg = JSON.stringify(p);
  for (const [uid, s] of sessions)
    if (uid !== exUid && s?.ws?.readyState === 1) s.ws.send(msg);
}

function rowToMsg(r) {
  if (!r) return null;
  return { id: r.id, from: { id: r.from_id, name: r.from_name, color: r.from_color }, text: r.text||undefined, imageData: r.image_data||undefined, msgType: r.msg_type, time: r.time };
}

async function getGroupInfo(gid) {
  const g = await q1(`SELECT * FROM groups_tbl WHERE id=$1`, [gid]);
  if (!g) return null;
  const members = await q(`SELECT gm.user_id, u.name, u.color FROM group_members gm LEFT JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1`, [gid]);
  const lastRow = await q1(`SELECT * FROM group_messages WHERE group_id=$1 ORDER BY time DESC LIMIT 1`, [gid]);
  return {
    id: g.id, name: g.name, emoji: g.emoji||'💬', isDefault: g.is_default, createdBy: g.created_by,
    memberCount: members.length,
    members: members.map(r => ({ id: r.user_id, name: r.name, color: r.color, online: isOnline(r.user_id) })),
    lastMsg: rowToMsg(lastRow)
  };
}

async function getUserGroups(uid) {
  const rows = await q(`SELECT group_id FROM group_members WHERE user_id=$1`, [uid]);
  const infos = await Promise.all(rows.map(r => getGroupInfo(r.group_id)));
  return infos.filter(Boolean);
}

async function allContacts(exUid) {
  const rows = await q(`SELECT * FROM users WHERE id!=$1`, [exUid]);
  return rows.map(u => ({ id: u.id, name: u.name, color: u.color, online: isOnline(u.id) }));
}

// ── WEBSOCKET ──────────────────────────────────────────
wss.on('connection', ws => {
  ws.on('message', async raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const userId = wsToUser.get(ws);
    const sesUser = userId ? sessions.get(userId) : null;

    // ── REGISTER ──
    if (d.type === 'register') {
      const name = String(d.name||'Анонім').slice(0,24).trim();
      const uid  = d.userId || uuidv4().slice(0,12);
      if (await q1(`SELECT 1 FROM banned_users WHERE id=$1`, [uid])) { send(ws, { type:'banned' }); ws.close(); return; }
      const existing = await q1(`SELECT * FROM users WHERE id=$1`, [uid]);
      const color = existing?.color || COLORS[Math.floor(Math.random()*COLORS.length)];
      await pool.query(`INSERT INTO users (id,name,color) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=$2`, [uid,name,color]);
      for (const gid of DEFAULT_GROUP_IDS) {
        await pool.query(`INSERT INTO group_members (group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [gid,uid]);
      }
      sessions.set(uid, { name, color, ws });
      wsToUser.set(ws, uid);
      send(ws, { type:'init', user:{id:uid,name,color}, groups: await getUserGroups(uid), contacts: await allContacts(uid) });
      broadcastAll({ type:'contact_online', user:{id:uid,name,color,online:true} }, uid);
      return;
    }

    if (!sesUser||!userId) return;
    const user = { id:userId, ...sesUser };

    // ── GROUP MSG ──
    if (d.type === 'group_msg') {
      const gid = String(d.groupId||'');
      if (!await q1(`SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,[gid,userId])) return;
      const text = String(d.text||'').slice(0,4000).trim(); if (!text) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      await pool.query(`INSERT INTO group_messages (id,group_id,from_id,from_name,from_color,text,msg_type,time) VALUES ($1,$2,$3,$4,$5,$6,'text',$7)`,
        [id,gid,userId,user.name,user.color,text,time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, text, msgType:'text', time };
      broadcastGroup(gid, { type:'group_msg', groupId:gid, msg }, userId);
    }

    else if (d.type === 'group_img') {
      const gid = String(d.groupId||'');
      if (!await q1(`SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2`,[gid,userId])) return;
      const img = String(d.imageData||''); if (!img||img.length>7000000) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      await pool.query(`INSERT INTO group_messages (id,group_id,from_id,from_name,from_color,image_data,msg_type,time) VALUES ($1,$2,$3,$4,$5,$6,'image',$7)`,
        [id,gid,userId,user.name,user.color,img,time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, imageData:img, msgType:'image', time };
      broadcastGroup(gid, { type:'group_msg', groupId:gid, msg }, userId);
    }

    else if (d.type === 'dm') {
      const toId = String(d.toId||''); if (!toId||toId===userId) return;
      const text = String(d.text||'').slice(0,4000).trim(); if (!text) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      await pool.query(`INSERT INTO dm_messages (id,from_id,to_id,from_name,from_color,text,msg_type,time) VALUES ($1,$2,$3,$4,$5,$6,'text',$7)`,
        [id,userId,toId,user.name,user.color,text,time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, text, msgType:'text', time };
      sendTo(toId, { type:'dm_msg', dmWith:userId, msg, fromName:user.name, fromColor:user.color });
    }

    else if (d.type === 'dm_img') {
      const toId = String(d.toId||''); if (!toId||toId===userId) return;
      const img = String(d.imageData||''); if (!img||img.length>7000000) return;
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      await pool.query(`INSERT INTO dm_messages (id,from_id,to_id,from_name,from_color,image_data,msg_type,time) VALUES ($1,$2,$3,$4,$5,$6,'image',$7)`,
        [id,userId,toId,user.name,user.color,img,time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, imageData:img, msgType:'image', time };
      sendTo(toId, { type:'dm_msg', dmWith:userId, msg, fromName:user.name, fromColor:user.color });
    }

    else if (d.type === 'get_group') {
      const gid = String(d.groupId||'');
      const rows = await q(`SELECT * FROM group_messages WHERE group_id=$1 ORDER BY time ASC LIMIT 100`, [gid]);
      send(ws, { type:'group_history', groupId:gid, messages:rows.map(rowToMsg), info: await getGroupInfo(gid) });
    }

    else if (d.type === 'get_dm') {
      const toId = String(d.toId||'');
      const rows = await q(`SELECT * FROM dm_messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1) ORDER BY time ASC LIMIT 100`,
        [userId, toId]);
      send(ws, { type:'dm_history', toId, messages:rows.map(rowToMsg) });
    }

    else if (d.type === 'create_group') {
      const name = String(d.name||'').slice(0,32).trim(); if (!name) return;
      const emoji = String(d.emoji||'💬').slice(0,4);
      const memberIds = Array.isArray(d.members)?d.members:[];
      if (!memberIds.includes(userId)) memberIds.push(userId);
      const gid = 'g_'+uuidv4().slice(0,8);
      await pool.query(`INSERT INTO groups_tbl (id,name,emoji,is_default,created_by) VALUES ($1,$2,$3,FALSE,$4)`, [gid,name,emoji,userId]);
      for (const uid of memberIds) {
        if (await q1(`SELECT 1 FROM users WHERE id=$1`,[uid])) {
          await pool.query(`INSERT INTO group_members (group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [gid,uid]);
        }
      }
      const info = await getGroupInfo(gid);
      memberIds.forEach(uid => sendTo(uid, { type:'group_created', group:info }));
    }

    else if (d.type === 'rename_group') {
      const gid = String(d.groupId||'');
      const g = await q1(`SELECT * FROM groups_tbl WHERE id=$1`,[gid]); if (!g||g.is_default) return;
      await pool.query(`UPDATE groups_tbl SET name=$1, emoji=$2 WHERE id=$3`,
        [String(d.name||'').slice(0,32)||g.name, String(d.emoji||g.emoji).slice(0,4), gid]);
      broadcastAll({ type:'group_updated', group: await getGroupInfo(gid) });
    }

    else if (d.type === 'delete_group') {
      const gid = String(d.groupId||'');
      const g = await q1(`SELECT * FROM groups_tbl WHERE id=$1`,[gid]); if (!g||g.is_default) return;
      const members = (await q(`SELECT user_id FROM group_members WHERE group_id=$1`,[gid])).map(r=>r.user_id);
      await pool.query(`DELETE FROM groups_tbl WHERE id=$1`,[gid]);
      await pool.query(`DELETE FROM group_members WHERE group_id=$1`,[gid]);
      await pool.query(`DELETE FROM group_messages WHERE group_id=$1`,[gid]);
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

// ── ADMIN ──────────────────────────────────────────────
app.get('/admin', (req,res) => res.sendFile(path.join(__dirname,'public','admin.html')));

app.post('/api/admin/login', (req,res) => {
  req.body.password===ADMIN_PASS ? res.json({ok:true}) : res.status(403).json({ok:false});
});

app.post('/api/admin/stats', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const users = (await q(`SELECT * FROM users`)).map(u=>({id:u.id,name:u.name,color:u.color,online:isOnline(u.id)}));
  const grps  = await Promise.all((await q(`SELECT * FROM groups_tbl`)).map(async g=>({
    id:g.id, name:g.name, emoji:g.emoji, isDefault:g.is_default,
    memberCount: (await q1(`SELECT COUNT(*) as c FROM group_members WHERE group_id=$1`,[g.id]))?.c||0,
    msgCount:    (await q1(`SELECT COUNT(*) as c FROM group_messages WHERE group_id=$1`,[g.id]))?.c||0,
  })));
  res.json({ ok:true, stats:{ onlineCount:[...sessions.values()].filter(s=>s.ws?.readyState===1).length, totalUsers:users.length, groupCount:grps.length, users, groups:grps }});
});

app.post('/api/admin/ban', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const uid=req.body.userId;
  await pool.query(`INSERT INTO banned_users (id) VALUES ($1) ON CONFLICT DO NOTHING`,[uid]);
  const s=sessions.get(uid); if(s?.ws){send(s.ws,{type:'banned'});s.ws.close();}
  broadcastAll({type:'contact_offline',userId:uid});
  res.json({ok:true});
});

app.post('/api/admin/unban', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  await pool.query(`DELETE FROM banned_users WHERE id=$1`,[req.body.userId]);
  res.json({ok:true});
});

app.post('/api/admin/delete-group', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const gid=req.body.groupId;
  const members=(await q(`SELECT user_id FROM group_members WHERE group_id=$1`,[gid])).map(r=>r.user_id);
  await pool.query(`DELETE FROM groups_tbl WHERE id=$1`,[gid]);
  await pool.query(`DELETE FROM group_members WHERE group_id=$1`,[gid]);
  await pool.query(`DELETE FROM group_messages WHERE group_id=$1`,[gid]);
  members.forEach(uid=>sendTo(uid,{type:'group_deleted',groupId:gid}));
  res.json({ok:true});
});

app.post('/api/admin/rename-group', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const g=await q1(`SELECT * FROM groups_tbl WHERE id=$1`,[req.body.groupId]); if(!g) return res.status(404).json({ok:false});
  await pool.query(`UPDATE groups_tbl SET name=$1 WHERE id=$2`,[String(req.body.name||'').slice(0,32)||g.name, req.body.groupId]);
  broadcastAll({type:'group_updated',group:await getGroupInfo(req.body.groupId)});
  res.json({ok:true});
});

// ── START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  server.listen(PORT, () => console.log(`VAX v4 (PostgreSQL) running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
