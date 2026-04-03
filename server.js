const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const queue = [];
const peers = {}; 

wss.on('connection', (ws) => {
    console.log('User connected');
    ws.send(JSON.stringify({ type: 'online_count', count: wss.clients.size }));

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'search') handleSearch(ws);
            else if (msg.type === 'next') handleNext(ws);
            else if (msg.type === 'stop') handleStop(ws);
            else if (['offer', 'answer', 'candidate', 'chat'].includes(msg.type)) relay(ws, msg);
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => {
        if (peers[ws]) {
            peers[ws].send(JSON.stringify({ type: 'partner_disconnected' }));
            delete peers[peers[ws]];
        }
        const idx = queue.indexOf(ws);
        if (idx > -1) queue.splice(idx, 1);
        delete peers[ws];
    });
});

function handleSearch(ws) {
    if (peers[ws]) return;
    ws.send(JSON.stringify({ type: 'searching' }));
    
    if (queue.length > 0) {
        const partner = queue.shift();
        if (partner.readyState === 1) {
            peers[ws] = partner;
            peers[partner] = ws;
            
            // === ВОТ ЗДЕСЬ ИСПРАВЛЕНИЕ ===
            // ws (новый человек) становится инициатором
            ws.send(JSON.stringify({ type: 'found', initiator: true }));
            // partner (тот кто ждал) становится принимающим
            partner.send(JSON.stringify({ type: 'found', initiator: false }));
        } else {
            handleSearch(ws);
        }
    } else {
        queue.push(ws);
    }
}

function handleNext(ws) {
    if (peers[ws]) {
        peers[ws].send(JSON.stringify({ type: 'partner_disconnected' }));
        delete peers[peers[ws]];
    }
    delete peers[ws];
    handleSearch(ws);
}

function handleStop(ws) {
    if (peers[ws]) {
        peers[ws].send(JSON.stringify({ type: 'partner_disconnected' }));
        delete peers[peers[ws]];
    }
    delete peers[ws];
    ws.send(JSON.stringify({ type: 'disconnected' }));
}

function relay(from, msg) {
    const to = peers[from];
    if (to && to.readyState === 1) to.send(JSON.stringify(msg));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
