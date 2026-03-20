const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── STATE ──────────────────────────────────────────────
const sessions  = new Map(); // userId → { name, color, pushSub, ws? }
const groups    = new Map(); // groupId → { id, name, members:[userId], messages:[], createdBy }
const dms       = new Map(); // dmKey → { messages:[] }
const wsToUser  = new Map(); // ws → userId

const COLORS = ['#00e5ff','#ff2d78','#7b2fff','#00ff88','#ffb800','#ff6b35','#a8ff3e','#ff3ea8','#00bfff','#ff4500'];

// Default groups
const defaultGroups = [
  { id: 'g_general', name: 'Загальний', emoji: '💬' },
  { id: 'g_games',   name: 'Ігри',      emoji: '🎮' },
  { id: 'g_music',   name: 'Музика',     emoji: '🎵' },
];
defaultGroups.forEach(g => groups.set(g.id, { ...g, members: [], messages: [], isDefault: true, createdBy: null }));

// ── HELPERS ────────────────────────────────────────────
function send(ws, p)    { if (ws && ws.readyState === 1) ws.send(JSON.stringify(p)); }
function sendTo(userId, p) {
  const s = sessions.get(userId);
  if (s && s.ws && s.ws.readyState === 1) send(s.ws, p);
}
function broadcastGroup(groupId, p, exUserId = null) {
  const g = groups.get(groupId); if (!g) return;
  const msg = JSON.stringify(p);
  g.members.forEach(uid => {
    if (uid === exUserId) return;
    const s = sessions.get(uid);
    if (s && s.ws && s.ws.readyState === 1) s.ws.send(msg);
  });
}
function broadcastAll(p, exUserId = null) {
  const msg = JSON.stringify(p);
  for (const [uid, s] of sessions)
    if (uid !== exUserId && s.ws && s.ws.readyState === 1) s.ws.send(msg);
}

function dmKey(a, b) { return [a, b].sort().join(':'); }
function isOnline(userId) { const s = sessions.get(userId); return s && s.ws && s.ws.readyState === 1; }

function getGroupInfo(groupId) {
  const g = groups.get(groupId); if (!g) return null;
  return { id: g.id, name: g.name, emoji: g.emoji || '💬', isDefault: g.isDefault, createdBy: g.createdBy,
    memberCount: g.members.length,
    members: g.members.map(uid => { const s = sessions.get(uid); return s ? { id: uid, name: s.name, color: s.color, online: isOnline(uid) } : null; }).filter(Boolean) };
}

function getAllContacts() {
  return [...sessions.entries()].map(([id, s]) => ({ id, name: s.name, color: s.color, online: isOnline(id) }));
}

// ── PUSH NOTIFICATIONS (Web Push via fetch) ────────────
// Simple push: we store subscriptions and call the push endpoint
// Using browser push API requires VAPID keys - we use a simpler approach:
// Store subscriptions server-side, send via the push service

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── ADMIN PASSWORD ─────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || '148800';

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) res.json({ ok: true });
  else res.status(403).json({ ok: false });
});

app.post('/api/admin/stats', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  res.json({ ok: true, stats: {
    onlineCount: [...sessions.values()].filter(s => s.ws && s.ws.readyState === 1).length,
    totalUsers: sessions.size,
    groupCount: groups.size,
    users: [...sessions.entries()].map(([id, s]) => ({ id, name: s.name, color: s.color, online: !!(s.ws && s.ws.readyState === 1) })),
    groups: [...groups.values()].map(g => ({ id: g.id, name: g.name, emoji: g.emoji, memberCount: g.members.length, msgCount: g.messages.length, isDefault: g.isDefault })),
  }});
});

app.post('/api/admin/ban', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const s = sessions.get(req.body.userId);
  if (s && s.ws) { send(s.ws, { type: 'banned' }); s.ws.close(); }
  sessions.delete(req.body.userId);
  broadcastAll({ type: 'contact_offline', userId: req.body.userId });
  res.json({ ok: true });
});

app.post('/api/admin/delete-group', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const g = groups.get(req.body.groupId); if (!g) return res.status(404).json({ ok: false });
  const members = [...g.members]; groups.delete(req.body.groupId);
  members.forEach(uid => sendTo(uid, { type: 'group_deleted', groupId: req.body.groupId }));
  res.json({ ok: true });
});

app.post('/api/admin/rename-group', (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(403).json({ ok: false });
  const g = groups.get(req.body.groupId); if (!g) return res.status(404).json({ ok: false });
  g.name = String(req.body.name || '').slice(0, 32).trim() || g.name;
  broadcastAll({ type: 'group_updated', group: getGroupInfo(req.body.groupId) });
  res.json({ ok: true });
});

// ── ROUTES ────────────────────────────────────────────
// Save push subscription
app.post('/api/push-subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription) return res.status(400).json({ ok: false });
  const s = sessions.get(userId);
  if (s) { s.pushSub = subscription; console.log('Push sub saved for', s.name); }
  res.json({ ok: true });
});

// VAPID public key endpoint (we'll use a static one for simplicity)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// ── WEBSOCKET ──────────────────────────────────────────
wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const userId = wsToUser.get(ws);
    const user = userId ? sessions.get(userId) : null;

    // ── REGISTER / LOGIN ──
    if (d.type === 'register') {
      const name  = String(d.name || 'Анонім').slice(0, 24).trim();
      const uid   = d.userId || uuidv4().slice(0, 12); // reuse existing ID if provided
      const color = (sessions.get(uid) && sessions.get(uid).color) || COLORS[Math.floor(Math.random() * COLORS.length)];

      // If session exists (reconnect), update ws
      const existing = sessions.get(uid);
      sessions.set(uid, { name, color, ws, pushSub: existing?.pushSub || null });
      wsToUser.set(ws, uid);

      // Add to all default groups if not already member
      defaultGroups.forEach(g => {
        const grp = groups.get(g.id);
        if (grp && !grp.members.includes(uid)) grp.members.push(uid);
      });

      // Send init data
      const myGroups = [...groups.values()]
        .filter(g => g.members.includes(uid))
        .map(g => ({ ...getGroupInfo(g.id), lastMsg: g.messages[g.messages.length - 1] || null }));

      send(ws, {
        type: 'init',
        user: { id: uid, name, color },
        groups: myGroups,
        contacts: getAllContacts().filter(c => c.id !== uid),
      });

      // Notify others
      broadcastAll({ type: 'contact_online', user: { id: uid, name, color, online: true } }, uid);
      return;
    }

    if (!user || !userId) return;

    // ── GROUP MESSAGE ──
    if (d.type === 'group_msg') {
      const gid = String(d.groupId || '');
      const g = groups.get(gid); if (!g || !g.members.includes(userId)) return;
      const text = String(d.text || '').slice(0, 4000).trim(); if (!text) return;
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, text, time: new Date().toISOString(), msgType: 'text' };
      g.messages.push(msg); if (g.messages.length > 300) g.messages.shift();
      broadcastGroup(gid, { type: 'group_msg', groupId: gid, msg });
      // Push notify offline members
      g.members.forEach(uid => { if (!isOnline(uid)) pushNotify(uid, user.name, text, gid); });
    }

    // ── GROUP IMAGE ──
    else if (d.type === 'group_img') {
      const gid = String(d.groupId || '');
      const g = groups.get(gid); if (!g || !g.members.includes(userId)) return;
      const img = String(d.imageData || ''); if (!img || img.length > 7000000) return;
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, imageData: img, time: new Date().toISOString(), msgType: 'image' };
      g.messages.push(msg); if (g.messages.length > 300) g.messages.shift();
      broadcastGroup(gid, { type: 'group_msg', groupId: gid, msg });
      g.members.forEach(uid => { if (!isOnline(uid)) pushNotify(uid, user.name, '📷 Фото', gid); });
    }

    // ── DM MESSAGE ──
    else if (d.type === 'dm') {
      const toId = String(d.toId || ''); if (!toId || toId === userId) return;
      const text = String(d.text || '').slice(0, 4000).trim(); if (!text) return;
      const key = dmKey(userId, toId);
      if (!dms.has(key)) dms.set(key, { messages: [] });
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, text, time: new Date().toISOString(), msgType: 'text' };
      dms.get(key).messages.push(msg); if (dms.get(key).messages.length > 300) dms.get(key).messages.shift();
      send(ws, { type: 'dm_msg', dmWith: toId, msg });
      sendTo(toId, { type: 'dm_msg', dmWith: userId, msg, fromName: user.name, fromColor: user.color });
      if (!isOnline(toId)) pushNotify(toId, user.name, text, 'dm:'+userId);
    }

    // ── DM IMAGE ──
    else if (d.type === 'dm_img') {
      const toId = String(d.toId || ''); if (!toId || toId === userId) return;
      const img = String(d.imageData || ''); if (!img || img.length > 7000000) return;
      const key = dmKey(userId, toId);
      if (!dms.has(key)) dms.set(key, { messages: [] });
      const msg = { id: uuidv4().slice(0,8), from: { id: userId, name: user.name, color: user.color }, imageData: img, time: new Date().toISOString(), msgType: 'image' };
      dms.get(key).messages.push(msg);
      send(ws, { type: 'dm_msg', dmWith: toId, msg });
      sendTo(toId, { type: 'dm_msg', dmWith: userId, msg, fromName: user.name, fromColor: user.color });
      if (!isOnline(toId)) pushNotify(toId, user.name, '📷 Фото', 'dm:'+userId);
    }

    // ── GET DM HISTORY ──
    else if (d.type === 'get_dm') {
      const toId = String(d.toId || '');
      const key = dmKey(userId, toId);
      send(ws, { type: 'dm_history', toId, messages: dms.has(key) ? dms.get(key).messages.slice(-100) : [] });
    }

    // ── GET GROUP HISTORY ──
    else if (d.type === 'get_group') {
      const gid = String(d.groupId || '');
      const g = groups.get(gid); if (!g) return;
      send(ws, { type: 'group_history', groupId: gid, messages: g.messages.slice(-100), info: getGroupInfo(gid) });
    }

    // ── CREATE GROUP ──
    else if (d.type === 'create_group') {
      const name = String(d.name || '').slice(0, 32).trim(); if (!name) return;
      const emoji = String(d.emoji || '💬').slice(0, 4);
      const memberIds = Array.isArray(d.members) ? d.members.filter(id => sessions.has(id)) : [];
      if (!memberIds.includes(userId)) memberIds.push(userId);
      const gid = 'g_' + uuidv4().slice(0, 8);
      groups.set(gid, { id: gid, name, emoji, members: memberIds, messages: [], isDefault: false, createdBy: userId });
      const info = getGroupInfo(gid);
      memberIds.forEach(uid => sendTo(uid, { type: 'group_created', group: { ...info, lastMsg: null } }));
    }

    // ── RENAME GROUP ──
    else if (d.type === 'rename_group') {
      const gid = String(d.groupId || '');
      const g = groups.get(gid); if (!g || g.isDefault) return;
      g.name = String(d.name || '').slice(0, 32).trim() || g.name;
      g.emoji = String(d.emoji || g.emoji).slice(0, 4);
      broadcastAll({ type: 'group_updated', group: getGroupInfo(gid) });
    }

    // ── DELETE GROUP ──
    else if (d.type === 'delete_group') {
      const gid = String(d.groupId || '');
      const g = groups.get(gid); if (!g || g.isDefault || g.createdBy !== userId) return;
      const members = [...g.members];
      groups.delete(gid);
      members.forEach(uid => sendTo(uid, { type: 'group_deleted', groupId: gid }));
    }

    // ── ADD MEMBER TO GROUP ──
    else if (d.type === 'add_to_group') {
      const gid = String(d.groupId || '');
      const addId = String(d.userId || '');
      const g = groups.get(gid); if (!g || !sessions.has(addId)) return;
      if (!g.members.includes(addId)) {
        g.members.push(addId);
        const info = getGroupInfo(gid);
        g.members.forEach(uid => sendTo(uid, { type: 'group_updated', group: info }));
        sendTo(addId, { type: 'group_created', group: { ...info, lastMsg: g.messages[g.messages.length-1]||null } });
      }
    }

    // ── TYPING ──
    else if (d.type === 'typing') {
      if (d.groupId) broadcastGroup(d.groupId, { type: 'typing', groupId: d.groupId, userId, name: user.name }, userId);
      else if (d.toId) sendTo(d.toId, { type: 'dm_typing', fromId: userId, name: user.name });
    }

    // ── PUSH SUBSCRIBE ──
    else if (d.type === 'push_sub') {
      user.pushSub = d.subscription;
    }
  });

  ws.on('close', () => {
    const userId = wsToUser.get(ws);
    if (userId) {
      const s = sessions.get(userId);
      if (s) { s.ws = null; }
      broadcastAll({ type: 'contact_offline', userId }, userId);
      wsToUser.delete(ws);
    }
  });
});

// ── PUSH NOTIFICATIONS ────────────────────────────────
async function pushNotify(userId, fromName, text, context) {
  const s = sessions.get(userId);
  if (!s || !s.pushSub) return;
  try {
    const payload = JSON.stringify({ title: 'VAX: ' + fromName, body: text, context });
    const sub = s.pushSub;
    // Send via Web Push protocol
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'TTL': '86400' },
      body: payload
    });
  } catch (e) { /* push failed silently */ }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VAX v2 running on port ${PORT}`));
