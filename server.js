const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const TRACK_CX = 600;
const TRACK_CY = 400;
const TRACK_SEGMENTS = 360;
const MAX_PLAYERS = 4;

// ---- ZORLAŞTIRILMIŞ HARİTALAR ----
const MAPS = {
    klasik:  { name: 'Klasik Oval',   desc: 'Daraltıldı + yağ lekesi', rx: 480, ry: 280, v1: 60,  v2: 45, width: 86, laps: 4, oil: 6,  pads: 3, diff: 2 },
    dalgali: { name: 'Dalgalı Viraj', desc: 'Sert S virajlar',         rx: 440, ry: 255, v1: 110, v2: 80, width: 74, laps: 4, oil: 9,  pads: 3, diff: 3 },
    teknik:  { name: 'Teknik Parkur', desc: 'Çok dar, sabır işi',      rx: 395, ry: 290, v1: 55,  v2: 100,width: 62, laps: 5, oil: 12, pads: 2, diff: 4 },
    hizli:   { name: 'Hız Arenası',   desc: 'Hızlı ama kaygan',        rx: 520, ry: 295, v1: 70,  v2: 60, width: 94, laps: 3, oil: 8,  pads: 5, diff: 3 },
    buz:     { name: 'Buz Pisti',     desc: 'Aşırı kaygan + dar',      rx: 450, ry: 270, v1: 90,  v2: 90, width: 68, laps: 4, oil: 14, pads: 2, diff: 5, ice: true },
    cehennem:{ name: 'Cehennem',      desc: 'En dar, en virajlı',      rx: 410, ry: 280, v1: 120, v2: 105,width: 58, laps: 5, oil: 14, pads: 2, diff: 5 },
};
let currentMapId = 'klasik';

function curMap() { return MAPS[currentMapId] || CUSTOM_MAPS.get(currentMapId) || MAPS.klasik; }
function curWidth() { return curMap().width; }
function curLaps() { return curMap().laps; }

// ---- OYUNCU MAPLERİ (dükkan + editör) ----
const CUSTOM_MAP_FILE = path.join(__dirname, 'custom_maps.json');
const CUSTOM_MAPS = new Map(); // id -> {id,name,author,ownerId,width,laps,oil,pads,ice,diff,points:[360],preview:[40],createdAt}

function loadCustomMaps() {
    try {
        if (!fs.existsSync(CUSTOM_MAP_FILE)) return;
        const arr = JSON.parse(fs.readFileSync(CUSTOM_MAP_FILE, 'utf8'));
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
            if (!m || typeof m.id !== 'string' || !m.id.startsWith('c_')) continue;
            if (!Array.isArray(m.points) || m.points.length !== TRACK_SEGMENTS) continue;
            if (!Array.isArray(m.ctrl)) m.ctrl = [];
            CUSTOM_MAPS.set(m.id, m);
        }
        console.log('Yüklendi: ' + CUSTOM_MAPS.size + ' oyuncu mapi');
    } catch (e) { console.log('Map dosyası okunamadı, sıfırdan başlanıyor'); }
}
function persistCustomMaps() {
    try {
        fs.writeFileSync(CUSTOM_MAP_FILE, JSON.stringify(Array.from(CUSTOM_MAPS.values()), null, 1));
    } catch (e) { console.log('Map dosyası yazılamadı: ' + e.message); }
}

// Kapalı Catmull-Rom eğrisi -> n noktaya örnekle (editör önizlemesiyle aynı algoritma)
function catmullResample(ctrl, n) {
    const pts = [];
    const m = ctrl.length;
    for (let i = 0; i < m; i++) {
        const p0 = ctrl[(i - 1 + m) % m], p1 = ctrl[i], p2 = ctrl[(i + 1) % m], p3 = ctrl[(i + 2) % m];
        const segs = Math.max(4, Math.round(n / m));
        for (let j = 0; j < segs && pts.length < n; j++) {
            const t = j / segs, t2 = t * t, t3 = t2 * t;
            pts.push({
                x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
            });
        }
    }
    while (pts.length < n) pts.push({ ...pts[pts.length - 1] });
    return pts.slice(0, n);
}

function validateCustomMapInput(d) {
    if (!d || typeof d !== 'object') return 'Boş veri';
    if (typeof d.name !== 'string' || !d.name.trim()) return 'Map adı gerekli';
    const name = d.name.trim().slice(0, 24);
    const ctrl = d.points;
    if (!Array.isArray(ctrl) || ctrl.length < 6) return 'En az 6 nokta koy (şu an ' + (ctrl ? ctrl.length : 0) + ')';
    if (ctrl.length > 30) return 'En fazla 30 nokta';
    for (const p of ctrl) {
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return 'Bozuk nokta';
        if (p.x < 40 || p.x > 1160 || p.y < 40 || p.y > 760) return 'Noktalar pist alanı dışında (kenarlardan 40px içeride olmalı)';
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, len = 0;
    for (let i = 0; i < ctrl.length; i++) {
        const a = ctrl[i], b = ctrl[(i + 1) % ctrl.length];
        minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
        minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
        len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (maxX - minX < 250 || maxY - minY < 200) return 'Pist çok küçük (en az 250x200 alana yayılmalı)';
    if (len < 1200) return 'Pist çok kısa (daha geniş çiz)';
    const width = Math.max(50, Math.min(140, Math.round(Number(d.width) || 80)));
    const laps = Math.max(1, Math.min(9, Math.round(Number(d.laps) || 3)));
    const oil = Math.max(0, Math.min(16, Math.round(Number(d.oil) || 0)));
    const pads = Math.max(0, Math.min(8, Math.round(Number(d.pads) || 0)));
    const ice = !!d.ice;
    const theme = ['klasik', 'dalgali', 'teknik', 'hizli', 'buz', 'cehennem'].includes(d.theme) ? d.theme : 'klasik';
    let startCtrl = Number.isInteger(d.startCtrl) ? d.startCtrl : -1;
    if (startCtrl < 0 || startCtrl >= ctrl.length) startCtrl = -1;
    return { name, width, laps, oil, pads, ice, theme, startCtrl };
}

// ---- EFEKT MARKETİ ----
const SHOP = {
    trail: [
        { id: 'duman',     name: 'Gri Duman',  price: 0, icon: '💨' },
        { id: 'ates',      name: 'Ateş',       price: 0, icon: '🔥' },
        { id: 'neon',      name: 'Neon Mavi',  price: 0, icon: '💠' },
        { id: 'gokkusagi', name: 'Gökkuşağı',  price: 0, icon: '🌈' },
        { id: 'altin',     name: 'Altın Toz',  price: 0, icon: '✨' },
        { id: 'galaksi',   name: 'Galaksi',    price: 0, icon: '🌌' },
        { id: 'kalp',      name: 'Kalpler',    price: 0, icon: '💖' },
        { id: 'yildiz',    name: 'Yıldız',     price: 0, icon: '⭐' },
    ],
    nitro: [
        { id: 'klasik',    name: 'Turuncu-Mavi', price: 0, icon: '🔥' },
        { id: 'yesil',     name: 'Zehir Yeşili', price: 0, icon: '☢️' },
        { id: 'mor',       name: 'Mor Şimşek',   price: 0, icon: '🟣' },
        { id: 'buz_alev',  name: 'Buz Alevi',    price: 0, icon: '🧊' },
        { id: 'gokkusagi', name: 'Gökkuşağı',    price: 0, icon: '🌈' },
    ],
    glow: [
        { id: 'yok',       name: 'Yok',        price: 0, icon: '⬛' },
        { id: 'kirmizi',   name: 'Kırmızı',    price: 0, icon: '🔴' },
        { id: 'mavi',      name: 'Mavi',       price: 0, icon: '🔵' },
        { id: 'yesil_glow',name: 'Yeşil',      price: 0, icon: '🟢' },
        { id: 'ates_halo', name: 'Ateş Hale',  price: 0, icon: '🟠' },
        { id: 'rgb',       name: 'RGB Disko',  price: 0, icon: '🎛️' },
    ],
};
function shopItem(cat, id) { return (SHOP[cat] || []).find(i => i.id === id); }

// ---- SKIN / RENK ----
const SKINS = ['klasik', 'formula', 'spor', 'retro'];
const SKIN_NAMES = { klasik: 'Klasik', formula: 'Formula', spor: 'Spor', retro: 'Retro' };
const COLORS = ['#ff4444', '#44ff44', '#4488ff', '#ffaa00', '#ff44ff', '#44ffff', '#ff8844', '#88ff44'];
function validColor(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
}
function validSkin(s) { return SKINS.includes(s); }

const MAX_SPEED = 5;
const ACCEL = 0.15;
const BRAKE = 0.2;
const FRICTION = 0.02;
const STEER_SPEED = 0.045;
const OFF_TRACK_FRICTION = 0.08;
const OFF_TRACK_MAX_SPEED = 2.5;
const COUNTDOWN_SECS = 3;
const CAR_RADIUS = 16;
const RESTITUTION = 0.55;
const START_ZONE = 20;
const BOOST_ACCEL = 0.38;
const BOOST_MAX_EXTRA = 3.2;
const BOOST_DRAIN = 1.4;
const BOOST_REGEN = 0.45;

let trackPoints = [];
let trackAngles = [];
let oilSlicks = [];
let boostPads = [];

function rnd(seedObj) {
    // basit deterministik olmayan ama stabil random
    return Math.random();
}

function anglesFor(points) {
    const arr = [];
    for (let i = 0; i < points.length; i++) {
        const c = points[i], n = points[(i + 1) % points.length];
        arr.push(Math.atan2(n.y - c.y, n.x - c.x));
    }
    return arr;
}

function computeAngles() {
    trackAngles = anglesFor(trackPoints);
}

function distToSamples(samples, x, y) {
    let m = Infinity;
    for (let i = 0; i < samples.length; i += 3) {
        const dx = x - samples[i].x, dy = y - samples[i].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < m) m = d2;
    }
    return Math.sqrt(m);
}

function placeObstacles(oilCount, padCount, width) {
    // engeller: start çizgisinden uzak segmentlere koy
    oilSlicks = [];
    boostPads = [];
    const usedSegs = new Set([0, 1, 2, 3, 4, 5, 355, 356, 357, 358, 359]);
    function freeSeg() {
        for (let tries = 0; tries < 60; tries++) {
            const s = Math.floor(Math.random() * TRACK_SEGMENTS);
            let ok = true;
            for (const u of usedSegs) {
                const d = Math.abs(u - s);
                if (Math.min(d, TRACK_SEGMENTS - d) < 14) { ok = false; break; }
            }
            if (ok) { usedSegs.add(s); return s; }
        }
        const s = Math.floor(Math.random() * TRACK_SEGMENTS);
        usedSegs.add(s);
        return s;
    }
    for (let i = 0; i < oilCount; i++) {
        const seg = freeSeg();
        const p = trackPoints[seg];
        const ang = trackAngles[seg];
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        const off = (Math.random() - 0.5) * width * 0.55;
        oilSlicks.push({ x: Math.round(p.x + nx * off), y: Math.round(p.y + ny * off), r: 20 });
    }
    for (let i = 0; i < padCount; i++) {
        const seg = freeSeg();
        const p = trackPoints[seg];
        const ang = trackAngles[seg];
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        const off = (Math.random() - 0.5) * width * 0.4;
        boostPads.push({ x: Math.round(p.x + nx * off), y: Math.round(p.y + ny * off), r: 24, angle: Math.round(ang * 1000) / 1000 });
    }
}

function generateTrack(mapId) {
    const custom = CUSTOM_MAPS.get(mapId);
    if (custom) {
        trackPoints = custom.points.map(p => ({ x: p.x, y: p.y }));
        computeAngles();
        if (Array.isArray(custom.oilSpots) && Array.isArray(custom.padSpots)) {
            oilSlicks = custom.oilSpots.map(o => ({ x: o.x, y: o.y, r: 20 }));
            boostPads = custom.padSpots.map(b => ({ x: b.x, y: b.y, r: 24, angle: b.angle || 0 }));
        } else {
            placeObstacles(custom.oil || 0, custom.pads || 0, custom.width);
        }
        return;
    }
    const m = MAPS[mapId] || MAPS.klasik;
    trackPoints = [];
    for (let i = 0; i < TRACK_SEGMENTS; i++) {
        const t = i / TRACK_SEGMENTS;
        const angle = t * Math.PI * 2;
        // daha sert virajlar: çift frekans eklendi
        const variation = Math.sin(angle * 2) * m.v1 + Math.cos(angle * 3) * m.v2 + Math.sin(angle * 5) * (m.v1 * 0.18);
        const rx = m.rx + variation;
        const ry = m.ry + variation * 0.6;
        trackPoints.push({ x: TRACK_CX + Math.cos(angle) * rx, y: TRACK_CY + Math.sin(angle) * ry });
    }
    computeAngles();
    placeObstacles(m.oil || 0, m.pads || 0, m.width);
}

function spawnForSlot(slot) {
    const seg = (((TRACK_SEGMENTS - 14 - slot * 9) % TRACK_SEGMENTS) + TRACK_SEGMENTS) % TRACK_SEGMENTS;
    const p = trackPoints[seg];
    const ang = trackAngles[seg];
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const side = (slot % 2 === 0) ? -1 : 1;
    const w = curWidth();
    return { x: p.x + nx * side * w * 0.22, y: p.y + ny * side * w * 0.22, angle: ang, seg };
}

function getClosestTrackInfo(px, py) {
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < trackPoints.length; i++) {
        const dx = px - trackPoints[i].x;
        const dy = py - trackPoints[i].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDist) { minDist = d2; bestIdx = i; }
    }
    return { index: bestIdx, distance: Math.sqrt(minDist) };
}

function isOnTrack(px, py) {
    return getClosestTrackInfo(px, py).distance < curWidth() / 2 + 5;
}

function createPlayer(id, name, ws) {
    const s = spawnForSlot(id % MAX_PLAYERS);
    return {
        id, name: name || ('Sürücü ' + (id + 1)),
        color: COLORS[id % COLORS.length], skin: 'klasik', ws,
        x: s.x, y: s.y, angle: s.angle,
        speed: 0, lap: 0, checkpoint: s.seg, passedHalf: false,
        finished: false, finishTime: null,
        keys: {}, position: 0, isHost: false,
        boost: 100, boosting: false, drift: false,
        lastLap: null, bestLap: null, lapStart: 0,
        oiled: false, padded: false,
        coins: 100,
        owned: { trail: SHOP.trail.map(i => i.id), nitro: SHOP.nitro.map(i => i.id), glow: SHOP.glow.map(i => i.id) },
        equipped: { trail: 'duman', nitro: 'klasik', glow: 'yok' },
        earnedRace: 0,
    };
}

let players = new Map();
let gameState = 'LOBBY';
let gameStartTime = 0;
let countdownTimer = null;
let lastTime = 0;
let nextPlayerId = 0;
let raceStartTime = 0;

loadCustomMaps();
generateTrack(currentMapId);

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, exclude = null) {
    const msg = JSON.stringify(data);
    for (const [, player] of players) {
        if (player.ws !== exclude && player.ws.readyState === WebSocket.OPEN) player.ws.send(msg);
    }
}

function progressOf(p) {
    return p.lap * TRACK_SEGMENTS + ((p.checkpoint % TRACK_SEGMENTS) + TRACK_SEGMENTS) % TRACK_SEGMENTS;
}

function mapsMeta() {
    const out = {};
    for (const [id, m] of Object.entries(MAPS)) out[id] = { name: m.name, desc: m.desc, laps: m.laps, width: m.width, diff: m.diff || 1, ice: !!m.ice, custom: false };
    for (const [id, m] of CUSTOM_MAPS) {
        out[id] = { name: m.name, desc: '✏️ ' + (m.author || 'Oyuncu'), laps: m.laps, width: m.width, diff: m.diff || 1, ice: !!m.ice, custom: true, author: m.author || '?', ownerId: m.ownerId || '', createdAt: m.createdAt || 0, preview: m.preview || [], theme: m.theme || 'klasik' };
    }
    return out;
}

function pubPlayer(p) {
    return {
        id: p.id, name: p.name, color: p.color, skin: p.skin,
        x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, angle: Math.round(p.angle * 1000) / 1000,
        speed: Math.round(p.speed * 100) / 100, lap: p.lap, checkpoint: p.checkpoint,
        finished: p.finished, finishTime: p.finishTime, position: p.position,
        isHost: !!p.isHost,
        boost: Math.round(p.boost), boosting: !!p.boosting, drift: !!p.drift,
        lastLap: p.lastLap, bestLap: p.bestLap,
        oiled: !!p.oiled, padded: !!p.padded,
        coins: p.coins || 0, owned: p.owned, equipped: p.equipped, earnedRace: p.earnedRace || 0,
    };
}

function getState() {
    const statePlayers = [];
    for (const [, p] of players) statePlayers.push(pubPlayer(p));
    return {
        state: gameState, players: statePlayers,
        maxPlayers: MAX_PLAYERS,
        trackPoints: trackPoints.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        trackWidth: curWidth(), totalLaps: curLaps(),
        mapId: currentMapId, mapName: curMap().name, maps: mapsMeta(),
        mapTheme: CUSTOM_MAPS.has(currentMapId) ? (CUSTOM_MAPS.get(currentMapId).theme || 'klasik') : currentMapId,
        skins: SKINS, skinNames: SKIN_NAMES, shop: SHOP,
        oilSlicks, boostPads,
        countDown: gameState === 'COUNTDOWN' ? Math.max(0, COUNTDOWN_SECS - Math.floor((Date.now() - gameStartTime) / 1000)) : 0,
    };
}

function updatePositions() {
    const sorted = Array.from(players.values()).sort((a, b) => progressOf(b) - progressOf(a));
    const withProgress = new Map();
    for (const p of sorted) withProgress.set(p.id, progressOf(p));
    const all = Array.from(players.values()).sort((a, b) => {
        if (a.finished && !b.finished) return -1;
        if (!a.finished && b.finished) return 1;
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
        return withProgress.get(b.id) - withProgress.get(a.id);
    });
    all.forEach((p, i) => { p.position = i + 1; });
}

function awardCoins() {
    updatePositions();
    const ordered = Array.from(players.values()).sort((a, b) => (a.position || 99) - (b.position || 99));
    const table = [200, 130, 90, 60];
    ordered.forEach((p, i) => {
        let earn = table[Math.min(i, 3)] || 50;
        earn += (p.lap || 0) * 15;
        if (p.bestLap) earn += 40;
        earn = Math.round(earn);
        p.coins = (p.coins || 0) + earn;
        p.earnedRace = earn;
    });
}

function checkLaps(player) {
    const seg = getClosestTrackInfo(player.x, player.y).index;
    const prev = player.checkpoint;
    const N = TRACK_SEGMENTS;
    if (Math.abs(seg - N / 2) < 60) player.passedHalf = true;
    const crossedForward = prev > N - START_ZONE && seg < START_ZONE;
    if (crossedForward) {
        if (player.passedHalf) {
            const now = Date.now();
            const lapTime = player.lapStart ? (now - player.lapStart) / 1000 : null;
            if (lapTime && lapTime > 3 && lapTime < 600) {
                player.lastLap = Math.round(lapTime * 100) / 100;
                if (!player.bestLap || player.lastLap < player.bestLap) player.bestLap = player.lastLap;
            }
            player.lapStart = now;
            player.lap++;
            if (player.lap >= curLaps() && !player.finished) {
                player.finished = true;
                player.finishTime = (now - raceStartTime) / 1000;
                player.speed = 0;
                player.boosting = false;
            }
        }
        player.passedHalf = false;
    }
    player.checkpoint = seg;
}

function updatePlayer(player) {
    if (player.finished) { player.boosting = false; player.drift = false; player.oiled = false; player.padded = false; return; }

    const up = player.keys['ArrowUp'] || player.keys['KeyW'];
    const down = player.keys['ArrowDown'] || player.keys['KeyS'];
    const left = player.keys['ArrowLeft'] || player.keys['KeyA'];
    const right = player.keys['ArrowRight'] || player.keys['KeyD'];
    const wantBoost = !!(player.keys['Space']);

    const m = curMap();
    const onTrack = isOnTrack(player.x, player.y);
    // buz pisti: daha kaygan
    const iceMult = m.ice ? 0.45 : 1;
    let maxSpd = onTrack ? MAX_SPEED : OFF_TRACK_MAX_SPEED;
    // zor maplerde pist dışı cezası daha sert
    if (!onTrack && (m.diff || 1) >= 4) maxSpd *= 0.8;
    const fric = onTrack ? FRICTION * iceMult : OFF_TRACK_FRICTION;

    player.boosting = false;
    if (wantBoost && player.boost > 1 && (up || Math.abs(player.speed) > 0.5)) {
        player.speed += BOOST_ACCEL;
        maxSpd += BOOST_MAX_EXTRA;
        player.boost = Math.max(0, player.boost - BOOST_DRAIN);
        player.boosting = true;
    } else {
        player.boost = Math.min(100, player.boost + BOOST_REGEN);
    }

    if (up) player.speed += ACCEL;
    else if (down) player.speed -= BRAKE;

    const grip = Math.min(1, Math.abs(player.speed) / 2);
    const dir = player.speed >= 0 ? 1 : -1;
    const steering = (left ? -1 : 0) + (right ? 1 : 0);
    if (steering !== 0) {
        const mult = (player.boosting ? 1.15 : 1) * (m.ice ? 1.35 : 1);
        player.angle += steering * STEER_SPEED * grip * dir * mult;
    }
    player.drift = Math.abs(player.speed) > 3 && steering !== 0 && onTrack;

    // yağ lekesi: yavaşlat + savrul
    player.oiled = false;
    for (const o of oilSlicks) {
        const dx = player.x - o.x, dy = player.y - o.y;
        if (dx * dx + dy * dy < o.r * o.r) {
            player.speed *= 0.93;
            player.angle += (Math.random() - 0.5) * 0.09;
            player.oiled = true;
            break;
        }
    }
    // nitro pedi: otomatik itiş
    player.padded = false;
    for (const b of boostPads) {
        const dx = player.x - b.x, dy = player.y - b.y;
        if (dx * dx + dy * dy < b.r * b.r) {
            player.speed += 0.45;
            player.boost = Math.min(100, player.boost + 2);
            player.padded = true;
            break;
        }
    }

    player.speed *= (1 - fric);
    if (m.ice && onTrack) player.speed *= 0.998; // buzda uzun kayma
    if (Math.abs(player.speed) < 0.01) player.speed = 0;
    player.speed = Math.max(-maxSpd * 0.3, Math.min(maxSpd, player.speed));

    player.x += Math.cos(player.angle) * player.speed;
    player.y += Math.sin(player.angle) * player.speed;

    const info = getClosestTrackInfo(player.x, player.y);
    const w = curWidth();
    if (info.distance >= w / 2 + 5) {
        const cx = trackPoints[info.index].x - player.x;
        const cy = trackPoints[info.index].y - player.y;
        const len = Math.sqrt(cx * cx + cy * cy) || 1;
        const push = Math.max(0, (info.distance - w / 2) * 0.02);
        player.x += (cx / len) * push;
        player.y += (cy / len) * push;
    }

    checkLaps(player);
}

function collideCars() {
    const list = Array.from(players.values());
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            let dx = a.x - b.x, dy = a.y - b.y;
            let dist = Math.hypot(dx, dy);
            const minDist = CAR_RADIUS * 2;
            if (dist >= minDist) continue;
            if (dist < 0.001) { dx = 0.001; dy = 0; dist = 0.001; }
            const nx = dx / dist, ny = dy / dist;
            const overlap = minDist - dist;
            a.x += nx * overlap / 2; a.y += ny * overlap / 2;
            b.x -= nx * overlap / 2; b.y -= ny * overlap / 2;
            const avx = Math.cos(a.angle) * a.speed, avy = Math.sin(a.angle) * a.speed;
            const bvx = Math.cos(b.angle) * b.speed, bvy = Math.sin(b.angle) * b.speed;
            const rel = (avx - bvx) * nx + (avy - bvy) * ny;
            if (rel < 0) {
                const imp = -(1 + RESTITUTION) * rel / 2;
                const nax = avx + imp * nx, nay = avy + imp * ny;
                const nbx = bvx - imp * nx, nby = bvy - imp * ny;
                a.speed = nax * Math.cos(a.angle) + nay * Math.sin(a.angle);
                b.speed = nbx * Math.cos(b.angle) + nby * Math.sin(b.angle);
                a.speed = Math.max(-MAX_SPEED * 0.3, Math.min(MAX_SPEED, a.speed));
                b.speed = Math.max(-MAX_SPEED * 0.3, Math.min(MAX_SPEED, b.speed));
                a.collideFlash = Date.now();
                b.collideFlash = Date.now();
            }
        }
    }
}

function updatePhysics() {
    for (const [, player] of players) updatePlayer(player);
    collideCars();
    updatePositions();
}

function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function startCountdown() {
    clearCountdown();
    resetGame();
    gameState = 'COUNTDOWN';
    gameStartTime = Date.now();
    broadcast({ type: 'state', state: getState() });
    countdownTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
        if (elapsed >= COUNTDOWN_SECS) {
            clearCountdown();
            gameState = 'RACING';
            raceStartTime = Date.now();
            for (const [, p] of players) { p.lapStart = raceStartTime; p.earnedRace = 0; }
            broadcast({ type: 'state', state: getState() });
        } else {
            broadcast({ type: 'state', state: getState() });
        }
    }, 500);
}

function gameLoop() {
    const now = Date.now();
    lastTime = now;
    if (gameState === 'RACING') {
        updatePhysics();
        broadcast({ type: 'state', state: getState() });
        if (players.size >= 1 && Array.from(players.values()).every(p => p.finished)) {
            awardCoins();
            gameState = 'FINISHED';
            broadcast({ type: 'state', state: getState() });
        }
    }
    setTimeout(gameLoop, 1000 / 30);
}

function resetGame() {
    for (const [, player] of players) {
        const s = spawnForSlot(player.id % MAX_PLAYERS);
        player.x = s.x; player.y = s.y; player.angle = s.angle;
        player.speed = 0; player.lap = 0; player.checkpoint = s.seg; player.passedHalf = false;
        player.finished = false; player.finishTime = null; player.keys = {}; player.position = 0;
        player.boost = 100; player.boosting = false; player.drift = false;
        player.lastLap = null; player.bestLap = null; player.lapStart = 0;
        player.oiled = false; player.padded = false; player.earnedRace = 0;
    }
    updatePositions();
}

wss.on('connection', (ws) => {
    if (players.size >= MAX_PLAYERS) {
        send(ws, { type: 'error', message: 'Oyun dolu! Bekleyin...' });
        ws.close();
        return;
    }

    const playerId = nextPlayerId++;
    const player = createPlayer(playerId, null, ws);
    players.set(playerId, player);
    if (players.size === 1) { player.name = 'Siz'; player.isHost = true; }

    send(ws, {
        type: 'connected', playerId,
        player: { id: player.id, name: player.name, color: player.color, skin: player.skin, isHost: player.isHost, coins: player.coins, owned: player.owned, equipped: player.equipped },
        state: getState(),
    });
    broadcast({ type: 'players', state: getState() }, ws);

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            switch (data.type) {
                case 'set_name':
                    if (players.has(playerId) && typeof data.name === 'string') {
                        players.get(playerId).name = data.name.slice(0, 16) || ('Sürücü ' + (playerId + 1));
                        broadcast({ type: 'player_update', state: getState() });
                    }
                    break;
                case 'set_custom':
                    if (players.has(playerId)) {
                        const p = players.get(playerId);
                        if (validColor(data.color)) p.color = data.color;
                        if (validSkin(data.skin)) p.skin = data.skin;
                        if (typeof data.name === 'string' && data.name.length) {
                            p.name = data.name.slice(0, 16);
                        }
                        if (data.equipped && typeof data.equipped === 'object') {
                            for (const cat of ['trail', 'nitro', 'glow']) {
                                const v = data.equipped[cat];
                                if (typeof v === 'string' && (p.owned[cat] || []).includes(v)) p.equipped[cat] = v;
                            }
                        }
                        broadcast({ type: 'player_update', state: getState() });
                    }
                    break;
                case 'buy_effect': {
                    const p = players.get(playerId);
                    if (!p) break;
                    const cat = data.category, id = data.id;
                    const item = shopItem(cat, id);
                    if (!item) break;
                    p.owned[cat] = p.owned[cat] || [];
                    if (p.owned[cat].includes(id)) break;
                    if ((p.coins || 0) < item.price) {
                        send(ws, { type: 'shop_error', message: 'Yetersiz coin! Yarış bitirip coin kazan.' });
                        break;
                    }
                    p.coins -= item.price;
                    p.owned[cat].push(id);
                    p.equipped[cat] = id;
                    broadcast({ type: 'player_update', state: getState() });
                    break;
                }
                case 'equip_effect': {
                    const p = players.get(playerId);
                    if (!p) break;
                    const cat = data.category, id = data.id;
                    if ((p.owned[cat] || []).includes(id)) {
                        p.equipped[cat] = id;
                        broadcast({ type: 'player_update', state: getState() });
                    }
                    break;
                }
                case 'set_map':
                    if (players.get(playerId) && players.get(playerId).isHost && gameState === 'LOBBY') {
                        if (MAPS[data.mapId] || CUSTOM_MAPS.has(data.mapId)) {
                            currentMapId = data.mapId;
                            generateTrack(currentMapId);
                            resetGame();
                            broadcast({ type: 'state', state: getState() });
                        }
                    }
                    break;
                case 'save_map': {
                    const p = players.get(playerId);
                    if (!p) break;
                    const ownerId = typeof data.ownerId === 'string' ? data.ownerId.slice(0, 40) : '';
                    if (!ownerId) {
                        send(ws, { type: 'map_error', message: 'Kimlik eksik, sayfayı yenile.' });
                        break;
                    }
                    const editId = (data.map && typeof data.map.editId === 'string') ? data.map.editId : null;
                    let existing = null;
                    if (editId) {
                        existing = CUSTOM_MAPS.get(editId);
                        if (!existing) {
                            send(ws, { type: 'map_error', message: 'Düzenlenen map bulunamadı.' });
                            break;
                        }
                        if (existing.ownerId !== ownerId) {
                            send(ws, { type: 'map_error', message: 'Sadece sahibin düzenleyebilir!' });
                            break;
                        }
                    } else {
                        if (CUSTOM_MAPS.size >= 50) {
                            send(ws, { type: 'map_error', message: 'Map dükkanı dolu (max 50)! Önce eski map sil.' });
                            break;
                        }
                        const mine = Array.from(CUSTOM_MAPS.values()).filter(m => m.ownerId === ownerId).length;
                        if (mine >= 10) {
                            send(ws, { type: 'map_error', message: 'En fazla 10 map kaydedebilirsin! Önce birini sil.' });
                            break;
                        }
                    }
                    const v = validateCustomMapInput(data.map);
                    if (typeof v === 'string') {
                        send(ws, { type: 'map_error', message: v });
                        break;
                    }
                    const ctrl = data.map.points.map(pt => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
                    let sampled = catmullResample(ctrl, TRACK_SEGMENTS).map(pt => ({ x: Math.round(pt.x * 10) / 10, y: Math.round(pt.y * 10) / 10 }));
                    // start çizgisi seçildiyse diziyi döndür
                    if (v.startCtrl >= 0) {
                        const anchor = ctrl[v.startCtrl];
                        let bi = 0, bd = Infinity;
                        sampled.forEach((s, i) => {
                            const d = (s.x - anchor.x) * (s.x - anchor.x) + (s.y - anchor.y) * (s.y - anchor.y);
                            if (d < bd) { bd = d; bi = i; }
                        });
                        sampled = sampled.slice(bi).concat(sampled.slice(0, bi));
                    }
                    // engeller: manuel yerleştirme varsa onu kullan
                    let oilSpots = null, padSpots = null;
                    const hasManual = data.map && Array.isArray(data.map.oilSpots) && Array.isArray(data.map.padSpots);
                    if (hasManual) {
                        if (data.map.oilSpots.length > 16 || data.map.padSpots.length > 8) {
                            send(ws, { type: 'map_error', message: 'Engel limiti aşıldı (yağ max 16, ped max 8).' });
                            break;
                        }
                        const angs = anglesFor(sampled);
                        const checkSpot = (s, label) => {
                            if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') return label + ' konumu bozuk!';
                            if (s.x < 20 || s.x > 1180 || s.y < 20 || s.y > 780) return label + ' alan dışında!';
                            if (distToSamples(sampled, s.x, s.y) > v.width / 2 + 90) return label + ' pistten çok uzakta!';
                            return null;
                        };
                        let err = null;
                        for (const s of data.map.oilSpots) { err = checkSpot(s, 'Yağ'); if (err) break; }
                        if (!err) for (const s of data.map.padSpots) { err = checkSpot(s, 'Ped'); if (err) break; }
                        if (err) {
                            send(ws, { type: 'map_error', message: err });
                            break;
                        }
                        const nearestAng = (s) => {
                            let bi = 0, bd = Infinity;
                            sampled.forEach((t, i) => {
                                const d = (t.x - s.x) * (t.x - s.x) + (t.y - s.y) * (t.y - s.y);
                                if (d < bd) { bd = d; bi = i; }
                            });
                            return Math.round(angs[bi] * 1000) / 1000;
                        };
                        oilSpots = data.map.oilSpots.map(s => ({ x: Math.round(s.x), y: Math.round(s.y) }));
                        padSpots = data.map.padSpots.map(s => ({ x: Math.round(s.x), y: Math.round(s.y), angle: nearestAng(s) }));
                    }
                    const preview = [];
                    for (let i = 0; i < sampled.length; i += 9) preview.push({ x: Math.round(sampled[i].x), y: Math.round(sampled[i].y) });
                    const diff = v.width <= 64 ? 5 : v.width <= 76 ? 4 : v.width <= 90 ? 3 : 2;
                    if (existing) {
                        Object.assign(existing, {
                            name: v.name, width: v.width, laps: v.laps,
                            oil: hasManual ? oilSpots.length : v.oil, pads: hasManual ? padSpots.length : v.pads,
                            oilSpots, padSpots, ice: v.ice, theme: v.theme, startCtrl: v.startCtrl,
                            ctrl, points: sampled, preview, diff,
                        });
                    } else {
                        const id = 'c_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
                        CUSTOM_MAPS.set(id, {
                            id, name: v.name, author: (p.name || 'Oyuncu').slice(0, 16), ownerId,
                            width: v.width, laps: v.laps,
                            oil: hasManual ? oilSpots.length : v.oil, pads: hasManual ? padSpots.length : v.pads,
                            oilSpots, padSpots, ice: v.ice, theme: v.theme, startCtrl: v.startCtrl,
                            diff, ctrl, points: sampled, preview, createdAt: Date.now(),
                        });
                    }
                    persistCustomMaps();
                    const savedId = existing ? existing.id : Array.from(CUSTOM_MAPS.keys()).pop();
                    if (existing && currentMapId === existing.id && gameState === 'LOBBY') {
                        generateTrack(currentMapId);
                        resetGame();
                    }
                    broadcast({ type: 'state', state: getState() });
                    send(ws, { type: 'map_saved', mapId: savedId });
                    break;
                }
                case 'get_map': {
                    const m = CUSTOM_MAPS.get(data.mapId);
                    if (!m) {
                        send(ws, { type: 'map_error', message: 'Map bulunamadı.' });
                        break;
                    }
                    send(ws, {
                        type: 'map_data',
                        map: {
                            id: m.id, name: m.name, ctrl: m.ctrl || [], width: m.width, laps: m.laps,
                            oilSpots: m.oilSpots || null, padSpots: m.padSpots || null,
                            oil: m.oil || 0, pads: m.pads || 0,
                            ice: !!m.ice, theme: m.theme || 'klasik',
                            startCtrl: (m.startCtrl == null ? -1 : m.startCtrl), ownerId: m.ownerId,
                        },
                    });
                    break;
                }
                case 'delete_map': {
                    const id = data.mapId;
                    const m = CUSTOM_MAPS.get(id);
                    if (!m) {
                        send(ws, { type: 'map_error', message: 'Map bulunamadı.' });
                        break;
                    }
                    const ownerId = typeof data.ownerId === 'string' ? data.ownerId.slice(0, 40) : '';
                    if (!ownerId || m.ownerId !== ownerId) {
                        send(ws, { type: 'map_error', message: 'Sadece mapin sahibi silebilir!' });
                        break;
                    }
                    CUSTOM_MAPS.delete(id);
                    persistCustomMaps();
                    if (currentMapId === id) {
                        currentMapId = 'klasik';
                        generateTrack(currentMapId);
                        resetGame();
                    }
                    broadcast({ type: 'state', state: getState() });
                    break;
                }
                case 'input':
                    if (players.has(playerId) && data.keys && typeof data.keys === 'object') {
                        players.get(playerId).keys = data.keys;
                    }
                    break;
                case 'start_race':
                    if (players.get(playerId) && players.get(playerId).isHost && gameState === 'LOBBY') startCountdown();
                    break;
                case 'reset':
                    if (players.get(playerId) && players.get(playerId).isHost) {
                        clearCountdown();
                        gameState = 'LOBBY';
                        resetGame();
                        broadcast({ type: 'state', state: getState() });
                    }
                    break;
            }
        } catch (e) { /* bozuk mesajı yoksay */ }
    });

    ws.on('close', () => {
        const wasHost = player.isHost;
        players.delete(playerId);
        if (wasHost && players.size > 0) {
            const next = Array.from(players.values()).sort((a, b) => a.id - b.id)[0];
            next.isHost = true;
        }
        if (players.size === 0) {
            clearCountdown();
            gameState = 'LOBBY';
            resetGame();
        }
        broadcast({ type: 'player_left', state: getState() });
    });
});

server.listen(PORT, () => { console.log('Race server running at http://localhost:' + PORT); gameLoop(); });
