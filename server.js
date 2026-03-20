const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const users  = new Map();
const rooms  = new Map();
const dms    = new Map();
const COLORS = ['#00e5ff','#ff2d78','#7b2fff','#00ff88','#ffb800','#ff6b35','#a8ff3e','#ff3ea8'];
const PRESET = ['Загальний','Ігри','Музика'];
PRESET.forEach(r => rooms.set(r, { messages: [], isDefault: true }));

function send(ws, p) { if (ws.readyState===1) ws.send(JSON.stringify(p)); }
function broadcast(room, p, ex=null) { const m=JSON.stringify(p); for(const[w,u]of users) if(u.room===room&&w!==ex&&w.readyState===1) w.send(m); }
function broadcastAll(p, ex=null) { const m=JSON.stringify(p); for(const[w]of users) if(w!==ex&&w.readyState===1) w.send(m); }
function roomUsers(r) { return[...users.values()].filter(u=>u.room===r).map(u=>({id:u.id,name:u.name,color:u.color})); }
function allUsersArr() { return[...users.values()].map(u=>({id:u.id,name:u.name,color:u.color})); }
function allRooms() { return[...rooms.keys()].map(n=>({name:n,count:[...users.values()].filter(u=>u.room===n).length,isDefault:rooms.get(n).isDefault})); }
function dmKey(a,b) { return[a,b].sort().join(':'); }

wss.on('connection', ws => {
  ws.on('message', raw => {
    let d; try{d=JSON.parse(raw);}catch{return;}
    const user = users.get(ws);

    if (d.type === 'join') {
      const name=String(d.name||'Анонім').slice(0,24).trim();
      const room=String(d.room||'Загальний');
      const color=COLORS[Math.floor(Math.random()*COLORS.length)];
      const id=uuidv4().slice(0,8);
      if(!rooms.has(room)) rooms.set(room,{messages:[],isDefault:false});
      users.set(ws,{id,name,color,room});
      send(ws,{type:'init',user:{id,name,color},room,rooms:allRooms(),history:rooms.get(room).messages.slice(-80),members:roomUsers(room),allUsers:allUsersArr()});
      broadcast(room,{type:'user_joined',user:{id,name,color},members:roomUsers(room),rooms:allRooms(),allUsers:allUsersArr()},ws);
      return;
    }
    if(!user) return;

    if (d.type === 'message') {
      const text=String(d.text||'').slice(0,4000).trim(); if(!text) return;
      const msg={id:uuidv4().slice(0,8),from:{id:user.id,name:user.name,color:user.color},text,time:new Date().toISOString(),msgType:'text'};
      const r=rooms.get(user.room); if(!r) return;
      r.messages.push(msg); if(r.messages.length>200) r.messages.shift();
      broadcast(user.room,{type:'message',msg});
    }

    else if (d.type === 'image') {
      const img=String(d.imageData||''); if(!img||img.length>6000000) return;
      const msg={id:uuidv4().slice(0,8),from:{id:user.id,name:user.name,color:user.color},imageData:img,time:new Date().toISOString(),msgType:'image'};
      const r=rooms.get(user.room); if(!r) return;
      r.messages.push(msg); if(r.messages.length>200) r.messages.shift();
      broadcast(user.room,{type:'message',msg});
    }

    else if (d.type === 'dm') {
      const toId=String(d.toId||''), text=String(d.text||'').slice(0,4000).trim();
      if(!text||!toId||toId===user.id) return;
      const key=dmKey(user.id,toId);
      if(!dms.has(key)) dms.set(key,{messages:[]});
      const msg={id:uuidv4().slice(0,8),from:{id:user.id,name:user.name,color:user.color},text,time:new Date().toISOString(),msgType:'text'};
      dms.get(key).messages.push(msg); if(dms.get(key).messages.length>200) dms.get(key).messages.shift();
      send(ws,{type:'dm_message',msg,dmWith:toId});
      for(const[w,u]of users) if(u.id===toId) send(w,{type:'dm_message',msg,dmWith:user.id,dmWithName:user.name,dmWithColor:user.color});
    }

    else if (d.type === 'dm_image') {
      const toId=String(d.toId||''), img=String(d.imageData||'');
      if(!img||img.length>6000000||!toId) return;
      const key=dmKey(user.id,toId);
      if(!dms.has(key)) dms.set(key,{messages:[]});
      const msg={id:uuidv4().slice(0,8),from:{id:user.id,name:user.name,color:user.color},imageData:img,time:new Date().toISOString(),msgType:'image'};
      dms.get(key).messages.push(msg);
      send(ws,{type:'dm_message',msg,dmWith:toId});
      for(const[w,u]of users) if(u.id===toId) send(w,{type:'dm_message',msg,dmWith:user.id,dmWithName:user.name,dmWithColor:user.color});
    }

    else if (d.type === 'get_dm_history') {
      const toId=String(d.toId||''), key=dmKey(user.id,toId);
      const history=dms.has(key)?dms.get(key).messages.slice(-80):[];
      send(ws,{type:'dm_history',toId,history});
    }

    else if (d.type === 'switch_room') {
      const newRoom=String(d.room||'Загальний');
      broadcast(user.room,{type:'user_left',userId:user.id,members:roomUsers(user.room).filter(u=>u.id!==user.id),rooms:allRooms()});
      if(!rooms.has(newRoom)) rooms.set(newRoom,{messages:[],isDefault:false});
      user.room=newRoom;
      send(ws,{type:'room_switched',room:newRoom,rooms:allRooms(),history:rooms.get(newRoom).messages.slice(-80),members:roomUsers(newRoom)});
      broadcast(newRoom,{type:'user_joined',user:{id:user.id,name:user.name,color:user.color},members:roomUsers(newRoom),rooms:allRooms(),allUsers:allUsersArr()},ws);
    }

    else if (d.type === 'create_room') {
      const name=String(d.name||'').slice(0,32).trim();
      if(!name||rooms.has(name)){send(ws,{type:'error',text:'Кімната вже існує або назва порожня'});return;}
      rooms.set(name,{messages:[],isDefault:false});
      broadcastAll({type:'rooms_updated',rooms:allRooms()});
    }

    else if (d.type === 'rename_room') {
      const old=String(d.oldName||''), nw=String(d.newName||'').slice(0,32).trim();
      const r=rooms.get(old);
      if(!r||r.isDefault||!nw||rooms.has(nw)){send(ws,{type:'error',text:'Не можна перейменувати'});return;}
      rooms.set(nw,{...r}); rooms.delete(old);
      for(const[w,u]of users) if(u.room===old){u.room=nw;send(w,{type:'room_renamed',oldName:old,newName:nw,rooms:allRooms()});}
      broadcastAll({type:'rooms_updated',rooms:allRooms()});
    }

    else if (d.type === 'delete_room') {
      const name=String(d.name||''), r=rooms.get(name);
      if(!r||r.isDefault){send(ws,{type:'error',text:'Не можна видалити цю кімнату'});return;}
      rooms.delete(name);
      for(const[w,u]of users) if(u.room===name){u.room='Загальний';send(w,{type:'room_deleted',name,rooms:allRooms(),history:rooms.get('Загальний').messages.slice(-80),members:roomUsers('Загальний')});}
      broadcastAll({type:'rooms_updated',rooms:allRooms()});
    }

    else if (d.type === 'typing') {
      broadcast(user.room,{type:'typing',userId:user.id,name:user.name},ws);
    }

    else if (d.type === 'dm_typing') {
      const toId=String(d.toId||'');
      for(const[w,u]of users) if(u.id===toId) send(w,{type:'dm_typing',fromId:user.id,name:user.name});
    }
  });

  ws.on('close', () => {
    const user=users.get(ws);
    if(user){
      broadcast(user.room,{type:'user_left',userId:user.id,members:roomUsers(user.room).filter(u=>u.id!==user.id),rooms:allRooms()});
      broadcastAll({type:'user_offline',userId:user.id},ws);
      users.delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VAX running on port ${PORT}`));
