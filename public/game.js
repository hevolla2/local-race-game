const CAR_W = 22;
const CAR_H = 40;
const WORLD_W = 1200;
const WORLD_H = 800;
const GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];

const PRESET_COLORS = ['#ff4444', '#44ff44', '#4488ff', '#ffaa00', '#ff44ff', '#44ffff', '#ff8844', '#88ff44'];
const SKIN_LIST = [
    { id: 'klasik', name: 'Klasik', icon: '🚗' },
    { id: 'formula', name: 'Formula', icon: '🏎️' },
    { id: 'spor', name: 'Spor', icon: '🚙' },
    { id: 'retro', name: 'Retro', icon: '🚕' },
];
const MAP_THEMES = {
    klasik: { grass: '#1d2b1f', grass2: '#223322', asphalt: '#3d3d3d' },
    dalgali: { grass: '#1a2b26', grass2: '#1e332c', asphalt: '#3a3a40' },
    teknik: { grass: '#2b2417', grass2: '#332b1c', asphalt: '#434343' },
    hizli: { grass: '#141c2b', grass2: '#182234', asphalt: '#46464e' },
    buz: { grass: '#1a2636', grass2: '#203145', asphalt: '#4a5568' },
    cehennem: { grass: '#2b1414', grass2: '#381a1a', asphalt: '#3d3232' },
};
const SHOP_CATS = { trail: '💨 Egzoz', nitro: '🔥 Nitro', glow: '💡 Glow' };

class RaceGame {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.minimap = document.getElementById('minimap');
        this.mmCtx = this.minimap ? this.minimap.getContext('2d') : null;
        this.preview = document.getElementById('skinPreview');
        this.cam = { scale: 1, ox: 0, oy: 0, shake: 0 };
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());

        this.state = { state: 'LOBBY', players: [], maxPlayers: 4, trackPoints: [], trackWidth: 100, totalLaps: 3, countDown: 0, mapId: 'klasik', maps: {}, shop: {}, oilSlicks: [], boostPads: [] };

        this.myId = null;
        this.isHost = false;
        this.keys = {};
        this.ws = null;
        this.raceStartTime = null;
        this.lastRenderedState = null;
        this.raceComplete = false;
        this.lobbyCacheKey = '';
        this.lastCountBeep = -1;

        this.myColor = localStorage.getItem('race_color') || PRESET_COLORS[0];
        this.mySkin = localStorage.getItem('race_skin') || 'klasik';
        this.myName = localStorage.getItem('race_name') || '';
        this.myCoins = 100;
        this.myOwned = { trail: ['duman'], nitro: ['klasik'], glow: ['yok'] };
        this.myEquipped = JSON.parse(localStorage.getItem('race_equipped') || '{"trail":"duman","nitro":"klasik","glow":"yok"}');
        this.shopTab = 'trail';
        this.mapTab = 'builtin';
        this.hue = 0;
        if (!localStorage.getItem('race_owner')) {
            localStorage.setItem('race_owner', 'o_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
        }
        this.ownerId = localStorage.getItem('race_owner');
        this.editor = { points: [], oilSpots: [], padSpots: [], tool: 'track', drag: null, selected: null, snap: false, editId: null, startCtrl: -1 };

        this.particles = [];
        this.skids = [];
        this.prevSpeeds = new Map();
        this.audio = null;

        this.setupEventListeners();
        this.buildPickers();
        this.setupShopTabs();
        this.setupMapTabs();
        this.setupEditor();
        this.showNetInfo();
        this.connectToServer();
        this.gameLoop();
    }

    ensureAudio() {
        if (!this.audio) {
            try { this.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* yok */ }
        }
        if (this.audio && this.audio.state === 'suspended') this.audio.resume();
    }
    beep(freq, dur, vol) {
        try {
            this.ensureAudio();
            if (!this.audio) return;
            const o = this.audio.createOscillator();
            const g = this.audio.createGain();
            o.type = 'square'; o.frequency.value = freq;
            g.gain.value = vol || 0.06;
            o.connect(g); g.connect(this.audio.destination);
            o.start();
            g.gain.exponentialRampToValueAtTime(0.001, this.audio.currentTime + dur);
            o.stop(this.audio.currentTime + dur);
        } catch (e) { /* sessiz geç */ }
    }

    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.cam.scale = Math.min(this.canvas.width / WORLD_W, this.canvas.height / WORLD_H);
        this.cam.ox = (this.canvas.width - WORLD_W * this.cam.scale) / 2;
        this.cam.oy = (this.canvas.height - WORLD_H * this.cam.scale) / 2;
    }

    showNetInfo() {
        const el = document.getElementById('netInfo');
        if (!el) return;
        if (window.location.protocol === 'file:') {
            el.textContent = 'Dosya olarak açıldı — önce sunucuyu çalıştırıp http://localhost:8080 adresinden girin.';
            return;
        }
        const host = window.location.hostname || 'localhost';
        const port = window.location.port || '8080';
        el.textContent = 'Aynı Wi-Fi’deki diğer PC’ler şu adresten katılsın: http://' + host + ':' + port;
    }

    // ---------- market ----------
    setupShopTabs() {
        document.querySelectorAll('.shop-tab').forEach(b => {
            b.addEventListener('click', () => {
                this.shopTab = b.dataset.tab;
                document.querySelectorAll('.shop-tab').forEach(x => x.classList.toggle('active', x === b));
                this.buildShop();
                this.ensureAudio(); this.beep(500, 0.06);
            });
        });
    }
    buildShop() {
        const box = document.getElementById('shopItems');
        if (!box) return;
        const items = (this.state.shop && this.state.shop[this.shopTab]) || [];
        box.innerHTML = '';
        if (!items.length) { box.innerHTML = '<div class="shop-empty">Sunucu bekleniyor...</div>'; return; }
        items.forEach(it => {
            const owned = (this.myOwned[this.shopTab] || []).includes(it.id);
            const equipped = this.myEquipped[this.shopTab] === it.id;
            const b = document.createElement('button');
            b.className = 'shop-item' + (equipped ? ' equipped' : '') + (owned ? ' owned' : '');
            b.innerHTML = '<span class="s-ico">' + it.icon + '</span><span class="s-name">' + it.name + '</span>' +
                '<span class="s-price">' + (owned ? (equipped ? '✔ Kuşanıldı' : 'Kuşan') : ('🪙 ' + it.price)) + '</span>';
            b.addEventListener('click', () => {
                this.ensureAudio();
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                if (!owned) this.ws.send(JSON.stringify({ type: 'buy_effect', category: this.shopTab, id: it.id }));
                else {
                    this.ws.send(JSON.stringify({ type: 'equip_effect', category: this.shopTab, id: it.id }));
                    this.myEquipped[this.shopTab] = it.id;
                    localStorage.setItem('race_equipped', JSON.stringify(this.myEquipped));
                    this.pushCustom(); this.buildShop(); this.drawPreview();
                }
            });
            box.appendChild(b);
        });
        const cb = document.getElementById('coinBadge');
        if (cb) cb.textContent = '🪙 ' + this.myCoins;
    }

    // ---------- lobby seçim UI ----------
    buildPickers() {
        const sw = document.getElementById('colorSwatches');
        sw.innerHTML = '';
        PRESET_COLORS.forEach(c => {
            const b = document.createElement('button');
            b.className = 'swatch' + (c.toLowerCase() === String(this.myColor).toLowerCase() ? ' active' : '');
            b.style.background = c;
            b.title = c;
            b.addEventListener('click', () => {
                this.myColor = c;
                localStorage.setItem('race_color', c);
                document.getElementById('customColor').value = c;
                this.refreshPickerActive();
                this.pushCustom();
                this.drawPreview();
            });
            sw.appendChild(b);
        });
        const cc = document.getElementById('customColor');
        cc.value = this.myColor;
        cc.addEventListener('input', (e) => {
            this.myColor = e.target.value;
            localStorage.setItem('race_color', this.myColor);
            this.refreshPickerActive();
            this.pushCustom();
            this.drawPreview();
        });

        const sp = document.getElementById('skinPicker');
        sp.innerHTML = '';
        SKIN_LIST.forEach(s => {
            const b = document.createElement('button');
            b.className = 'skin-btn' + (s.id === this.mySkin ? ' active' : '');
            b.dataset.skin = s.id;
            b.innerHTML = '<span class="ico">' + s.icon + '</span><span>' + s.name + '</span>';
            b.addEventListener('click', () => {
                this.mySkin = s.id;
                localStorage.setItem('race_skin', s.id);
                this.ensureAudio();
                this.beep(600, 0.07);
                this.refreshPickerActive();
                this.pushCustom();
                this.drawPreview();
            });
            sp.appendChild(b);
        });
        this.drawPreview();
    }

    refreshPickerActive() {
        document.querySelectorAll('#colorSwatches .swatch').forEach(el => {
            el.classList.toggle('active', el.title.toLowerCase() === String(this.myColor).toLowerCase());
        });
        document.querySelectorAll('#skinPicker .skin-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.skin === this.mySkin);
        });
        document.querySelectorAll('#mapPicker .map-btn').forEach(el => {
            el.classList.toggle('active', el.dataset.map === this.state.mapId);
        });
    }

    setupMapTabs() {
        document.querySelectorAll('.map-tab').forEach(b => {
            b.addEventListener('click', () => {
                this.mapTab = b.dataset.tab;
                document.querySelectorAll('.map-tab').forEach(x => x.classList.toggle('active', x === b));
                this.buildMapPicker();
                this.ensureAudio(); this.beep(500, 0.06);
            });
        });
    }

    customMapsList() {
        return Object.entries(this.state.maps || {})
            .filter(([, m]) => m.custom)
            .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    }

    buildMapPicker() {
        const mp = document.getElementById('mapPicker');
        if (!mp) return;
        const maps = this.state.maps || {};
        if (maps[this.state.mapId] && maps[this.state.mapId].custom) this.mapTab = 'custom';
        const cc = document.getElementById('customCount');
        if (cc) cc.textContent = this.customMapsList().length;
        document.querySelectorAll('.map-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === this.mapTab));
        mp.innerHTML = '';
        const mkBtn = (id, meta) => {
            const stars = '★'.repeat(meta.diff || 1) + '☆'.repeat(Math.max(0, 5 - (meta.diff || 1)));
            const b = document.createElement('button');
            b.className = 'map-btn diff' + (meta.diff || 1) + (id === this.state.mapId ? ' active' : '');
            b.dataset.map = id;
            b.innerHTML = '<b></b><small></small>';
            b.querySelector('b').textContent = (meta.name || id) + '  ' + stars;
            b.querySelector('small').textContent = (meta.desc || '') + ' • ' + meta.laps + ' tur • ' + meta.width + 'px';
            b.disabled = !this.isHost;
            b.title = this.isHost ? 'Pisti değiştir' : 'Sadece host değiştirebilir';
            b.addEventListener('click', () => {
                if (!this.isHost) return;
                this.ensureAudio();
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'set_map', mapId: id }));
                }
            });
            return b;
        };
        if (this.mapTab === 'custom') {
            const list = this.customMapsList();
            if (!list.length) {
                mp.innerHTML = '<div class="shop-empty">Henüz oyuncu mapi yok.<br>🛠️ butonuyla ilk pisti sen yap!</div>';
            }
            list.forEach(([id, meta]) => {
                const card = document.createElement('div');
                card.className = 'cmap-card' + (id === this.state.mapId ? ' active' : '');
                const cv = document.createElement('canvas');
                cv.width = 160; cv.height = 100; cv.className = 'cmap-thumb';
                card.appendChild(cv);
                this.drawThumb(cv, meta.preview || []);
                const info = document.createElement('div');
                info.className = 'cmap-info';
                const mine = meta.ownerId && meta.ownerId === this.ownerId;
                info.innerHTML = '<b></b><small></small>';
                info.querySelector('b').textContent = meta.name + (id === this.state.mapId ? ' ✔' : '');
                info.querySelector('small').textContent = '👤 ' + (meta.author || '?') + ' • ' + meta.laps + ' tur • ' + meta.width + 'px' + (meta.ice ? ' • 🧊' : '');
                card.appendChild(info);
                const row = document.createElement('div');
                row.className = 'cmap-row';
                const play = document.createElement('button');
                play.className = 'small'; play.textContent = '▶ Seç';
                play.disabled = !this.isHost;
                play.title = this.isHost ? 'Bu pistte yarış' : 'Sadece host seçebilir';
                play.addEventListener('click', () => {
                    if (!this.isHost) return;
                    this.ws.send(JSON.stringify({ type: 'set_map', mapId: id }));
                });
                row.appendChild(play);
                if (mine) {
                    const edt = document.createElement('button');
                    edt.className = 'small'; edt.textContent = '✏️ Düzenle';
                    edt.title = 'Mapi düzenle';
                    edt.addEventListener('click', () => {
                        this.ws.send(JSON.stringify({ type: 'get_map', mapId: id }));
                    });
                    row.appendChild(edt);
                    const del = document.createElement('button');
                    del.className = 'small danger'; del.textContent = '🗑 Sil';
                    del.title = 'Kendi mapini sil';
                    del.addEventListener('click', () => {
                        if (!confirm('"' + meta.name + '" silinsin mi?')) return;
                        this.ws.send(JSON.stringify({ type: 'delete_map', mapId: id, ownerId: this.ownerId }));
                    });
                    row.appendChild(del);
                }
                card.appendChild(row);
                mp.appendChild(card);
            });
        } else {
            Object.keys(maps).filter(id => !maps[id].custom).forEach(id => mp.appendChild(mkBtn(id, maps[id])));
        }
        const desc = document.getElementById('mapDesc');
        if (desc) {
            const cur = maps[this.state.mapId];
            desc.textContent = cur ? (cur.name + ' — ' + cur.desc + ' (' + cur.laps + ' tur)') : '';
        }
        const badge = document.getElementById('mapHostBadge');
        if (badge) badge.style.display = this.isHost ? 'none' : 'inline-block';
    }

    drawThumb(cv, preview) {
        const c = cv.getContext('2d');
        c.fillStyle = '#101418'; c.fillRect(0, 0, cv.width, cv.height);
        if (!preview.length) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        preview.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
        const sc = Math.min((cv.width - 16) / (maxX - minX || 1), (cv.height - 16) / (maxY - minY || 1));
        const ox = (cv.width - (maxX - minX) * sc) / 2, oy = (cv.height - (maxY - minY) * sc) / 2;
        c.strokeStyle = '#00d4ff'; c.lineWidth = 4; c.lineJoin = 'round';
        c.beginPath();
        preview.forEach((p, i) => {
            const x = ox + (p.x - minX) * sc, y = oy + (p.y - minY) * sc;
            if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        });
        c.closePath(); c.stroke();
    }

    // ---------- MAP EDİTÖRÜ ----------
    setEditorTool(t) {
        this.editor.tool = t;
        document.querySelectorAll('.etool').forEach(x => x.classList.toggle('active', x.dataset.tool === t));
        const hints = {
            track: 'Tıkla: nokta ekle • Sürükle: taşı • Çift tık: sil • Eğriye yakın tıkla: araya ekle • Ok tuşları: seçiliyi kaydır',
            oil: 'Tıkla: yağ lekesi koy (max 16) • Sürükle: taşı • Çift tık: sil',
            pad: 'Tıkla: nitro pedi koy (max 8) • Sürükle: taşı • Çift tık: sil',
            start: 'Bir pist noktasına tıkla: 🏁 START oraya taşınır',
        };
        document.getElementById('editorHint').textContent = hints[t] || '';
    }

    snapV(v) { return this.editor.snap ? Math.round(v / 10) * 10 : Math.round(v); }

    editorCurveTagged() {
        const pts = this.editor.points;
        if (pts.length < 3) return pts.map((p, i) => ({ x: p.x, y: p.y, seg: i }));
        const out = [];
        const m = pts.length;
        for (let i = 0; i < m; i++) {
            const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
            for (let j = 0; j < 12; j++) {
                const t = j / 12, t2 = t * t, t3 = t2 * t;
                out.push({
                    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
                    seg: i,
                });
            }
        }
        return out;
    }

    setupEditor() {
        const modal = document.getElementById('editorModal');
        const cv = document.getElementById('editorCanvas');
        if (!modal || !cv) return;
        const SX = cv.width / WORLD_W, SY = cv.height / WORLD_H;
        const clampT = (w) => ({ x: this.snapV(Math.max(40, Math.min(1160, w.x))), y: this.snapV(Math.max(40, Math.min(760, w.y))) });
        const clampS = (w) => ({ x: this.snapV(Math.max(20, Math.min(1180, w.x))), y: this.snapV(Math.max(20, Math.min(780, w.y))) });
        const toWorld = (e) => {
            const r = cv.getBoundingClientRect();
            return {
                x: (e.clientX - r.left) * (cv.width / r.width) / SX,
                y: (e.clientY - r.top) * (cv.height / r.height) / SY,
            };
        };
        const nearCtrl = (w, tol) => {
            let bi = -1, bd = tol;
            this.editor.points.forEach((p, i) => {
                const d = Math.hypot(p.x - w.x, p.y - w.y);
                if (d < bd) { bd = d; bi = i; }
            });
            return bi;
        };
        const nearSpot = (arr, w, tol) => {
            let bi = -1, bd = tol;
            arr.forEach((p, i) => {
                const d = Math.hypot(p.x - w.x, p.y - w.y);
                if (d < bd) { bd = d; bi = i; }
            });
            return bi;
        };

        document.querySelectorAll('.etool').forEach(b => {
            b.addEventListener('click', () => { this.setEditorTool(b.dataset.tool); this.ensureAudio(); });
        });

        cv.addEventListener('pointerdown', (e) => {
            cv.setPointerCapture(e.pointerId);
            const w = toWorld(e);
            const tool = this.editor.tool;
            if (tool === 'start') {
                const i = nearCtrl(w, 36 / SX);
                if (i >= 0) {
                    this.editor.startCtrl = i;
                    this.editor.selected = { kind: 'track', idx: i };
                    this.beep(880, 0.08);
                    this.drawEditor();
                }
                return;
            }
            if (tool === 'oil' || tool === 'pad') {
                const arr = tool === 'oil' ? this.editor.oilSpots : this.editor.padSpots;
                const lim = tool === 'oil' ? 16 : 8;
                const i = nearSpot(arr, w, 26 / SX);
                if (i >= 0) {
                    this.editor.drag = { kind: tool, idx: i };
                    this.editor.selected = { kind: tool, idx: i };
                } else if (arr.length < lim) {
                    arr.push(clampS(w));
                    this.editor.selected = { kind: tool, idx: arr.length - 1 };
                    this.beep(700, 0.05);
                } else {
                    this.beep(200, 0.1);
                }
                this.drawEditor();
                return;
            }
            // pist aracı
            const i = nearCtrl(w, 22 / SX);
            if (i >= 0) {
                this.editor.drag = { kind: 'track', idx: i };
                this.editor.selected = { kind: 'track', idx: i };
            } else if (this.editor.points.length < 30) {
                const c = clampT(w);
                if (this.editor.points.length >= 3) {
                    const curve = this.editorCurveTagged();
                    let bs = 0, bd = Infinity;
                    curve.forEach(s => {
                        const d = Math.hypot(s.x - w.x, s.y - w.y);
                        if (d < bd) { bd = d; bs = s.seg; }
                    });
                    if (bd < 32 / SX) {
                        this.editor.points.splice(bs + 1, 0, c);
                        this.editor.selected = { kind: 'track', idx: bs + 1 };
                        if (this.editor.startCtrl > bs) this.editor.startCtrl++;
                    } else {
                        this.editor.points.push(c);
                        this.editor.selected = { kind: 'track', idx: this.editor.points.length - 1 };
                    }
                } else {
                    this.editor.points.push(c);
                    this.editor.selected = { kind: 'track', idx: this.editor.points.length - 1 };
                }
                this.beep(700, 0.05);
            }
            this.drawEditor();
        });
        cv.addEventListener('pointermove', (e) => {
            const dr = this.editor.drag;
            if (!dr) return;
            const w = toWorld(e);
            if (dr.kind === 'track') this.editor.points[dr.idx] = clampT(w);
            else if (dr.kind === 'oil') this.editor.oilSpots[dr.idx] = clampS(w);
            else if (dr.kind === 'pad') this.editor.padSpots[dr.idx] = clampS(w);
            this.drawEditor();
        });
        cv.addEventListener('pointerup', () => { this.editor.drag = null; });
        cv.addEventListener('dblclick', (e) => {
            const w = toWorld(e);
            let i = nearSpot(this.editor.oilSpots, w, 26 / SX);
            if (i >= 0) { this.editor.oilSpots.splice(i, 1); this.editor.selected = null; this.drawEditor(); return; }
            i = nearSpot(this.editor.padSpots, w, 26 / SX);
            if (i >= 0) { this.editor.padSpots.splice(i, 1); this.editor.selected = null; this.drawEditor(); return; }
            i = nearCtrl(w, 22 / SX);
            if (i >= 0) {
                this.editor.points.splice(i, 1);
                if (this.editor.startCtrl === i) this.editor.startCtrl = -1;
                else if (this.editor.startCtrl > i) this.editor.startCtrl--;
                this.editor.selected = null;
                this.drawEditor();
            }
        });

        // klavye ile ince kaydırma (Shift = 2px)
        window.addEventListener('keydown', (e) => {
            if (!modal || modal.style.display !== 'flex') return;
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
            const sel = this.editor.selected;
            if (e.code === 'Escape') { this.editor.selected = null; this.drawEditor(); return; }
            if (!sel) return;
            const step = e.shiftKey ? 2 : 8;
            let dx = 0, dy = 0;
            if (e.code === 'ArrowUp') dy = -step;
            else if (e.code === 'ArrowDown') dy = step;
            else if (e.code === 'ArrowLeft') dx = -step;
            else if (e.code === 'ArrowRight') dx = step;
            else if ((e.code === 'Delete' || e.code === 'Backspace') && sel.kind === 'track') {
                this.editor.points.splice(sel.idx, 1);
                if (this.editor.startCtrl === sel.idx) this.editor.startCtrl = -1;
                else if (this.editor.startCtrl > sel.idx) this.editor.startCtrl--;
                this.editor.selected = null;
                this.drawEditor();
                e.preventDefault();
                return;
            } else return;
            const cur = sel.kind === 'track' ? this.editor.points[sel.idx]
                : sel.kind === 'oil' ? this.editor.oilSpots[sel.idx] : this.editor.padSpots[sel.idx];
            if (!cur) return;
            const np = (sel.kind === 'track' ? clampT : clampS)({ x: cur.x + dx, y: cur.y + dy });
            if (sel.kind === 'track') this.editor.points[sel.idx] = np;
            else if (sel.kind === 'oil') this.editor.oilSpots[sel.idx] = np;
            else this.editor.padSpots[sel.idx] = np;
            this.drawEditor();
            e.preventDefault();
        });

        // şablonlar
        const tpl = (kind) => {
            const pts = [];
            const n = kind === 'star' ? 10 : 12;
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2 - Math.PI / 2;
                let r;
                if (kind === 'wave') r = 1 + 0.22 * Math.sin(a * 3);
                else if (kind === 'star') r = (i % 2 === 0) ? 1 : 0.62;
                else r = 1;
                pts.push({
                    x: Math.max(40, Math.min(1160, Math.round(600 + Math.cos(a) * 380 * r * 1.15))),
                    y: Math.max(40, Math.min(760, Math.round(400 + Math.sin(a) * 380 * r * 0.68))),
                });
            }
            this.editor.points = pts;
            this.editor.startCtrl = -1;
            this.editor.selected = null;
            this.drawEditor();
        };
        document.getElementById('tplOval').addEventListener('click', () => tpl('oval'));
        document.getElementById('tplWave').addEventListener('click', () => tpl('wave'));
        document.getElementById('tplStar').addEventListener('click', () => tpl('star'));
        document.getElementById('edMirrorH').addEventListener('click', () => {
            this.editor.points.forEach(p => { p.x = 1200 - p.x; });
            this.editor.oilSpots.forEach(p => { p.x = 1200 - p.x; });
            this.editor.padSpots.forEach(p => { p.x = 1200 - p.x; });
            this.drawEditor();
        });
        document.getElementById('edMirrorV').addEventListener('click', () => {
            this.editor.points.forEach(p => { p.y = 800 - p.y; });
            this.editor.oilSpots.forEach(p => { p.y = 800 - p.y; });
            this.editor.padSpots.forEach(p => { p.y = 800 - p.y; });
            this.drawEditor();
        });
        document.getElementById('edSnap').addEventListener('change', (e) => { this.editor.snap = e.target.checked; });

        document.getElementById('openEditorBtn').addEventListener('click', () => {
            this.ensureAudio();
            this.editor.points = [];
            this.editor.oilSpots = [];
            this.editor.padSpots = [];
            this.editor.startCtrl = -1;
            this.editor.editId = null;
            this.editor.selected = null;
            this.setEditorTool('track');
            document.getElementById('editorName').value = '';
            document.getElementById('editorTitle').textContent = '🛠️ Map Editörü';
            modal.style.display = 'flex';
            this.drawEditor();
        });
        document.getElementById('editorClose').addEventListener('click', () => { modal.style.display = 'none'; });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
        document.getElementById('editorUndo').addEventListener('click', () => { this.editor.points.pop(); this.drawEditor(); });
        document.getElementById('editorClear').addEventListener('click', () => { this.editor.points = []; this.editor.startCtrl = -1; this.editor.selected = null; this.drawEditor(); });
        document.getElementById('edClearSpots').addEventListener('click', () => { this.editor.oilSpots = []; this.editor.padSpots = []; this.drawEditor(); });
        [['edWidth', 'edWidthVal'], ['edLaps', 'edLapsVal']].forEach(([a, b]) => {
            document.getElementById(a).addEventListener('input', (e) => { document.getElementById(b).textContent = e.target.value; this.drawEditor(); });
        });
        document.getElementById('edTheme').addEventListener('change', () => this.drawEditor());
        document.getElementById('editorSave').addEventListener('click', () => {
            const name = document.getElementById('editorName').value.trim();
            if (!name) { alert('Map adı yaz!'); return; }
            if (this.editor.points.length < 6) { alert('En az 6 nokta koy! (şu an ' + this.editor.points.length + ')'); return; }
            this._pendingSave = true;
            this.ws.send(JSON.stringify({
                type: 'save_map', ownerId: this.ownerId,
                map: {
                    name,
                    points: this.editor.points,
                    width: Number(document.getElementById('edWidth').value),
                    laps: Number(document.getElementById('edLaps').value),
                    oilSpots: this.editor.oilSpots,
                    padSpots: this.editor.padSpots,
                    ice: document.getElementById('edIce').checked,
                    theme: document.getElementById('edTheme').value,
                    startCtrl: this.editor.startCtrl,
                    editId: this.editor.editId,
                },
            }));
        });
    }

    smoothClosed(pts) {
        // server ile aynı Catmull-Rom (önizleme)
        const out = [];
        const m = pts.length;
        for (let i = 0; i < m; i++) {
            const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m], p3 = pts[(i + 2) % m];
            for (let j = 0; j < 12; j++) {
                const t = j / 12, t2 = t * t, t3 = t2 * t;
                out.push({
                    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
                });
            }
        }
        return out;
    }

    drawEditor() {
        const cv = document.getElementById('editorCanvas');
        if (!cv) return;
        const c = cv.getContext('2d');
        const SX = cv.width / WORLD_W, SY = cv.height / WORLD_H;
        const theme = MAP_THEMES[document.getElementById('edTheme').value] || MAP_THEMES.klasik;
        c.fillStyle = theme.grass; c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = theme.grass2;
        for (let y = 0; y < cv.height; y += 30) {
            for (let x = 0; x < cv.width; x += 30) {
                if (((x + y) / 30) % 2 === 0) c.fillRect(x, y, 30, 30);
            }
        }
        c.strokeStyle = 'rgba(0,212,255,0.4)'; c.setLineDash([6, 6]);
        c.strokeRect(40 * SX, 40 * SY, (1160 - 40) * SX, (760 - 40) * SY);
        c.setLineDash([]);
        const pts = this.editor.points;
        const w = Number(document.getElementById('edWidth').value) || 80;
        if (pts.length >= 2) {
            const curve = pts.length >= 3 ? this.editorCurveTagged() : pts.map((p, i) => ({ x: p.x, y: p.y, seg: i }));
            c.strokeStyle = theme.asphalt; c.lineWidth = w * SX; c.lineJoin = 'round'; c.lineCap = 'round';
            c.beginPath();
            curve.forEach((p, i) => { if (i === 0) c.moveTo(p.x * SX, p.y * SY); else c.lineTo(p.x * SX, p.y * SY); });
            c.closePath(); c.stroke();
            c.strokeStyle = '#e8e8e8'; c.lineWidth = 1.5;
            c.stroke();
            const si = this.editor.startCtrl >= 0 ? this.editor.startCtrl : 0;
            if (pts[si]) {
                c.fillStyle = '#fff';
                c.font = 'bold 13px sans-serif'; c.textAlign = 'center';
                c.fillText('🏁', pts[si].x * SX, pts[si].y * SY - 13);
            }
        }
        // manuel engeller
        const ring = (x, y, r) => {
            c.strokeStyle = '#ffd700'; c.lineWidth = 2;
            c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
        };
        this.editor.oilSpots.forEach((s, i) => {
            c.fillStyle = 'rgba(5,5,5,0.9)';
            c.beginPath(); c.ellipse(s.x * SX, s.y * SY, 10, 7, 0.4, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#fff'; c.font = '10px sans-serif'; c.textAlign = 'center';
            c.fillText('🛢️', s.x * SX, s.y * SY + 3);
            if (this.editor.selected && this.editor.selected.kind === 'oil' && this.editor.selected.idx === i) ring(s.x * SX, s.y * SY, 14);
        });
        this.editor.padSpots.forEach((s, i) => {
            c.fillStyle = 'rgba(20,120,30,0.9)';
            c.strokeStyle = '#39ff14'; c.lineWidth = 2;
            c.beginPath(); c.ellipse(s.x * SX, s.y * SY, 12, 8, 0, 0, Math.PI * 2); c.fill(); c.stroke();
            c.fillStyle = '#d6ffd6'; c.font = 'bold 10px sans-serif'; c.textAlign = 'center';
            c.fillText('➤', s.x * SX, s.y * SY + 4);
            if (this.editor.selected && this.editor.selected.kind === 'pad' && this.editor.selected.idx === i) ring(s.x * SX, s.y * SY, 16);
        });
        // kontrol noktaları
        pts.forEach((p, i) => {
            const isStart = i === this.editor.startCtrl;
            c.fillStyle = isStart ? '#39ff14' : '#ff4d00';
            c.beginPath(); c.arc(p.x * SX, p.y * SY, 7, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#000'; c.font = 'bold 9px sans-serif'; c.textAlign = 'center';
            c.fillText(String(i + 1), p.x * SX, p.y * SY + 3);
            if (this.editor.selected && this.editor.selected.kind === 'track' && this.editor.selected.idx === i) {
                c.strokeStyle = '#ffd700'; c.lineWidth = 2;
                c.beginPath(); c.arc(p.x * SX, p.y * SY, 11, 0, Math.PI * 2); c.stroke();
            }
        });
        this.renderEditorLists();
        this.renderEditorStats();
    }

    renderEditorLists() {
        const box = document.getElementById('editorPoints');
        if (!box) return;
        box.innerHTML = '';
        const title = document.createElement('span');
        title.textContent = 'Nokta: ' + this.editor.points.length + '/30 ';
        box.appendChild(title);
        this.editor.points.forEach((p, i) => {
            const chip = document.createElement('span');
            chip.className = 'pt-chip' + (i === this.editor.startCtrl ? ' start' : '');
            chip.title = 'Seç';
            chip.appendChild(document.createTextNode((i === this.editor.startCtrl ? '🏁' : '') + 'P' + (i + 1)));
            chip.addEventListener('click', () => { this.editor.selected = { kind: 'track', idx: i }; this.drawEditor(); });
            const x = document.createElement('b');
            x.textContent = '✕'; x.title = 'Sil';
            x.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editor.points.splice(i, 1);
                if (this.editor.startCtrl === i) this.editor.startCtrl = -1;
                else if (this.editor.startCtrl > i) this.editor.startCtrl--;
                this.editor.selected = null;
                this.drawEditor();
            });
            chip.appendChild(x);
            box.appendChild(chip);
        });
        const sp = document.getElementById('editorSpots');
        if (sp && sp.firstChild) sp.firstChild.textContent = '🛢️ ' + this.editor.oilSpots.length + '/16 • 🟢 ' + this.editor.padSpots.length + '/8 ';
    }

    renderEditorStats() {
        const el = document.getElementById('editorStats');
        if (!el) return;
        const pts = this.editor.points;
        let len = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach((p, i) => {
            if (pts.length > 1) {
                const q = pts[(i + 1) % pts.length];
                len += Math.hypot(q.x - p.x, q.y - p.y);
            }
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        });
        const bw = pts.length ? Math.round(maxX - minX) : 0;
        const bh = pts.length ? Math.round(maxY - minY) : 0;
        const checks = [
            [pts.length >= 6, '6+ nokta'],
            [len >= 1200, 'uzunluk ≥1200'],
            [bw >= 250 && bh >= 200, 'alan ≥250×200'],
        ];
        el.innerHTML = 'Uzunluk <b>' + Math.round(len) + '</b> • Alan <b>' + bw + '×' + bh + '</b> • ' +
            checks.map(([ok, t]) => '<span class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✔' : '✘') + ' ' + t + '</span>').join(' ');
    }

    trailColor(p) {
        const t = (p.equipped && p.equipped.trail) || 'duman';
        const r = Math.random();
        switch (t) {
            case 'ates': return r < 0.5 ? '#ff5a00' : '#ffd23f';
            case 'neon': return r < 0.5 ? '#00e5ff' : '#7cffff';
            case 'gokkusagi': return 'hsl(' + Math.floor(Math.random() * 360) + ',100%,60%)';
            case 'altin': return r < 0.5 ? '#ffd700' : '#fff3a0';
            case 'galaksi': return ['#b366ff', '#ff66cc', '#6666ff'][Math.floor(r * 3)];
            case 'kalp': return r < 0.5 ? '#ff6b9d' : '#ff9ebb';
            case 'yildiz': return r < 0.5 ? '#fff200' : '#ffffff';
            default: return 'rgba(180,180,180,0.7)';
        }
    }
    nitroColor(p) {
        const n = (p.equipped && p.equipped.nitro) || 'klasik';
        const r = Math.random();
        switch (n) {
            case 'yesil': return r < 0.5 ? '#39ff14' : '#b6ff00';
            case 'mor': return r < 0.5 ? '#b366ff' : '#ff66ff';
            case 'buz_alev': return r < 0.5 ? '#a8e6ff' : '#00bfff';
            case 'gokkusagi': return 'hsl(' + Math.floor(Math.random() * 360) + ',100%,60%)';
            default: return r < 0.5 ? '#00d4ff' : '#ff4d00';
        }
    }
    glowColor(p) {
        const g = (p.equipped && p.equipped.glow) || 'yok';
        switch (g) {
            case 'kirmizi': return 'rgba(255,40,40,0.5)';
            case 'mavi': return 'rgba(0,180,255,0.5)';
            case 'yesil_glow': return 'rgba(50,255,100,0.5)';
            case 'ates_halo': return 'rgba(255,140,0,0.55)';
            case 'rgb': return 'hsl(' + Math.floor(this.hue % 360) + ',100%,55%)';
            default: return null;
        }
    }

    drawPreview() {
        if (!this.preview) return;
        const c = this.preview.getContext('2d');
        c.clearRect(0, 0, this.preview.width, this.preview.height);
        c.fillStyle = '#111';
        c.fillRect(0, 0, this.preview.width, this.preview.height);
        c.strokeStyle = '#333'; c.lineWidth = 14;
        c.beginPath(); c.moveTo(10, 80); c.quadraticCurveTo(110, 10, 210, 70); c.stroke();
        // önizlemede seçili trail'den örnek parçacık
        c.fillStyle = this.trailColor({ equipped: this.myEquipped });
        c.beginPath(); c.arc(70, 62, 5, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(82, 58, 4, 0, Math.PI * 2); c.fill();
        c.save();
        c.translate(110, 52); c.rotate(-0.2);
        const gc = this.glowColor({ equipped: this.myEquipped });
        if (gc) { c.fillStyle = gc; c.beginPath(); c.ellipse(0, 0, 30, 18, 0, 0, Math.PI * 2); c.fill(); }
        this.drawCarShape(c, { color: this.myColor, skin: this.mySkin }, true);
        c.restore();
    }

    pushCustom() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'set_custom', color: this.myColor, skin: this.mySkin, name: document.getElementById('nameInput').value, equipped: this.myEquipped }));
        }
    }

    connectToServer() {
        let wsUrl;
        if (window.location.protocol === 'file:') {
            wsUrl = 'ws://localhost:8080';
        } else {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = protocol + '//' + window.location.host;
        }
        this.ws = new WebSocket(wsUrl);
        this.ws.onopen = () => console.log('Sunucuya bağlanıldı');
        this.ws.onmessage = (event) => {
            try { this.handleServerMessage(JSON.parse(event.data)); }
            catch (e) { console.error('Bozuk sunucu mesajı', e); }
        };
        this.ws.onclose = () => { console.log('Bağlantı koptu, yeniden deneniyor...'); setTimeout(() => this.connectToServer(), 2000); };
        this.ws.onerror = (err) => console.error('WebSocket hatası:', err);
    }

    syncMe() {
        const me = this.state.players.find(p => p.id === this.myId);
        if (me) {
            this.isHost = !!me.isHost;
            if (typeof me.coins === 'number') this.myCoins = me.coins;
            if (me.owned) this.myOwned = me.owned;
            if (me.equipped) {
                // server otoriter, ama local seçimi koru
                for (const k of ['trail', 'nitro', 'glow']) if (me.equipped[k]) this.myEquipped[k] = me.equipped[k];
            }
        }
    }

    handleServerMessage(data) {
        switch (data.type) {
            case 'connected':
                this.myId = data.playerId;
                this.isHost = !!data.player.isHost;
                if (data.player.color) this.myColor = data.player.color;
                if (data.player.skin) this.mySkin = data.player.skin;
                if (data.player.coins !== undefined) this.myCoins = data.player.coins;
                if (data.player.owned) this.myOwned = data.player.owned;
                if (this.myName) document.getElementById('nameInput').value = this.myName;
                else document.getElementById('nameInput').value = data.player.name || '';
                this.state = data.state;
                this.syncMe();
                this.lastRenderedState = null;
                this.lobbyCacheKey = '';
                setTimeout(() => this.pushCustom(), 200);
                this.updateLobby(true);
                this.buildMapPicker();
                this.buildShop();
                this.refreshPickerActive();
                this.drawPreview();
                break;
            case 'state': {
                const prev = this.state.state;
                const prevCount = this.state.countDown;
                this.state = data.state;
                this.syncMe();
                if (prev !== 'RACING' && data.state.state === 'RACING') {
                    this.raceStartTime = Date.now();
                    this.raceComplete = false;
                    this.particles = []; this.skids = [];
                    this.beep(880, 0.4, 0.09);
                }
                if (data.state.state === 'LOBBY') { this.raceComplete = false; this.lastCountBeep = -1; }
                if (data.state.state === 'COUNTDOWN' && data.state.countDown !== prevCount) {
                    if (data.state.countDown > 0) this.beep(440, 0.15, 0.08);
                    else this.beep(880, 0.3, 0.08);
                }
                this.updateLobby(false);
                this.buildMapPicker();
                this.buildShop();
                this.refreshPickerActive();
                break;
            }
            case 'map_saved': {
                const modal = document.getElementById('editorModal');
                if (modal) modal.style.display = 'none';
                this._pendingSave = false;
                this.mapTab = 'custom';
                this.buildMapPicker();
                this.beep(880, 0.25, 0.08);
                break;
            }
            case 'map_data': {
                const m = data.map;
                this.editor.points = (m.ctrl || []).map(p => ({ x: p.x, y: p.y }));
                this.editor.oilSpots = (m.oilSpots || []).map(p => ({ x: p.x, y: p.y }));
                this.editor.padSpots = (m.padSpots || []).map(p => ({ x: p.x, y: p.y }));
                this.editor.startCtrl = (m.startCtrl == null ? -1 : m.startCtrl);
                this.editor.editId = m.id;
                this.editor.selected = null;
                document.getElementById('editorName').value = m.name || '';
                document.getElementById('edWidth').value = m.width;
                document.getElementById('edWidthVal').textContent = m.width;
                document.getElementById('edLaps').value = m.laps;
                document.getElementById('edLapsVal').textContent = m.laps;
                document.getElementById('edIce').checked = !!m.ice;
                document.getElementById('edTheme').value = m.theme || 'klasik';
                document.getElementById('editorTitle').textContent = '🛠️ Düzenle: ' + m.name;
                this.setEditorTool('track');
                document.getElementById('editorModal').style.display = 'flex';
                this.drawEditor();
                break;
            }
            case 'player_update':
            case 'players':
            case 'player_left':
                this.state.players = data.state.players;
                if (data.state.maxPlayers) this.state.maxPlayers = data.state.maxPlayers;
                if (data.state.totalLaps) this.state.totalLaps = data.state.totalLaps;
                if (data.state.mapId) this.state.mapId = data.state.mapId;
                if (data.state.maps) this.state.maps = data.state.maps;
                if (data.state.shop) this.state.shop = data.state.shop;
                if (data.state.oilSlicks) this.state.oilSlicks = data.state.oilSlicks;
                if (data.state.boostPads) this.state.boostPads = data.state.boostPads;
                this.syncMe();
                this.updateLobby(false);
                this.buildMapPicker();
                this.buildShop();
                break;
            case 'shop_error':
                alert(data.message);
                this.beep(200, 0.2, 0.08);
                break;
            case 'map_error':
                this._pendingSave = false;
                alert('🗺️ ' + data.message);
                this.beep(200, 0.2, 0.08);
                break;
            case 'error':
                alert(data.message);
                break;
        }
    }

    setupEventListeners() {
        const nameInput = document.getElementById('nameInput');
        if (this.myName) nameInput.value = this.myName;
        let nameT = null;
        nameInput.addEventListener('input', (e) => {
            this.myName = e.target.value;
            localStorage.setItem('race_name', this.myName);
            clearTimeout(nameT);
            nameT = setTimeout(() => this.pushCustom(), 250);
        });
        nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); });

        document.getElementById('startBtn').addEventListener('click', () => {
            this.ensureAudio();
            if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'start_race' }));
        });
        document.getElementById('restartBtn').addEventListener('click', () => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'reset' }));
            this.raceComplete = false;
        });
        document.getElementById('menuBtn').addEventListener('click', () => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'reset' }));
            this.raceComplete = false;
        });
        document.addEventListener('pointerdown', () => this.ensureAudio(), { once: true });

        window.addEventListener('keydown', (e) => {
            if (document.activeElement === nameInput) return;
            if (GAME_KEYS.includes(e.code)) e.preventDefault();
            if (this.state.state === 'LOBBY') return;
            if (e.repeat) return;
            this.keys[e.code] = true;
            this.sendInput();
        });
        window.addEventListener('keyup', (e) => {
            if (this.keys[e.code]) { this.keys[e.code] = false; this.sendInput(); }
        });
        window.addEventListener('blur', () => { this.keys = {}; this.sendInput(); });
    }

    sendInput() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'input', keys: this.keys }));
        }
    }

    updateLobby(force) {
        const sig = JSON.stringify([
            this.state.state, this.state.countDown,
            this.state.players.map(p => [p.id, p.name, p.lap, p.finished, p.isHost, p.color, p.skin, p.bestLap, p.coins, p.equipped]),
            this.isHost, this.state.mapId, this.myCoins,
        ]);
        if (!force && sig === this.lobbyCacheKey) return;
        this.lobbyCacheKey = sig;

        const playerList = document.getElementById('playerList');
        const startBtn = document.getElementById('startBtn');
        const serverInfo = document.getElementById('serverInfo');
        if (!playerList) return;
        playerList.innerHTML = '';
        this.state.players.forEach(p => {
            const el = document.createElement('div');
            if (p.id === this.myId) el.className = 'you';
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = p.color;
            el.appendChild(dot);
            const skinTag = document.createElement('span');
            skinTag.className = 'skin-tag';
            skinTag.textContent = (p.skin || 'klasik') + ' • ' + ((p.equipped && p.equipped.trail) || '');
            el.appendChild(document.createTextNode((p.isHost ? '👑 ' : '') + p.name + ' (' + p.lap + '/' + this.state.totalLaps + ')' + (p.finished ? ' ✓' : '')));
            el.appendChild(skinTag);
            if (p.bestLap) {
                const bt = document.createElement('span');
                bt.className = 'best';
                bt.textContent = Number(p.bestLap).toFixed(1) + 'sn';
                el.appendChild(bt);
            }
            playerList.appendChild(el);
        });

        const cb = document.getElementById('coinBadge');
        if (cb) cb.textContent = '🪙 ' + this.myCoins;
        const ch = document.getElementById('coinHud');
        if (ch) ch.textContent = '🪙 ' + this.myCoins;

        const canStart = this.isHost && this.state.state === 'LOBBY' && this.state.players.length >= 1;
        startBtn.disabled = !canStart;
        startBtn.textContent = this.state.state === 'COUNTDOWN' ? ('Başlıyor... (' + this.state.countDown + ')') : 'Yarışı Başlat (' + (this.state.mapName || '') + ')';

        if (this.state.state === 'COUNTDOWN') serverInfo.textContent = 'Yarış başlıyor... ' + this.state.countDown;
        else if (this.state.state === 'RACING') serverInfo.textContent = 'Yarış devam ediyor! (' + (this.state.mapName || '') + ')';
        else if (this.state.state === 'FINISHED') serverInfo.textContent = 'Yarış bitti!';
        else serverInfo.textContent = 'Bekleniyor... (' + this.state.players.length + '/' + this.state.maxPlayers + ')';
    }

    showScreen(name) {
        document.getElementById('lobby').style.display = name === 'lobby' ? 'flex' : 'none';
        document.getElementById('raceScreen').style.display = name === 'race' ? 'flex' : 'none';
        document.getElementById('finishedScreen').style.display = name === 'finished' ? 'flex' : 'none';
    }

    screenForState(s) {
        if (s === 'LOBBY') return 'lobby';
        if (s === 'FINISHED' && this.raceComplete) return 'finished';
        return 'race';
    }

    renderResults() {
        const sorted = [...this.state.players].sort((a, b) => {
            if (a.finished && !b.finished) return -1;
            if (!a.finished && b.finished) return 1;
            if (a.finished && b.finished) return (a.finishTime || 0) - (b.finishTime || 0);
            return b.lap - a.lap || b.checkpoint - a.checkpoint;
        });
        const resultsDiv = document.getElementById('results');
        resultsDiv.innerHTML = '';
        sorted.forEach((p, i) => {
            const el = document.createElement('div');
            const timeText = p.finished ? (Number(p.finishTime).toFixed(2) + ' sn') : ('Tur ' + p.lap + '/' + this.state.totalLaps);
            const best = p.bestLap ? (' • en iyi ' + Number(p.bestLap).toFixed(2) + 'sn') : '';
            const medal = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : (i + 1) + '. ';
            el.innerHTML = '<span class="pos">' + medal + '</span>' +
                '<span class="color" style="background:' + p.color + '"></span>' +
                '<span class="name"></span>' +
                '<span class="time">' + timeText + best + '</span>';
            el.querySelector('.name').textContent = p.name + ' [' + (p.skin || 'klasik') + ']';
            resultsDiv.appendChild(el);
        });
        const me = sorted.find(p => p.id === this.myId);
        const ce = document.getElementById('coinEarn');
        if (ce) ce.textContent = me && me.earnedRace ? ('🪙 +' + me.earnedRace + ' coin kazandın! (Toplam: ' + this.myCoins + ')') : '';
        const winner = sorted[0];
        document.getElementById('finishedTitle').textContent =
            (winner && this.myId === winner.id) ? '🏆 Kazandınız!' : 'Yarış Bitti!';
    }

    showFinished() {
        this.renderResults();
        this.showScreen('finished');
        this.lastRenderedState = 'FINISHED_SHOWN';
        this.beep(660, 0.15); setTimeout(() => this.beep(880, 0.2), 180);
    }

    isOnTrackClient(x, y) {
        const pts = this.state.trackPoints;
        if (!pts.length) return true;
        let m = Infinity;
        for (let i = 0; i < pts.length; i += 2) {
            const dx = x - pts[i].x, dy = y - pts[i].y;
            const d = dx * dx + dy * dy;
            if (d < m) m = d;
        }
        return Math.sqrt(m) < this.state.trackWidth / 2 + 5;
    }

    spawnParticle(o) {
        if (this.particles.length > 700) this.particles.shift();
        this.particles.push(Object.assign({ vx: 0, vy: 0, life: 1, maxLife: 1, size: 4, color: '#fff', grav: 0, shrink: true }, o));
    }

    emitForPlayer(p) {
        const spd = Math.abs(p.speed || 0);
        const bx = p.x - Math.cos(p.angle) * 22;
        const by = p.y - Math.sin(p.angle) * 22;
        if (spd > 0.4) {
            this.spawnParticle({
                x: bx + (Math.random() - 0.5) * 6, y: by + (Math.random() - 0.5) * 6,
                vx: -Math.cos(p.angle) * spd * 0.4 + (Math.random() - 0.5),
                vy: -Math.sin(p.angle) * spd * 0.4 + (Math.random() - 0.5),
                life: 0.5, maxLife: 0.5, size: 3 + spd * 0.7,
                color: p.boosting ? this.nitroColor(p) : this.trailColor(p),
            });
            if (p.boosting) {
                this.spawnParticle({
                    x: bx, y: by,
                    vx: -Math.cos(p.angle) * 4 + (Math.random() - 0.5) * 2,
                    vy: -Math.sin(p.angle) * 4 + (Math.random() - 0.5) * 2,
                    life: 0.3, maxLife: 0.3, size: 7 + Math.random() * 5,
                    color: this.nitroColor(p),
                });
                this.cam.shake = p.id === this.myId ? 2.5 : this.cam.shake;
            }
        }
        if (p.drift) {
            const side = 8;
            const px = -Math.sin(p.angle), py = Math.cos(p.angle);
            for (const s of [-1, 1]) {
                this.spawnParticle({
                    x: p.x + px * side * s - Math.cos(p.angle) * 8,
                    y: p.y + py * side * s - Math.sin(p.angle) * 8,
                    vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5,
                    life: 0.7, maxLife: 0.7, size: 5 + Math.random() * 4, color: 'rgba(230,230,230,0.75)',
                });
            }
            this.skids.push({ x1: p.x - Math.cos(p.angle) * 10, y1: p.y - Math.sin(p.angle) * 10, x2: p.x - Math.cos(p.angle) * 14 - (p.speed * 0.5) * Math.cos(p.angle), y2: p.y - Math.sin(p.angle) * 14 - (p.speed * 0.5) * Math.sin(p.angle), life: 3 });
            if (this.skids.length > 400) this.skids.shift();
        }
        if (p.oiled) {
            for (let i = 0; i < 3; i++) {
                this.spawnParticle({
                    x: p.x + (Math.random() - 0.5) * 20, y: p.y + (Math.random() - 0.5) * 20,
                    vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3,
                    life: 0.5, maxLife: 0.5, size: 5, color: 'rgba(10,10,10,0.9)',
                });
            }
        }
        if (p.padded) {
            for (let i = 0; i < 2; i++) {
                this.spawnParticle({
                    x: p.x + (Math.random() - 0.5) * 16, y: p.y + (Math.random() - 0.5) * 16,
                    vx: 0, vy: -2,
                    life: 0.4, maxLife: 0.4, size: 4, color: '#39ff14',
                });
            }
        }
        if (!this.isOnTrackClient(p.x, p.y) && spd > 1) {
            this.spawnParticle({
                x: p.x + (Math.random() - 0.5) * 16, y: p.y + (Math.random() - 0.5) * 16,
                vx: (Math.random() - 0.5) * 2, vy: -1 - Math.random(),
                life: 0.6, maxLife: 0.6, size: 4 + Math.random() * 4, color: 'rgba(160,120,60,0.8)',
            });
        }
        const prev = this.prevSpeeds.get(p.id);
        if (prev !== undefined && prev - spd > 1.5) {
            for (let i = 0; i < 10; i++) {
                this.spawnParticle({
                    x: p.x, y: p.y,
                    vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6,
                    life: 0.4, maxLife: 0.4, size: 2 + Math.random() * 2, color: '#ffe14d',
                });
            }
            if (p.id === this.myId) this.beep(180, 0.12, 0.07);
        }
        this.prevSpeeds.set(p.id, spd);
    }

    updateParticles(dt) {
        this.hue += dt * 120;
        for (const pt of this.particles) {
            pt.x += pt.vx; pt.y += pt.vy;
            pt.vy += pt.grav || 0;
            pt.vx *= 0.97; pt.vy *= 0.97;
            pt.life -= dt;
        }
        this.particles = this.particles.filter(p => p.life > 0);
        for (const s of this.skids) s.life -= dt;
        this.skids = this.skids.filter(s => s.life > 0);
        if (this.cam.shake > 0) this.cam.shake = Math.max(0, this.cam.shake - dt * 12);
    }

    render() {
        const s = this.state.state;
        const want = this.screenForState(s);
        if (want !== this.lastRenderedState) {
            this.showScreen(want);
            this.lastRenderedState = want;
        }
        if (s === 'LOBBY') return;
        this.renderRace();
        this.updateHUD();
        if (s === 'FINISHED' && !this.raceComplete) {
            this.raceComplete = true;
            setTimeout(() => this.showFinished(), 900);
        }
    }

    renderRace() {
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        if (!this.state.trackPoints || this.state.trackPoints.length === 0) return;

        ctx.save();
        let sx = 0, sy = 0;
        if (this.cam.shake > 0) { sx = (Math.random() - 0.5) * this.cam.shake * 2; sy = (Math.random() - 0.5) * this.cam.shake * 2; }
        ctx.translate(this.cam.ox + sx, this.cam.oy + sy);
        ctx.scale(this.cam.scale, this.cam.scale);
        this.drawWorld(ctx);
        this.drawObstacles(ctx);
        this.drawSkids(ctx);
        this.drawParticles(ctx);
        this.drawCars(ctx);
        ctx.restore();
        this.drawMinimap();
        const me = this.state.players.find(p => p.id === this.myId);
        if (me && me.boosting) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            const g = ctx.createRadialGradient(this.canvas.width / 2, this.canvas.height / 2, this.canvas.height * 0.3, this.canvas.width / 2, this.canvas.height / 2, this.canvas.height * 0.75);
            g.addColorStop(0, 'rgba(0,0,0,0)');
            g.addColorStop(1, 'rgba(0,180,255,0.22)');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            ctx.restore();
        }
    }

    trackEdges(pts, width) {
        const inner = [], outer = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const n = pts[(i + 1) % pts.length];
            const dx = n.x - p.x, dy = n.y - p.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len, ny = dx / len;
            inner.push({ x: p.x + nx * width / 2, y: p.y + ny * width / 2 });
            outer.push({ x: p.x - nx * width / 2, y: p.y - ny * width / 2 });
        }
        return { inner, outer };
    }

    drawWorld(ctx) {
        const pts = this.state.trackPoints;
        const width = this.state.trackWidth;
        const theme = MAP_THEMES[this.state.mapTheme || this.state.mapId] || MAP_THEMES.klasik;
        ctx.fillStyle = theme.grass;
        ctx.fillRect(0, 0, WORLD_W, WORLD_H);
        ctx.fillStyle = theme.grass2;
        const cell = 60;
        for (let y = 0; y < WORLD_H; y += cell) {
            for (let x = 0; x < WORLD_W; x += cell) {
                if (((x + y) / cell) % 2 === 0) ctx.fillRect(x, y, cell, cell);
            }
        }
        // buz pisti parıltısı
        if (this.state.mapId === 'buz') {
            ctx.fillStyle = 'rgba(180,220,255,0.06)';
            for (let i = 0; i < 20; i++) {
                ctx.beginPath();
                ctx.arc((i * 173) % WORLD_W, (i * 97) % WORLD_H, 20 + (i % 5) * 8, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        if (this.state.mapId === 'cehennem') {
            ctx.fillStyle = 'rgba(255,60,0,0.05)';
            for (let i = 0; i < 20; i++) {
                ctx.beginPath();
                ctx.arc((i * 211) % WORLD_W, (i * 131) % WORLD_H, 24, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        const { inner, outer } = this.trackEdges(pts, width);
        ctx.beginPath();
        ctx.moveTo(inner[0].x, inner[0].y);
        for (let i = 1; i < inner.length; i++) ctx.lineTo(inner[i].x, inner[i].y);
        ctx.closePath();
        for (let i = outer.length - 1; i >= 0; i--) ctx.lineTo(outer[i].x, outer[i].y);
        ctx.closePath();
        ctx.fillStyle = theme.asphalt;
        ctx.fill();
        ctx.strokeStyle = '#e8e8e8';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.save();
        ctx.lineWidth = 6;
        ctx.setLineDash([14, 14]);
        ctx.strokeStyle = 'rgba(255,60,60,0.8)';
        ctx.beginPath();
        ctx.moveTo(inner[0].x, inner[0].y);
        for (let i = 1; i < inner.length; i++) ctx.lineTo(inner[i].x, inner[i].y);
        ctx.closePath(); ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 2;
        ctx.setLineDash([18, 22]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < pts.length; i += 45) {
            const p = pts[i], n = pts[(i + 5) % pts.length];
            const a = Math.atan2(n.y - p.y, n.x - p.x);
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(a);
            ctx.beginPath();
            ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7);
            ctx.closePath(); ctx.fill();
            ctx.restore();
        }
        const p0 = pts[0], p1 = pts[1];
        const ta = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const nx = -Math.sin(ta), ny = Math.cos(ta);
        const cells = 10;
        for (let i = 0; i < cells; i++) {
            const t0 = -width / 2 + (width / cells) * i;
            const t1 = -width / 2 + (width / cells) * (i + 1);
            ctx.fillStyle = i % 2 === 0 ? '#f5f5f5' : '#111';
            ctx.beginPath();
            ctx.moveTo(p0.x + nx * t0 - Math.cos(ta) * 4, p0.y + ny * t0 - Math.sin(ta) * 4);
            ctx.lineTo(p0.x + nx * t1 - Math.cos(ta) * 4, p0.y + ny * t1 - Math.sin(ta) * 4);
            ctx.lineTo(p0.x + nx * t1 + Math.cos(ta) * 4, p0.y + ny * t1 + Math.sin(ta) * 4);
            ctx.lineTo(p0.x + nx * t0 + Math.cos(ta) * 4, p0.y + ny * t0 + Math.sin(ta) * 4);
            ctx.closePath(); ctx.fill();
        }
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.font = 'bold 64px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((this.state.mapName || '').toUpperCase(), WORLD_W / 2, WORLD_H / 2);
        ctx.restore();
    }

    drawObstacles(ctx) {
        const t = Date.now() / 400;
        for (const o of (this.state.oilSlicks || [])) {
            ctx.save();
            ctx.fillStyle = 'rgba(5,5,5,0.9)';
            ctx.beginPath(); ctx.ellipse(o.x, o.y, o.r, o.r * 0.7, 0.4, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'rgba(120,80,200,0.35)';
            ctx.beginPath(); ctx.ellipse(o.x - 4, o.y - 3, 6, 4, 0.4, 0, Math.PI * 2); ctx.fill();
            ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('🛢️', o.x, o.y + 6);
            ctx.restore();
        }
        for (const b of (this.state.boostPads || [])) {
            ctx.save();
            ctx.translate(b.x, b.y);
            const pulse = 1 + Math.sin(t + b.x) * 0.12;
            ctx.scale(pulse, pulse);
            ctx.fillStyle = 'rgba(20,120,30,0.85)';
            ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.ellipse(0, 0, b.r, b.r * 0.7, b.angle || 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            ctx.rotate(b.angle || 0);
            ctx.fillStyle = '#d6ffd6';
            ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('➤➤', 0, 6);
            ctx.restore();
        }
    }

    drawSkids(ctx) {
        ctx.save();
        ctx.strokeStyle = 'rgba(10,10,10,0.55)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        for (const s of this.skids) {
            ctx.globalAlpha = Math.min(1, s.life / 3);
            ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        }
        ctx.restore();
    }

    drawParticles(ctx) {
        ctx.save();
        for (const pt of this.particles) {
            const t = pt.life / pt.maxLife;
            ctx.globalAlpha = Math.max(0, Math.min(1, t));
            ctx.fillStyle = pt.color;
            const sz = pt.shrink ? pt.size * t + 1 : pt.size;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, sz, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    drawCarShape(c, p, isPreview) {
        const skin = p.skin || 'klasik';
        const col = p.color || '#ff4444';
        if (skin === 'formula') {
            c.fillStyle = '#111';
            c.fillRect(-CAR_H / 2 - 4, -CAR_W / 2 - 4, 6, CAR_W + 8);
            c.fillStyle = col;
            c.beginPath();
            c.moveTo(CAR_H / 2 + 4, 0); c.lineTo(6, -7); c.lineTo(-CAR_H / 2 + 4, -7); c.lineTo(-CAR_H / 2 + 4, 7); c.lineTo(6, 7);
            c.closePath(); c.fill();
            c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
            c.fillStyle = '#111';
            c.fillRect(CAR_H / 2, -CAR_W / 2 - 2, 5, CAR_W + 4);
            c.fillStyle = '#0a0a0a';
            [[12, -11], [12, 7], [-10, -11], [-10, 7]].forEach(([x, y]) => { c.fillRect(x, y, 9, 5); });
            c.fillStyle = 'rgba(10,10,10,0.9)';
            c.fillRect(-6, -4, 10, 8);
            c.fillStyle = 'rgba(255,255,255,0.7)';
            c.fillRect(2, -1.5, CAR_H / 2 - 2, 3);
        } else if (skin === 'spor') {
            c.fillStyle = 'rgba(0,0,0,0.4)';
            c.fillRect(-CAR_H / 2 + 2, -CAR_W / 2 + 3, CAR_H, CAR_W);
            c.fillStyle = '#161616';
            c.fillRect(-CAR_H / 2 - 5, -CAR_W / 2 - 2, 5, CAR_W + 4);
            c.fillStyle = col;
            c.beginPath();
            c.moveTo(CAR_H / 2, 0); c.lineTo(CAR_H / 2 - 8, -CAR_W / 2); c.lineTo(-CAR_H / 2, -CAR_W / 2 + 2); c.lineTo(-CAR_H / 2, CAR_W / 2 - 2); c.lineTo(CAR_H / 2 - 8, CAR_W / 2);
            c.closePath(); c.fill();
            c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
            c.fillStyle = 'rgba(255,255,255,0.85)';
            c.fillRect(-CAR_H / 2, -3, CAR_H - 6, 6);
            c.fillStyle = 'rgba(10,10,10,0.9)';
            c.fillRect(0, -CAR_W / 2 + 4, 9, CAR_W - 8);
        } else if (skin === 'retro') {
            c.fillStyle = 'rgba(0,0,0,0.4)';
            c.beginPath(); c.roundRect ? c.roundRect(-CAR_H / 2 + 2, -CAR_W / 2 + 3, CAR_H, CAR_W, 8) : c.rect(-CAR_H / 2 + 2, -CAR_W / 2 + 3, CAR_H, CAR_W); c.fill();
            c.fillStyle = col;
            c.beginPath(); c.roundRect ? c.roundRect(-CAR_H / 2, -CAR_W / 2, CAR_H, CAR_W, 9) : c.rect(-CAR_H / 2, -CAR_W / 2, CAR_H, CAR_W); c.fill();
            c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke();
            c.fillStyle = 'rgba(255,255,255,0.85)';
            c.beginPath(); c.arc(-2, 0, 8, 0, Math.PI * 2); c.fill();
            c.fillStyle = 'rgba(10,10,10,0.85)';
            c.beginPath(); c.arc(-2, 0, 5, 0, Math.PI * 2); c.fill();
            c.fillStyle = '#fff7ae';
            c.fillRect(CAR_H / 2 - 3, -CAR_W / 2 + 2, 3, 5);
            c.fillRect(CAR_H / 2 - 3, CAR_W / 2 - 7, 3, 5);
        } else {
            c.fillStyle = 'rgba(0,0,0,0.4)';
            c.fillRect(-CAR_H / 2 + 2, -CAR_W / 2 + 3, CAR_H, CAR_W);
            c.fillStyle = col;
            c.beginPath();
            c.moveTo(CAR_H / 2, 0);
            c.lineTo(CAR_H / 2 - 10, -CAR_W / 2);
            c.lineTo(-CAR_H / 2, -CAR_W / 2);
            c.lineTo(-CAR_H / 2, CAR_W / 2);
            c.lineTo(CAR_H / 2 - 10, CAR_W / 2);
            c.closePath();
            c.fill();
            c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
            c.fillStyle = 'rgba(10,10,10,0.85)';
            c.fillRect(-2, -CAR_W / 2 + 4, 10, CAR_W - 8);
        }
        if (p.boosting && !isPreview) {
            c.save();
            c.shadowColor = '#00d4ff'; c.shadowBlur = 18;
            c.strokeStyle = 'rgba(0,212,255,0.9)'; c.lineWidth = 2;
            c.strokeRect(-CAR_H / 2 - 2, -CAR_W / 2 - 2, CAR_H + 4, CAR_W + 4);
            c.restore();
        }
    }

    drawCars(ctx) {
        if (this.state.state === 'RACING' || this.state.state === 'FINISHED') {
            this.state.players.forEach(p => this.emitForPlayer(p));
        }
        this.state.players.forEach(p => {
            const isMe = p.id === this.myId;
            // alt glow (market)
            const gc = this.glowColor(p);
            if (gc) {
                ctx.save();
                ctx.fillStyle = gc;
                ctx.shadowColor = gc; ctx.shadowBlur = 22;
                ctx.beginPath(); ctx.ellipse(p.x, p.y, 28, 20, p.angle, 0, Math.PI * 2); ctx.fill();
                ctx.restore();
            }
            if (isMe) {
                ctx.save();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 6]);
                ctx.beginPath();
                ctx.arc(p.x, p.y, 30, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.restore();
            }
            if (Math.abs(p.speed) > 0.5) {
                ctx.save();
                ctx.translate(p.x, p.y); ctx.rotate(p.angle);
                const g = ctx.createLinearGradient(CAR_H / 2, 0, CAR_H / 2 + 60, 0);
                g.addColorStop(0, 'rgba(255,255,200,0.18)');
                g.addColorStop(1, 'rgba(255,255,200,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.moveTo(CAR_H / 2, -6); ctx.lineTo(CAR_H / 2 + 60, -16); ctx.lineTo(CAR_H / 2 + 60, 16); ctx.lineTo(CAR_H / 2, 6);
                ctx.closePath(); ctx.fill();
                ctx.restore();
            }
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.angle);
            this.drawCarShape(ctx, p, false);
            ctx.restore();
            ctx.save();
            ctx.fillStyle = isMe ? '#fff' : 'rgba(255,255,255,0.85)';
            ctx.font = 'bold 13px monospace';
            ctx.textAlign = 'center';
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 3;
            const label = String(p.name).substring(0, 10);
            ctx.strokeText(label, p.x, p.y - 30);
            ctx.fillText(label, p.x, p.y - 30);
            if (p.boosting || p.padded) {
                ctx.font = '14px sans-serif';
                ctx.fillText('🔥', p.x, p.y - 44);
            }
            if (p.oiled) {
                ctx.font = '14px sans-serif';
                ctx.fillText('💫', p.x, p.y - 44);
            }
            ctx.restore();
        });
    }

    drawMinimap() {
        if (!this.mmCtx || !this.state.trackPoints.length) return;
        const c = this.mmCtx;
        c.clearRect(0, 0, 180, 120);
        c.fillStyle = 'rgba(0,0,0,0.65)';
        c.fillRect(0, 0, 180, 120);
        const pts = this.state.trackPoints;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); });
        const sx = 160 / (maxX - minX || 1), sy = 100 / (maxY - minY || 1);
        const sc = Math.min(sx, sy);
        const ox = (180 - (maxX - minX) * sc) / 2, oy = (120 - (maxY - minY) * sc) / 2;
        const tx = x => ox + (x - minX) * sc, ty = y => oy + (y - minY) * sc;
        c.strokeStyle = '#888'; c.lineWidth = 5; c.lineJoin = 'round';
        c.beginPath();
        c.moveTo(tx(pts[0].x), ty(pts[0].y));
        for (let i = 1; i < pts.length; i++) c.lineTo(tx(pts[i].x), ty(pts[i].y));
        c.closePath(); c.stroke();
        // engeller minimapte
        c.fillStyle = '#000';
        (this.state.oilSlicks || []).forEach(o => { c.beginPath(); c.arc(tx(o.x), ty(o.y), 2, 0, Math.PI * 2); c.fill(); });
        c.fillStyle = '#39ff14';
        (this.state.boostPads || []).forEach(b => { c.beginPath(); c.arc(tx(b.x), ty(b.y), 2, 0, Math.PI * 2); c.fill(); });
        this.state.players.forEach(p => {
            c.fillStyle = p.color;
            c.beginPath();
            c.arc(tx(p.x), ty(p.y), p.id === this.myId ? 4 : 3, 0, Math.PI * 2);
            c.fill();
            if (p.id === this.myId) { c.strokeStyle = '#fff'; c.lineWidth = 1; c.stroke(); }
        });
    }

    updateHUD() {
        const myPlayer = this.state.players.find(p => p.id === this.myId);
        if (myPlayer) {
            document.getElementById('lapCounter').textContent = 'Tur: ' + myPlayer.lap + '/' + this.state.totalLaps;
            document.getElementById('speedMeter').textContent = Math.round(Math.abs(myPlayer.speed) * 36) + ' km/h';
            document.getElementById('position').textContent = 'Pozisyon: ' + (myPlayer.position || '-');
            const bf = document.getElementById('boostFill');
            if (bf) {
                bf.style.width = (myPlayer.boost || 0) + '%';
                bf.className = myPlayer.boosting || myPlayer.padded ? 'boosting' : (myPlayer.boost < 25 ? 'low' : '');
                bf.id = 'boostFill';
            }
            const ll = document.getElementById('lastLap');
            const bl = document.getElementById('bestLap');
            if (ll) ll.textContent = 'Son: ' + (myPlayer.lastLap ? Number(myPlayer.lastLap).toFixed(2) + 'sn' : '--');
            if (bl) bl.textContent = 'En iyi: ' + (myPlayer.bestLap ? Number(myPlayer.bestLap).toFixed(2) + 'sn' : '--');
            const wm = document.getElementById('warnMsg');
            if (wm) {
                if (myPlayer.oiled) { wm.style.display = 'block'; wm.textContent = '🛢️ YAĞA BASTIN!'; }
                else if (myPlayer.padded) { wm.style.display = 'block'; wm.textContent = '🟢 NİTRO PEDİ!'; }
                else wm.style.display = 'none';
            }
        }
        const mn = document.getElementById('hudMapName');
        if (mn) mn.textContent = this.state.mapName || '';
        let raceTime = 0;
        if (this.state.state === 'RACING' && this.raceStartTime) {
            raceTime = (Date.now() - this.raceStartTime) / 1000;
        } else if (this.state.state === 'FINISHED' && myPlayer && myPlayer.finished) {
            raceTime = Number(myPlayer.finishTime) || 0;
        }
        const mins = Math.floor(raceTime / 60), secs = Math.floor(raceTime % 60);
        document.getElementById('timer').textContent =
            String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');

        const cd = document.getElementById('countdown');
        if (this.state.state === 'COUNTDOWN') {
            cd.style.display = 'block';
            cd.textContent = this.state.countDown > 0 ? this.state.countDown : 'HAZIR...';
        } else {
            cd.style.display = 'none';
        }
    }

    gameLoop(last) {
        const now = performance.now();
        const dt = Math.min(0.05, ((last && now - last) / 1000) || 0.016);
        this.updateParticles(dt);
        this.render();
        requestAnimationFrame(() => this.gameLoop(now));
    }
}

window.addEventListener('load', () => { window.game = new RaceGame(); });
