const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── STATE ──────────────────────────────────────────────
const users   = new Map(); // ws → { id, name, color, room }
const rooms   = new Map(); // roomName → { messages: [] }
const COLORS  = ['#00e5ff','#ff2d78','#7b2fff','#00ff88','#ffb800','#ff6b35','#a8ff3e','#ff3ea8'];

const PRESET_ROOMS = ['Загальний', 'Ігри', 'Музика'];
PRESET_ROOMS.forEach(r => rooms.set(r, { messages: [] }));

function broadcast(roomName, payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  for (const [ws, user] of users) {
    if (user.room === roomName && ws !== excludeWs && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

function getRoomUsers(roomName) {
  const list = [];
  for (const [, u] of users) {
    if (u.room === roomName) list.push({ id: u.id, name: u.name, color: u.color });
  }
  return list;
}

function getAllRooms() {
  return [...rooms.keys()].map(name => ({
    name,
    count: [...users.values()].filter(u => u.room === name).length
  }));
}

// ── WEBSOCKET ──────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {

      case 'join': {
        const name  = String(data.name || 'Анонім').slice(0, 24).trim();
        const room  = String(data.room || 'Загальний');
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];
        const id    = uuidv4().slice(0, 8);

        if (!rooms.has(room)) rooms.set(room, { messages: [] });

        users.set(ws, { id, name, color, room });

        // Send initial state to this user
        ws.send(JSON.stringify({
          type: 'init',
          user: { id, name, color },
          room,
          rooms: getAllRooms(),
          history: rooms.get(room).messages.slice(-80),
          members: getRoomUsers(room)
        }));

        // Notify room
        broadcast(room, {
          type: 'user_joined',
          user: { id, name, color },
          members: getRoomUsers(room),
          rooms: getAllRooms()
        }, ws);
        break;
      }

      case 'message': {
        const user = users.get(ws);
        if (!user) return;
        const text = String(data.text || '').slice(0, 2000).trim();
        if (!text) return;

        const msg = {
          id: uuidv4().slice(0, 8),
          from: { id: user.id, name: user.name, color: user.color },
          text,
          time: new Date().toISOString()
        };

        rooms.get(user.room).messages.push(msg);
        // Keep last 200 messages per room
        if (rooms.get(user.room).messages.length > 200) {
          rooms.get(user.room).messages.shift();
        }

        broadcast(user.room, { type: 'message', msg });
        break;
      }

      case 'switch_room': {
        const user = users.get(ws);
        if (!user) return;
        const newRoom = String(data.room || 'Загальний');

        // Leave old room
        broadcast(user.room, {
          type: 'user_left',
          userId: user.id,
          members: getRoomUsers(user.room).filter(u => u.id !== user.id),
          rooms: getAllRooms()
        });

        if (!rooms.has(newRoom)) rooms.set(newRoom, { messages: [] });
        user.room = newRoom;

        ws.send(JSON.stringify({
          type: 'room_switched',
          room: newRoom,
          rooms: getAllRooms(),
          history: rooms.get(newRoom).messages.slice(-80),
          members: getRoomUsers(newRoom)
        }));

        broadcast(newRoom, {
          type: 'user_joined',
          user: { id: user.id, name: user.name, color: user.color },
          members: getRoomUsers(newRoom),
          rooms: getAllRooms()
        }, ws);
        break;
      }

      case 'create_room': {
        const user = users.get(ws);
        if (!user) return;
        const name = String(data.name || '').slice(0, 32).trim();
        if (!name || rooms.has(name)) {
          ws.send(JSON.stringify({ type: 'error', text: 'Кімната вже існує або назва порожня' }));
          return;
        }
        rooms.set(name, { messages: [] });
        // Broadcast new room list to everyone
        for (const [w] of users) {
          if (w.readyState === 1) w.send(JSON.stringify({ type: 'rooms_updated', rooms: getAllRooms() }));
        }
        break;
      }

      case 'typing': {
        const user = users.get(ws);
        if (!user) return;
        broadcast(user.room, { type: 'typing', userId: user.id, name: user.name }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      broadcast(user.room, {
        type: 'user_left',
        userId: user.id,
        members: getRoomUsers(user.room).filter(u => u.id !== user.id),
        rooms: getAllRooms()
      });
      users.delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VAX running on port ${PORT}`));
