const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass + 'vax_salt_2024').digest('hex');
}

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
  // Add ban_until column for auto-unban after 1 month
  await pool.query(`ALTER TABLE banned_users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE banned_users ADD COLUMN IF NOT EXISTS ban_until TIMESTAMPTZ`);
  // Group write permissions (only for default groups)
  await pool.query(`CREATE TABLE IF NOT EXISTS group_permissions (
    group_id TEXT, user_id TEXT, can_write BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (group_id, user_id)
  )`);

  // Auto-delete banned accounts after 1 month
  setInterval(async () => {
    try {
      const expired = await q(`SELECT id FROM banned_users WHERE ban_until IS NOT NULL AND ban_until < NOW()`);
      for(const r of expired){
        // Delete all user data permanently
        await pool.query(`DELETE FROM group_members WHERE user_id=$1`,[r.id]);
        await pool.query(`DELETE FROM dm_messages WHERE from_id=$1 OR to_id=$1`,[r.id]);
        await pool.query(`DELETE FROM group_messages WHERE from_id=$1`,[r.id]);
        await pool.query(`DELETE FROM banned_users WHERE id=$1`,[r.id]);
        await pool.query(`DELETE FROM users WHERE id=$1`,[r.id]);
        console.log('Auto-deleted banned user:', r.id);
      }
    } catch(e){ console.error('Auto-delete error:', e); }
  }, 60*60*1000);

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
  // Add file_name column if not exists (migration)
  await pool.query(`ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_name TEXT`);
  await pool.query(`ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS file_name TEXT`);
  await pool.query(`ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS file_type TEXT`);
  await pool.query(`ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS file_type TEXT`);
  // Add auth columns
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users(username)`);

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
  return { id: r.id, from: { id: r.from_id, name: r.from_name, color: r.from_color }, text: r.text||undefined, imageData: r.image_data||undefined, fileName: r.file_name||undefined, fileType: r.file_type||undefined, msgType: r.msg_type, time: r.time };
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

    // ── LOGIN ──
    if (d.type === 'login') {
      const username = String(d.username||'').slice(0,24).trim().toLowerCase();
      const password = String(d.password||'');
      if (!username || !password) { send(ws, { type:'auth_error', msg:'Введіть логін і пароль' }); return; }
      const user = await q1(`SELECT * FROM users WHERE username=$1`, [username]);
      if (!user) { send(ws, { type:'auth_error', msg:'Користувача не знайдено' }); return; }
      if (await q1(`SELECT 1 FROM banned_users WHERE id=$1`, [user.id])) {
        const ban = await q1(`SELECT ban_until FROM banned_users WHERE id=$1`, [user.id]);
        const until = ban?.ban_until ? new Date(ban.ban_until).toLocaleDateString('uk-UA') : 'назавжди';
        send(ws, { type:'banned', reason:`Ваш акаунт заблоковано до ${until}` }); ws.close(); return;
      }
      if (user.password_hash !== hashPassword(password)) { send(ws, { type:'auth_error', msg:'Невірний пароль' }); return; }
      // Login success
      sessions.set(user.id, { name: user.name, color: user.color, ws });
      wsToUser.set(ws, user.id);
      send(ws, { type:'init', user:{id:user.id,name:user.name,color:user.color,username:user.username}, groups: await getUserGroups(user.id), contacts: await allContacts(user.id) });
      broadcastAll({ type:'contact_online', user:{id:user.id,name:user.name,color:user.color,online:true} }, user.id);
      return;
    }

    // ── REGISTER ──
    if (d.type === 'register') {
      const username = String(d.username||'').slice(0,24).trim().toLowerCase();
      const name     = String(d.name||d.username||'').slice(0,24).trim();
      const password = String(d.password||'');
      if (!username||!password||!name) { send(ws, { type:'auth_error', msg:'Заповніть всі поля' }); return; }
      if (username.length < 3) { send(ws, { type:'auth_error', msg:'Логін мінімум 3 символи' }); return; }
      if (password.length < 4) { send(ws, { type:'auth_error', msg:'Пароль мінімум 4 символи' }); return; }
      // Check username taken
      const existing = await q1(`SELECT 1 FROM users WHERE username=$1`, [username]);
      if (existing) { send(ws, { type:'auth_error', msg:'Цей логін вже зайнятий' }); return; }
      const uid = uuidv4().slice(0,12);
      const color = COLORS[Math.floor(Math.random()*COLORS.length)];
      const passHash = hashPassword(password);
      await pool.query(`INSERT INTO users (id,name,color,username,password_hash) VALUES ($1,$2,$3,$4,$5)`, [uid,name,color,username,passHash]);
      for (const gid of DEFAULT_GROUP_IDS) {
        await pool.query(`INSERT INTO group_members (group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [gid,uid]);
      }
      sessions.set(uid, { name, color, ws });
      wsToUser.set(ws, uid);
      send(ws, { type:'init', user:{id:uid,name,color,username}, groups: await getUserGroups(uid), contacts: await allContacts(uid) });
      broadcastAll({ type:'contact_online', user:{id:uid,name,color,online:true} }, uid);
      return;
    }

    // ── LEGACY REGISTER (old devices without password) ──
    if (d.type === 'register_legacy') {
      const name = String(d.name||'Анонім').slice(0,24).trim();
      const uid  = d.userId || uuidv4().slice(0,12);
      if (await q1(`SELECT 1 FROM banned_users WHERE id=$1`, [uid])) { send(ws, { type:'banned' }); ws.close(); return; }
      const existingUser = await q1(`SELECT * FROM users WHERE id=$1`, [uid]);
      const color = existingUser?.color || COLORS[Math.floor(Math.random()*COLORS.length)];
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
      // Check write permission for default groups
      const grp = await q1(`SELECT is_default FROM groups_tbl WHERE id=$1`,[gid]);
      if(grp?.is_default){
        const perm = await q1(`SELECT can_write FROM group_permissions WHERE group_id=$1 AND user_id=$2`,[gid,userId]);
        if(!perm || !perm.can_write){ send(ws,{type:'error',text:'У вас немає дозволу писати в цій групі'}); return; }
      }
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
      const grp2 = await q1(`SELECT is_default FROM groups_tbl WHERE id=$1`,[gid]);
      if(grp2?.is_default){
        const perm2 = await q1(`SELECT can_write FROM group_permissions WHERE group_id=$1 AND user_id=$2`,[gid,userId]);
        if(!perm2 || !perm2.can_write){ send(ws,{type:'error',text:'У вас немає дозволу писати в цій групі'}); return; }
      }
      const img = String(d.imageData||''); if (!img||img.length>7000000) return;
      const fileType = String(d.fileType||'');
      const fileName = String(d.fileName||'');
      const msgType = fileType.startsWith('image/')?'image':fileType.startsWith('video/')?'video':fileType.startsWith('audio/')?'audio':'file';
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      await pool.query(`INSERT INTO group_messages (id,group_id,from_id,from_name,from_color,image_data,msg_type,file_name,file_type,time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id,gid,userId,user.name,user.color,img,msgType,fileName,fileType,time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, imageData:img, fileName, fileType, msgType, time };
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
      const fileType = String(d.fileType||'');
      const fileName = String(d.fileName||'');
      const msgType = fileType.startsWith('image/')?'image':fileType.startsWith('video/')?'video':fileType.startsWith('audio/')?'audio':'file';
      const id = uuidv4().slice(0,8), time = new Date().toISOString();
      await pool.query(`INSERT INTO dm_messages (id,from_id,to_id,from_name,from_color,image_data,msg_type,file_name,file_type,time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id,userId,toId,user.name,user.color,img,msgType,fileName,fileType,time]);
      const msg = { id, from:{id:userId,name:user.name,color:user.color}, imageData:img, fileName, fileType, msgType, time };
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

    else if (d.type === 'change_profile') {
      const newName = String(d.name||'').slice(0,24).trim();
      const newPass = String(d.password||'');
      const newUsername = String(d.username||'').slice(0,24).trim().toLowerCase();
      if (newName) await pool.query(`UPDATE users SET name=$1 WHERE id=$2`, [newName, userId]);
      if (newPass && newPass.length >= 4) await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(newPass), userId]);
      if (newUsername && newUsername.length >= 3) {
        const taken = await q1(`SELECT 1 FROM users WHERE username=$1 AND id!=$2`, [newUsername, userId]);
        if (taken) { send(ws, { type:'error', text:'Цей логін вже зайнятий' }); }
        else await pool.query(`UPDATE users SET username=$1 WHERE id=$2`, [newUsername, userId]);
      }
      const updated = await q1(`SELECT * FROM users WHERE id=$1`, [userId]);
      if (updated) {
        const s = sessions.get(userId);
        if (s) { s.name = updated.name; s.color = updated.color; }
        send(ws, { type:'profile_updated', user:{id:userId, name:updated.name, color:updated.color, username:updated.username} });
      }
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
  const bans = await q(`SELECT id, ban_until FROM banned_users`);
  const banMap = {}; bans.forEach(b=>banMap[b.id]={until:b.ban_until});
  const users = (await q(`SELECT * FROM users`)).map(u=>({
    id:u.id, name:u.name, color:u.color, username:u.username||'',
    online:isOnline(u.id), banned:!!banMap[u.id],
    banUntil: banMap[u.id]?.until||null
  }));
  const grps = await Promise.all((await q(`SELECT * FROM groups_tbl`)).map(async g=>({
    id:g.id, name:g.name, emoji:g.emoji, isDefault:g.is_default,
    memberCount: (await q1(`SELECT COUNT(*) as c FROM group_members WHERE group_id=$1`,[g.id]))?.c||0,
    msgCount:    (await q1(`SELECT COUNT(*) as c FROM group_messages WHERE group_id=$1`,[g.id]))?.c||0,
  })));
  res.json({ ok:true, stats:{ onlineCount:[...sessions.values()].filter(s=>s.ws?.readyState===1).length, totalUsers:users.length, groupCount:grps.length, users, groups:grps }});
});

app.post('/api/admin/ban', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const uid=req.body.userId;
  const banUntil = new Date(Date.now() + 30*24*60*60*1000); // 1 month
  await pool.query(`INSERT INTO banned_users (id,banned_at,ban_until) VALUES ($1,NOW(),$2) ON CONFLICT (id) DO UPDATE SET banned_at=NOW(), ban_until=$2`, [uid, banUntil]);
  // Kick from all groups
  await pool.query(`DELETE FROM group_members WHERE user_id=$1 AND group_id NOT IN (SELECT id FROM groups_tbl WHERE is_default=TRUE)`, [uid]);
  // Disconnect if online
  const s=sessions.get(uid);
  if(s?.ws){ send(s.ws,{type:'banned',reason:'Ваш акаунт заблоковано адміністратором'}); s.ws.close(); }
  // Notify everyone this user went offline
  broadcastAll({type:'contact_offline',userId:uid});
  res.json({ok:true, banUntil});
});

app.post('/api/admin/unban', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const uid = req.body.userId;
  await pool.query(`DELETE FROM banned_users WHERE id=$1`,[uid]);
  // Restore default groups
  for(const gid of ['g_general','g_games','g_music']){
    await pool.query(`INSERT INTO group_members (group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[gid,uid]);
  }
  res.json({ok:true});
});

// ── PERMISSIONS ────────────────────────────────────────
app.post('/api/admin/set-permission', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const { userId, groupId, canWrite } = req.body;
  await pool.query(`INSERT INTO group_permissions (group_id,user_id,can_write) VALUES ($1,$2,$3)
    ON CONFLICT (group_id,user_id) DO UPDATE SET can_write=$3`, [groupId, userId, canWrite]);
  res.json({ok:true});
});

app.post('/api/admin/get-permissions', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const perms = await q(`SELECT * FROM group_permissions`);
  res.json({ok:true, perms});
});

app.post('/api/admin/delete-user', async (req,res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(403).json({ok:false});
  const uid = req.body.userId;
  const s = sessions.get(uid);
  if(s?.ws){ send(s.ws,{type:'banned',reason:'Ваш акаунт було видалено адміністратором'}); s.ws.close(); }
  await pool.query(`DELETE FROM group_members WHERE user_id=$1`,[uid]);
  await pool.query(`DELETE FROM dm_messages WHERE from_id=$1 OR to_id=$1`,[uid]);
  await pool.query(`DELETE FROM group_messages WHERE from_id=$1`,[uid]);
  await pool.query(`DELETE FROM banned_users WHERE id=$1`,[uid]);
  await pool.query(`DELETE FROM users WHERE id=$1`,[uid]);
  broadcastAll({type:'contact_offline',userId:uid});
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
