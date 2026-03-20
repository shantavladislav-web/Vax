const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ───────────────────────────────────────────
const db = new Database(path.join(__dirname, 'vax.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups_tbl (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT DEFAULT '💬',
    is_default INTEGER DEFAULT 0,
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT,
    user_id TEXT,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_color TEXT NOT NULL,
    text TEXT,
    image_data TEXT,
    msg_type TEXT DEFAULT 'text',
    time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_color TEXT NOT NULL,
    text TEXT,
    image_data TEXT,
    msg_type TEXT DEFAULT 'text',
    time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS banned_users (
    id TEXT PRIMARY KEY
  );
`);

// Default groups
const DEFAULT_GROUPS = [
  { id: 'g_general', name: 'Загальний', emoji: '💬' },
  { id: 'g_games',   name: 'Ігри',      emoji: '🎮' },
  { id: 'g_music',   name: 'Музика',     emoji: '🎵' },
];
for (const g of DEFAULT_GROUPS) {
  db.prepare(`INSERT OR IGNORE INTO groups_tbl (id, name, emoji, is_default) VALUES (?,?,?,1)`).run(g.id, g.name, g.emoji);
}

// ── DB HELPERS ─────────────────────────────────────────
const dbGetUser    = db.prepare(`SELECT * FROM users WHERE id=?`);
const dbSaveUser   = db.prepare(`INSERT OR REPLACE INTO users (id, name, color) VALUES (?,?,?)`);
const dbGetGroup   = db.prepare(`SELECT * FROM groups_tbl WHERE id=?`);
const dbAllGroups  = db.prepare(`SELECT * FROM groups_tbl`);
const dbGroupMembers = db.prepare(`SELECT user_id FROM group_members WHERE group_id=?`);
const dbIsInGroup  = db.prepare(`SELECT 1 FROM group_members WHERE group_id=? AND user_id=?`);
const dbAddMember  = db.prepare(`INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?,?)`);
const dbDelGroup   = db.prepare(`DELETE FROM groups_tbl WHERE id=?`);
const dbDelGroupMembers = db.prepare(`DELETE FROM group_members WHERE group_id=?`);
const dbDelGroupMsgs = db.prepare(`DELETE FROM group_messages WHERE group_id=?`);
const dbGroupMsgs  = db.prepare(`SELECT * FROM group_messages WHERE group_id=? ORDER BY time DESC LIMIT 100`);
const dbSaveGroupMsg = db.prepare(`INSERT INTO group_messages (id,group_id,from_id,from_name,from_color,text,image_data,msg_type,time) VALUES (?,?,?,?,?,?,?,?,?)`);
const dbDmMsgs     = db.prepare(`SELECT * FROM dm_messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY time DESC LIMIT 100`);
const dbSaveDmMsg  = db.prepare(`INSERT INTO dm_messages (id,from_id,to_id,from_name,from_color,text,image_data,msg_type,time) VALUES (?,?,?,?,?,?,?,?,?)`);
const dbIsBanned   = db.prepare(`SELECT 1 FROM banned_users WHERE id=?`);
const dbBanUser    = db.prepare(`INSERT OR IGNORE INTO banned_users (id) VALUES (?)`);
const dbUnbanUser  = db.prepare(`DELETE FROM banned_users WHERE id=?`);
const dbRenameGroup = db.prepare(`UPDATE groups_tbl SET name=?, emoji=? WHERE id=?`);
const dbLastGroupMsg = db.prepare(`SELECT * FROM group_messages WHERE group_id=? ORDER BY time DESC LIMIT 1`);

function getMsgArray(rows) {
  return rows.reverse().map(r => ({
    id: r.id,
    from: { id: r.from_id, name: r.from_name, color: r.from_color },
    text: r.text || undefined,
    imageData: r.image_data || undefined,
    msgType: r.msg_type,
    time: r.time,
  }));
}

function getGroupWithMembers(gid) {
  const g = dbGetGroup.get(gid); if (!g) return null;
  const memberRows = dbGroupMembers.all(gid);
  const members = memberRows.map(r => {
    const u = sessions.get(r.user_id) || dbGetUser.get(r.user_id);
    if (!u) return null;
    return { id: r.user_id, name: u.name, color: u.color, online: isOnline(r.user_id) };
  }).filter(Boolean);
  const lastRow = dbLastGroupMsg.get(gid);
  const lastMsg = lastRow ? getMsgArray([lastRow])[0] : null;
  return { id: g.id, name: g.name, emoji: g.emoji, isDefault: !!g.is_default, createdBy: g.created_by, memberCount: members.length, members, lastMsg };
}

function getUserGroups(userId) {
  const rows = db.prepare(`SELECT group_id FROM group_members WHERE user_id=?`).all(userId);
  return rows.map(r => getGroupWithMembers(r.group_id)).filter(Boolean);
}

// ── RUNTIME STATE ──────────────────────────────────────
const sessions = new Map(); // userId → { name, color, ws }
const wsToUser = new Map(); // ws → userId
const COLORS = ['#00e5ff','#ff2d78','#7b2fff','#00ff88','#ffb800','#ff6b35','#a8ff3e','#ff3ea8','#00bfff','#ff4500'];
const ADMIN_PASS = process.env.ADMIN_PASS || '148800';

function send(ws, p)    { if (ws && ws.readyState === 1) ws.send(JSON.stringify(p)); }
function sendTo(uid, p) { const s = sessions.get(uid); if (s?.ws?.readyState === 1) send(s.ws, p); }
function broadcastGroup(gid, p, exUid = null) {
  const msg = JSON.stringify(p);
  dbGroupMembers.all(gid).forEach(({ user_id }) => {
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
function isOnline(uid) { const s = sessions.get(uid); return !!(s?.ws?.readyState === 1); }
function allContacts(exUid) {
  return db.prepare(`SELECT * FROM users`).all()
    .filter(u => u.id !== exUid)
    .map(u => ({ id: u.id, name: u.name, color: u.color, online: isOnline(u.id) }));
}

// ── WEBSOCKET ──────────────────────────────────────────
wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const userId = wsToUser.get(ws);
    const sesUser = userId ? sessions.get(userId) : null;

    // ── REGISTER ──
    if (d.type === 'register') {
      const name = String(d.name || 'Анонім').slice(0, 24).trim();
      const uid  = d.userId || uuidv4().slice(0, 12);

      // Check ban
      if (dbIsBanned.get(uid)) { send(ws, { type: 'banned' }); ws.close(); return; }

      // Get or create user
      const existing = dbGetUser.get(uid);
      const color = existing?.color || COLORS[Math.floor(Math.random() * COLORS.length)];
      dbSaveUser.run(uid, name, color);

      // Add to default groups
      for (const g of DEFAULT_GROUPS) dbAddMember.run(g.id, uid);

      // Update runtime session
      sessions.set(uid, { name, color, ws });
      wsToUser.set(ws, uid);

      // Send init
      send(ws, {
        type: 'init',
        user: { id: uid, name, color },
        groups: getUserGroups(uid),
        contacts: allContacts(uid),
      });

      broadcastAll({ type: 'contact_online', user: { id: uid, name, color, online: true } }, uid);
      return;
    }

    if (!sesUser || !userId) return;
    const user = { id: userId, ...sesUser };

    // ── GROUP MSG ──
    if (d.type === 'group_msg') {
      const gid = String(d.groupId || '');
      if (!dbIsInGroup.get(gid, userId)) return;
      const text = String(d.text || '').slice(0, 4000).trim(); if (!text) return;
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, text, msgType: 'text', time: new Date().toISOString() };
      dbSaveGroupMsg.run(msg.id, gid, userId, user.name, user.color, text, null, 'text', msg.time);
      broadcastGroup(gid, { type: 'group_msg', groupId: gid, msg }, userId);
    }

    // ── GROUP IMG ──
    else if (d.type === 'group_img') {
      const gid = String(d.groupId || '');
      if (!dbIsInGroup.get(gid, userId)) return;
      const img = String(d.imageData || ''); if (!img || img.length > 7000000) return;
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, imageData: img, msgType: 'image', time: new Date().toISOString() };
      dbSaveGroupMsg.run(msg.id, gid, userId, user.name, user.color, null, img, 'image', msg.time);
      broadcastGroup(gid, { type: 'group_msg', groupId: gid, msg }, userId);
    }

    // ── DM ──
    else if (d.type === 'dm') {
      const toId = String(d.toId || ''); if (!toId || toId === userId) return;
      const text = String(d.text || '').slice(0, 4000).trim(); if (!text) return;
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, text, msgType: 'text', time: new Date().toISOString() };
      dbSaveDmMsg.run(msg.id, userId, toId, user.name, user.color, text, null, 'text', msg.time);
      send(ws, { type: 'dm_msg', dmWith: toId, msg });
      sendTo(toId, { type: 'dm_msg', dmWith: userId, msg, fromName: user.name, fromColor: user.color });
    }

    // ── DM IMG ──
    else if (d.type === 'dm_img') {
      const toId = String(d.toId || ''); if (!toId || toId === userId) return;
      const img = String(d.imageData || ''); if (!img || img.length > 7000000) return;
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, imageData: img, msgType: 'image', time: new Date().toISOString() };
      dbSaveDmMsg.run(msg.id, userId, toId, user.name, user.color, null, img, 'image', msg.time);
      send(ws, { type: 'dm_msg', dmWith: toId, msg });
      sendTo(toId, { type: 'dm_msg', dmWith: userId, msg, fromName: user.name, fromColor: user.color });
    }

    // ── GET GROUP ──
    else if (d.type === 'get_group') {
      const gid = String(d.groupId || '');
      const rows = dbGroupMsgs.all(gid);
      send(ws, { type: 'group_history', groupId: gid, messages: getMsgArray(rows), info: getGroupWithMembers(gid) });
    }

    // ── GET DM ──
    else if (d.type === 'get_dm') {
      const toId = String(d.toId || '');
      const rows = dbDmMsgs.all(userId, toId, toId, userId);
      send(ws, { type: 'dm_history', toId, messages: getMsgArray(rows) });
    }

    // ── CREATE GROUP ──
    else if (d.type === 'create_group') {
      const name = String(d.name || '').slice(0, 32).trim(); if (!name) return;
      const emoji = String(d.emoji || '💬').slice(0, 4);
      const memberIds = Array.isArray(d.members) ? d.members : [];
      if (!memberIds.includes(userId)) memberIds.push(userId);
      const gid = 'g_' + uuidv4().slice(0, 8);
      db.prepare(`INSERT INTO groups_tbl (id,name,emoji,is_default,created_by) VALUES (?,?,?,0,?)`).run(gid, name, emoji, userId);
      for (const uid of memberIds) {
        if (dbGetUser.get(uid)) dbAddMember.run(gid, uid);
      }
      const info = getGroupWithMembers(gid);
      memberIds.forEach(uid => sendTo(uid, { type: 'group_created', group: info }));
    }

    // ── RENAME GROUP ──
    else if (d.type === 'rename_group') {
      const gid = String(d.groupId || '');
      const g = dbGetGroup.get(gid); if (!g || g.is_default) return;
      const name = String(d.name || '').slice(0, 32).trim() || g.name;
      const emoji = String(d.emoji || g.emoji).slice(0, 4);
      dbRenameGroup.run(name, emoji, gid);
      broadcastAll({ type: 'group_updated', group: getGroupWithMembers(gid) });
    }

    // ── DELETE GROUP ──
    else if (d.type === 'delete_group') {
      const gid = String(d.groupId || '');
      const g = dbGetGroup.get(gid); if (!g || g.is_default) return;
      const members = dbGroupMembers.all(gid).map(r => r.user_id);
      dbDelGroup.run(gid); dbDelGroupMembers.run(gid); dbDelGroupMsgs.run(gid);
      members.forEach(uid => sendTo(uid, { type: 'group_deleted', groupId: gid }));
    }

    // ── TYPING ──
    else if (d.type === 'typing') {
      if (d.groupId) broadcastGroup(d.groupId, { type: 'typing', groupId: d.groupId, userId, name: user.name }, userId);
      else if (d.toId) sendTo(d.toId, { type: 'dm_typing', fromId: userId, name: user.name });
    }
  });

  ws.on('close', () => {
    const uid = wsToUser.get(ws);
    if (uid) {
      const s = sessions.get(uid);
      if (s) s.ws = null;
      broadcastAll({ type: 'contact_offline', userId: uid }, uid);
      wsToUser.delete(ws);
    }
  });
});

// ── ADMIN ROUTES ───────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) res.json({ ok: true });
  else res.status(403).json({ ok: false });
});

app.post('/api/admin/stats', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const users = db.prepare(`SELECT * FROM users`).all().map(u => ({ id: u.id, name: u.name, color: u.color, online: isOnline(u.id) }));
  const grps  = db.prepare(`SELECT * FROM groups_tbl`).all().map(g => ({
    id: g.id, name: g.name, emoji: g.emoji, isDefault: !!g.is_default,
    memberCount: dbGroupMembers.all(g.id).length,
    msgCount: db.prepare(`SELECT COUNT(*) as c FROM group_messages WHERE group_id=?`).get(g.id).c,
  }));
  res.json({ ok: true, stats: { onlineCount: [...sessions.values()].filter(s=>s.ws?.readyState===1).length, totalUsers: users.length, groupCount: grps.length, users, groups: grps } });
});

app.post('/api/admin/ban', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const uid = req.body.userId;
  dbBanUser.run(uid);
  const s = sessions.get(uid);
  if (s?.ws) { send(s.ws, { type: 'banned' }); s.ws.close(); }
  broadcastAll({ type: 'contact_offline', userId: uid });
  res.json({ ok: true });
});

app.post('/api/admin/unban', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  dbUnbanUser.run(req.body.userId);
  res.json({ ok: true });
});

app.post('/api/admin/delete-group', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const gid = req.body.groupId;
  const members = dbGroupMembers.all(gid).map(r => r.user_id);
  dbDelGroup.run(gid); dbDelGroupMembers.run(gid); dbDelGroupMsgs.run(gid);
  members.forEach(uid => sendTo(uid, { type: 'group_deleted', groupId: gid }));
  res.json({ ok: true });
});

app.post('/api/admin/rename-group', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const g = dbGetGroup.get(req.body.groupId); if (!g) return res.status(404).json({ ok: false });
  dbRenameGroup.run(String(req.body.name||'').slice(0,32)||g.name, g.emoji, req.body.groupId);
  broadcastAll({ type: 'group_updated', group: getGroupWithMembers(req.body.groupId) });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VAX v3 (SQLite) running on port ${PORT}`));
