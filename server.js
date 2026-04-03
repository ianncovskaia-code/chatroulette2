// server.js — Node.js сервер для чатрулетки
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();

// === SECURITY HEADERS ===
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// === HTTPS SETUP ===
let server;
const PORT = process.env.PORT || 3000;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

if (USE_HTTPS) {
  try {
    const keyPath = process.env.SSL_KEY_PATH || './ssl/key.pem';
    const certPath = process.env.SSL_CERT_PATH || './ssl/cert.pem';
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    server = https.createServer(httpsOptions, app);
    console.log('🔒 HTTPS режим активен');
  } catch (err) {
    console.error('⚠️ Ошибка SSL. Запускаю HTTP.');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

// === ICE CONFIG для WebRTC ===
const ICE_SERVERS = JSON.parse(process.env.ICE_SERVERS || JSON.stringify({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
}));

app.get('/api/config', (req, res) => {
  res.json({ iceServers: ICE_SERVERS.iceServers });
});

// === ФИЛЬТР НЕЦЕНЗУРНОЙ ЛЕКСИКИ ===
const BAD_WORDS = new Set([
  'fuck', 'shit', 'ass', 'bitch', 'damn', 'dick', 'pussy', 'bastard',
  'хуй', 'пизд', 'ебат', 'сука', 'блять', 'нахуй', 'похуй', 'ёб', 'залуп', 'муд'
]);

function censorText(text) {
  let cleaned = text;
  BAD_WORDS.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '***');
  });
  return cleaned;
}

// === RATE LIMITING (защита от спама) ===
const rateLimits = new Map();
function checkRateLimit(ws) {
  const now = Date.now();
  if (!rateLimits.has(ws)) rateLimits.set(ws, { count: 0, lastReset: now });
  const limit = rateLimits.get(ws);
  if (now - limit.lastReset > 5000) { 
    limit.count = 0; 
    limit.lastReset = now; 
  }
  limit.count++;
  return limit.count <= 12; // макс 12 сообщений за 5 сек
}

// === ХРАНИЛИЩЕ ПОЛЬЗОВАТЕЛЕЙ ===
const waitingQueue = [];
const peers = {};
const rooms = {};
let roomIdCounter = 0;

// === WEBSOCKET ПОДКЛЮЧЕНИЯ ===
wss.on('connection', (ws) => {
  console.log(`🟢 Подключение. Онлайн: ${wss.clients.size}`);
  ws.isAlive = true;
  
  ws.on('pong', () => { ws.isAlive = true; });
  
  // Отправляем текущее кол-во онлайн
  ws.send(JSON.stringify({ type: 'online_count', count: wss.clients.size }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg);
    } catch (e) {
      console.error('❌ Ошибка парсинга:', e);
    }
  });

  ws.on('close', () => {
    console.log(`🔴 Отключение. Онлайн: ${wss.clients.size}`);
    disconnectUser(ws);
  });

  ws.on('error', () => disconnectUser(ws));
});

// === ОБРАБОТКА СООБЩЕНИЙ ===
function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'search':
      searchPartner(ws);
      break;
      
    case 'cancel':
      cancelSearch(ws);
      break;
      
    case 'disconnect':
      disconnectUser(ws);
      break;
      
    case 'offer':
    case 'answer':
    case 'candidate':
      relayMessage(ws, msg);
      break;
      
    case 'chat':
      if (!peers[ws]) break;
      if (!checkRateLimit(ws)) {
        send(ws, { type: 'error', message: 'Слишком много сообщений. Подождите.' });
        break;
      }
      const cleanText = censorText(msg.text?.trim() || '');
      if (!cleanText) break;
      relayMessage(ws, { type: 'chat', text: cleanText });
      break;
      
    case 'next':
      disconnectPartner(ws);
      searchPartner(ws);
      break;
      
    case 'stop':
      disconnectPartner(ws);
      send(ws, { type: 'disconnected' });
      break;
      
    case 'report':
      handleReport(ws);
      break;
      
    case 'get_online':
      send(ws, { type: 'online_count', count: wss.clients.size });
      break;
  }
}

// === ПОИСК СОБЕСЕДНИКА ===
function searchPartner(ws) {
  if (peers[ws]) {
    return send(ws, { type: 'error', message: 'Вы уже в поиске или подключены' });
  }
  
  send(ws, { type: 'searching' });
  
  // Ищем свободного партнёра в очереди
  const partner = waitingQueue.find(p => p.readyState === 1);
  
  if (partner) {
    // Нашли — создаём комнату
    const idx = waitingQueue.indexOf(partner);
    waitingQueue.splice(idx, 1);
    
    const roomId = `room_${++roomIdCounter}`;
    rooms[roomId] = { ws1: ws, ws2: partner };
    peers[ws] = { peerWs: partner, roomId };
    peers[partner] = { peerWs: ws, roomId };
    
    send(ws, { type: 'found', roomId });
    send(partner, { type: 'found', roomId });
    
    console.log(`🔗 Соединение создано: ${roomId}`);
  } else {
    // Не нашли — добавляем в очередь
    waitingQueue.push(ws);
  }
}

function cancelSearch(ws) {
  const idx = waitingQueue.indexOf(ws);
  if (idx > -1) {
    waitingQueue.splice(idx, 1);
    send(ws, { type: 'search_cancelled' });
  }
}

// === ОТКЛЮЧЕНИЕ ПОЛЬЗОВАТЕЛЯ ===
function disconnectUser(ws) {
  disconnectPartner(ws);
  cancelSearch(ws);
  delete peers[ws];
  rateLimits.delete(ws);
}

function disconnectPartner(ws) {
  const peerData = peers[ws];
  if (peerData?.peerWs) {
    // Уведомляем партнёра
    send(peerData.peerWs, { type: 'partner_disconnected' });
    
    // Чистим комнату
    if (peerData.roomId) {
      delete rooms[peerData.roomId];
    }
    delete peers[peerData.peerWs];
  }
  delete peers[ws];
}

// === ПЕРЕДАЧА СООБЩЕНИЙ МЕЖДУ ПАРТНЁРАМИ ===
function relayMessage(ws, msg) {
  const peerData = peers[ws];
  if (peerData?.peerWs?.readyState === 1) {
    peerData.peerWs.send(JSON.stringify(msg));
  }
}

// === ОБРАБОТКА ЖАЛОБ ===
function handleReport(ws) {
  const peerData = peers[ws];
  if (peerData?.peerWs) {
    send(peerData.peerWs, { 
      type: 'system', 
      text: '⚠️ На вас поступила жалоба. Будьте вежливы.' 
    });
    console.log(`🚩 Жалоба в комнате ${peerData.roomId}`);
  }
  send(ws, { type: 'system', text: '📩 Жалоба отправлена.' });
}

// === ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ОТПРАВКИ ===
function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// === HEARTBEAT (проверка живых соединений) ===
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('❌ Мёртвое соединение, отключаем');
      disconnectUser(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// === ЗАПУСК СЕРВЕРА ===
server.listen(PORT, () => {
  const protocol = USE_HTTPS ? 'https' : 'http';
  console.log(`🚀 Сервер запущен: ${protocol}://localhost:${PORT}`);
});
