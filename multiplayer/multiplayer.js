/* =========================================================================
   ARive — PeerJS Multiplayer
   -------------------------------------------------------------------------
   • Hosts publish a room doc to Firestore (see roomRegistry.js) so clients
     can browse a live room list and click-to-join.
   • Passwords use challenge/response: the host sends a random nonce on
     connect; the client replies with SHA-256(nonce + password).  No plain
     password ever leaves the client.
   • All gameplay data (carve, state, pickups, projectiles) still flows P2P
     over WebRTC — Firestore never sees a single voxel.
   ========================================================================= */
(function (global) {
    'use strict';

    const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    const ROOM_PREFIX = 'arive-v1-';
    const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const CODE_LEN = 6;                 // up from 4 — combined with Firestore uniqueness
    const STATE_SEND_HZ = 15;
    const STATE_SEND_INTERVAL = 1 / STATE_SEND_HZ;
    const REMOTE_TIMEOUT = 6000;
    const MAX_EVENT_LOG = 5000;
    const HEARTBEAT_MS = 15000;

    const ENEMY_STATE_HZ = 10;
    const ENEMY_STATE_INTERVAL = 1 / ENEMY_STATE_HZ;

    const Hooks = global.ARiveHooks;
    const Rooms = global.ARiveRooms;
    if (!Hooks) {
        console.warn('[MP] ARiveHooks missing — multiplayer disabled.');
        return;
    }
    if (!Rooms) {
        console.warn('[MP] ARiveRooms missing — room list disabled. Load roomRegistry.js first.');
    }

    /* =====================================================================
       STATE
       ===================================================================== */
    const mp = {
        peer: null,
        isHost: false,
        roomCode: '',         // 6-char room id
        roomName: '',
        roomPassword: '',     // host only, plaintext, in-memory
        myName: '',
        myId: '',
        hostId: '',
        connected: false,
        clients: new Map(),
        remotePlayers: new Map(),
        eventLog: [],
        _lastSendTime: 0,
        _hostConn: null,
        _hostFromGame: false,
        _pendingPassword: '',
        _heartbeatTimer: null,
        _roomsUnsub: null,
        _enemySendTimer: 0,
    };
    global.ARiveMP = mp;

    /* =====================================================================
       UTILITIES
       ===================================================================== */
    function $(id) { return document.getElementById(id); }

    function genCode() {
        const buf = new Uint32Array(CODE_LEN);
        if (global.crypto && global.crypto.getRandomValues) {
            global.crypto.getRandomValues(buf);
        } else {
            for (let i = 0; i < CODE_LEN; i++) buf[i] = (Math.random() * 0xffffffff) >>> 0;
        }
        let s = '';
        for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
        return s;
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function loadPeerJS() {
        return new Promise((resolve, reject) => {
            if (global.Peer) return resolve(global.Peer);
            const s = document.createElement('script');
            s.src = PEERJS_URL;
            s.async = true;
            s.onload = () => resolve(global.Peer);
            s.onerror = () => reject(new Error('Failed to load PeerJS'));
            document.head.appendChild(s);
        });
    }

    /* =====================================================================
       REMOTE PLAYER RENDERING  (unchanged)
       ===================================================================== */
    function makeNameTag(name) {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(0, 0, 256, 64);
        ctx.font = 'bold 28px "Courier New",monospace';
        ctx.fillStyle = '#e8c86a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(name || '?').slice(0, 16), 128, 34);
        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        const sp = new THREE.Sprite(mat);
        sp.scale.set(0.95, 0.24, 1);
        sp.position.y = 2.05;
        sp.renderOrder = 5;
        return sp;
    }

    function createRemotePlayer(id, name, avatarData) {
        if (mp.remotePlayers.has(id)) {
            const rp = mp.remotePlayers.get(id);
            if (name && rp.name !== name) {
                rp.name = name;
                rp.tag.material.map.dispose();
                rp.group.remove(rp.tag);
                rp.tag = makeNameTag(name);
                rp.group.add(rp.tag);
                updateSessionUI();
            }
            return rp;
        }

        // Convert the wire-format avatar → AVATAR_MODEL_DATA-shape for the builder
        let remoteModel = null;
        if (avatarData && global.ARiveAvatar) {
            try { remoteModel = global.ARiveAvatar.toRemoteModelData(avatarData); }
            catch (e) { console.warn('[MP] avatar convert failed:', e); }
        }

        const model = Hooks.buildRemotePlayerMesh(remoteModel);
        const group = model.group;
        group.position.set(0, -10, 0);
        const tag = makeNameTag(name);
        group.add(tag);
        Hooks.scene.add(group);

        const rp = {
            id, name: name || '?',
            model, group, tag,
            targetX: 0, targetY: -10, targetZ: 0, targetYaw: 0,
            bob: 0,
            moving: false, sprinting: false,
            crouchT: 0, targetCrouchT: 0,
            lastUpdate: performance.now(),
            heldPickupPid: null,
            currentToolId: null,
            toolUseAnimT: 1,
        };

        mp.remotePlayers.set(id, rp);
        updateSessionUI();
        return rp;
    }

    function removeRemotePlayer(id) {
        const rp = mp.remotePlayers.get(id);
        if (!rp) return;

        for (const p of Hooks.pickups) {
            if (p.carriedBy === id) {
                p.carriedBy = null;
                if (p.mesh.parent) p.mesh.parent.remove(p.mesh);
                p.mesh.scale.setScalar(1);
                p.mesh.position.copy(rp.group.position);
                p.mesh.position.y += 1.2;
                Hooks.scene.add(p.mesh);
                p.settled = false;
                p.vx = 0; p.vy = 0; p.vz = 0;
                p.avx = 0; p.avy = 0; p.avz = 0;
            }
        }

        Hooks.scene.remove(rp.group);
        rp.group.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
        });
        mp.remotePlayers.delete(id);
        updateSessionUI();
    }

    function clearRemotePlayers() {
        for (const id of [...mp.remotePlayers.keys()]) removeRemotePlayer(id);
    }

    function applyRemotePickupGrab(msg, senderId) {
        const rp = mp.remotePlayers.get(senderId);
        if (!rp) return;

        let pickup = null;
        for (const p of Hooks.pickups) if (p.pid === msg.pid) { pickup = p; break; }
        if (!pickup) return;

        rp.heldPickupPid = msg.pid;
        pickup.carriedBy = senderId;

        if (pickup.mesh.parent) pickup.mesh.parent.remove(pickup.mesh);
        pickup.mesh.position.set(0, -0.58, -0.10);
        pickup.mesh.rotation.set(0, 0, 0);
        pickup.mesh.scale.setScalar(0.85);
        rp.model.armR.add(pickup.mesh);
    }

    function applyRemotePickupRelease(msg, senderId) {
        const rp = mp.remotePlayers.get(senderId);
        if (rp) rp.heldPickupPid = null;

        let pickup = null;
        for (const p of Hooks.pickups) if (p.pid === msg.pid) { pickup = p; break; }
        if (!pickup) return;

        pickup.carriedBy = null;

        if (pickup.mesh.parent) pickup.mesh.parent.remove(pickup.mesh);
        pickup.mesh.scale.setScalar(1);
        pickup.mesh.position.set(msg.x || 0, msg.y || 0, msg.z || 0);
        if (msg.qx !== undefined) {
            pickup.mesh.quaternion.set(msg.qx, msg.qy, msg.qz, msg.qw);
        } else {
            pickup.mesh.rotation.set(0, 0, 0);
        }

        pickup.vx = msg.vx || 0; pickup.vy = msg.vy || 0; pickup.vz = msg.vz || 0;
        pickup.avx = msg.avx || 0; pickup.avy = msg.avy || 0; pickup.avz = msg.avz || 0;
        pickup.settled = false;

        Hooks.scene.add(pickup.mesh);
    }

    /* =====================================================================
       REMOTE EVENT APPLICATION  (unchanged)
       ===================================================================== */
    function applyRemoteCarve(x, y, z, rVox, ignite) {
        Hooks.carveSphere(x, y, z, rVox, { ignite: !!ignite, debrisChance: 0.08 });
    }
    function applyRemoteExplosion(x, y, z, rMeters) {
        Hooks.explodeAt(x, y, z, rMeters, true);
    }
    function applyRemotePickupSpawn(msg) {
        if (!msg || !msg.def || !msg.def.meta || !msg.def.meta.model) return;
        for (const p of Hooks.pickups) if (p.pid === msg.pid) return;
        const pos = new THREE.Vector3(msg.x, msg.y, msg.z);
        const p = Hooks.spawnPickup(msg.def, pos, msg.pid);
        if (p && msg.carriedBy) applyRemotePickupGrab({ pid: msg.pid }, msg.carriedBy);
    }
    function applyRemotePickupRemove(pid) {
        const list = Hooks.pickups;
        for (let i = list.length - 1; i >= 0; i--) {
            const p = list[i];
            if (p.pid === pid) {
                Hooks.scene.remove(p.mesh);
                p.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
                list.splice(i, 1);
                break;
            }
        }
    }
    function applyRemotePickupMove(msg) {
        for (const p of Hooks.pickups) {
            if (p.pid === msg.pid) {
                p.mesh.position.set(msg.x, msg.y, msg.z);
                p.settled = true;
                p.vx = p.vy = p.vz = 0;
                p.avx = p.avy = p.avz = 0;
                break;
            }
        }
    }

    /* =====================================================================
       MESSAGE DISPATCH
       ===================================================================== */
    function handleMessage(msg, senderId, isFromHost) {
        if (!msg || !msg.t) return;
        switch (msg.t) {
            case 'hello': if (mp.isHost) onClientHello(senderId, msg); break;
            case 'welcome': if (!mp.isHost) onWelcome(msg); break;
            case 'peer-join':
                if (!mp.isHost && msg.id !== mp.myId) {
                    mp.clients.set(msg.id, { name: msg.name });
                    createRemotePlayer(msg.id, msg.name, msg.avatar);   // ← avatar
                }
                break;
            case 'peer-leave':
                if (!mp.isHost) { mp.clients.delete(msg.id); removeRemotePlayer(msg.id); }
                break;
            case 'state': onRemoteState(msg, isFromHost); break;
            case 'carve': applyRemoteCarve(msg.x, msg.y, msg.z, msg.r, msg.ignite); break;
            case 'boom': applyRemoteExplosion(msg.x, msg.y, msg.z, msg.r); break;
            case 'pickup-spawn': applyRemotePickupSpawn(msg); break;
            case 'pickup-grab': applyRemotePickupGrab(msg, senderId); break;
            case 'pickup-release': applyRemotePickupRelease(msg, senderId); break;
            case 'pickup-remove': applyRemotePickupRemove(msg.pid); break;
            case 'pickup-move': applyRemotePickupMove(msg); break;
            case 'host-left': onHostLeft(); break;
            case 'set-blocks': Hooks.applyBlockBatch(msg.blocks); break;
            case 'tool-use': onRemoteToolUse(msg, senderId); break;
            case 'proj-spawn': Hooks.spawnRemoteProjectile(msg); break;

            case 'enemy-spawn': onRemoteEnemySpawn(msg); break;
            case 'enemy-batch': onRemoteEnemyBatch(msg); break;
            case 'enemy-carve': onRemoteEnemyCarve(msg); break;
            case 'enemy-death': onRemoteEnemyDeath(msg); break;
            case 'weapon-shot': spawnRemoteTracer(msg); break;
        }
    }

    function onClientHello(clientId, msg) {
        const peers = [];
        for (const [id, c] of mp.clients) {
            if (id === clientId) continue;
            peers.push({ id, name: c.name, avatar: c.avatar || null });
        }

        const pickupSnapshots = [];
        for (const p of Hooks.pickups) {
            if (!p.pid) continue;
            if (!p.def || !p.def.meta || !p.def.meta.model) continue;
            pickupSnapshots.push({
                pid: p.pid,
                def: {
                    name: p.def.name, iconImage: p.def.iconImage,
                    iconImageRotated: p.def.iconImageRotated,
                    w: p.def.w, h: p.def.h, color: p.def.color, meta: p.def.meta,
                },
                x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z,
                carriedBy: p.carriedBy === 'local' ? mp.myId : (p.carriedBy || null),
            });
        }

        const enemySnapshot = [];
        for (const e of (Hooks.enemies || [])) {
            if (!e._mpId || e._remoteOwned) continue;
            enemySnapshot.push({
                eid: e._mpId,
                type: e.kind,
                x: e.pos.x, y: e.pos.y, z: e.pos.z,
                yaw: e.yaw,
            });
        }

        const myAvatar = (global.ARiveAvatar ? global.ARiveAvatar.loadLocal() : null);

        const welcome = {
            t: 'welcome',
            hostId: mp.myId,
            hostName: mp.myName,
            hostAvatar: myAvatar,             // ← NEW
            roomName: mp.roomName,
            seed: Hooks.getCurrentSeed(),
            mapType: Hooks.getCurrentMapType(),
            peers: peers,                     // now includes avatar per peer
            pickups: pickupSnapshots,
            enemies: enemySnapshot,
            eventLog: mp.eventLog,
        };
        try { mp.clients.get(clientId).conn.send(welcome); } catch (e) { console.warn(e); }

        // Notify OTHER clients about this new peer — include their avatar
        for (const [id, c] of mp.clients) {
            if (id === clientId) continue;
            try {
                c.conn.send({
                    t: 'peer-join',
                    id: clientId,
                    name: msg.name,
                    avatar: msg.avatar || null,   // ← NEW
                });
            } catch (e) { }
        }

        createRemotePlayer(clientId, msg.name, msg.avatar);   // ← pass avatar
        updateSessionUI();
        broadcastHeartbeat();
    }

    function onWelcome(msg) {
        mp.hostId = msg.hostId;
        Hooks.showLoadingScreen();

        Promise.resolve()
            .then(function () {
                return Hooks.regenerateWorld(msg.seed, msg.mapType || "city");
            })
            .then(function () {
                createRemotePlayer(msg.hostId, msg.hostName, msg.hostAvatar);   // ← avatar
                for (const p of (msg.peers || [])) {
                    mp.clients.set(p.id, { name: p.name });
                    createRemotePlayer(p.id, p.name, p.avatar);                  // ← avatar
                }
                for (const es of (msg.enemies || [])) {
                    if (window.Enemies && window.Enemies.spawnRemote) {
                        window.Enemies.spawnRemote(
                            es.type, es.x, es.y, es.z, es.yaw, es.eid,
                        );
                    }
                }
                for (const snap of (msg.pickups || [])) applyRemotePickupSpawn(snap);

                const log = msg.eventLog || [];
                for (const ev of log) {
                    if (ev.t === 'carve') applyRemoteCarve(ev.x, ev.y, ev.z, ev.r, ev.ignite);
                    else if (ev.t === 'boom') applyRemoteExplosion(ev.x, ev.y, ev.z, ev.r);
                    else if (ev.t === 'pickup-spawn') applyRemotePickupSpawn(ev);
                    else if (ev.t === 'pickup-remove') applyRemotePickupRemove(ev.pid);
                    else if (ev.t === 'pickup-move') applyRemotePickupMove(ev);
                }

                mp.connected = true;
                updateSessionUI();
                Hooks.beginPlay();
            })
            .catch(function (e) {
                console.error("[MP] client join failed:", e);
                Hooks.beginPlay();
            });
    }

    function onHostLeft() {
        Hooks.setMpBadge('HOST LEFT');
        setTimeout(function () {
            leaveGame(false);
            Hooks.stopPlaying();
            var mpScr = $('mpScreen');
            if (mpScr) mpScr.classList.remove('hidden');
        }, 1500);
    }

    function onRemoteToolUse(msg, senderId) {
        const rp = mp.remotePlayers.get(senderId);
        if (!rp) return;
        if (msg.toolId && rp.currentToolId !== msg.toolId) {
            rp.currentToolId = msg.toolId;
            if (rp.model.toolHolders) {
                for (const id in rp.model.toolHolders) {
                    rp.model.toolHolders[id].visible = (id === msg.toolId);
                }
            }
        }
        rp.toolUseAnimT = 0;
    }

    function onRemoteEnemySpawn(msg) {
        if (mp.isHost) return;
        if (!window.Enemies || !window.Enemies.spawnRemote) return;
        window.Enemies.spawnRemote(msg.type, msg.x, msg.y, msg.z, msg.yaw, msg.eid);
    }

    function onRemoteEnemyBatch(msg) {
        if (mp.isHost) return;
        if (!window.Enemies || !window.Enemies.applyRemoteState) return;
        window.Enemies.applyRemoteState(msg.list);
    }

    function onRemoteEnemyCarve(msg) {
        if (mp.isHost) return;
        if (!window.Enemies || !window.Enemies.applyRemoteCarve) return;
        window.Enemies.applyRemoteCarve(msg.eid, msg.key, msg.x, msg.y, msg.z, msg.r);
    }

    function onRemoteEnemyHurt(msg) {
        if (!mp.isHost) return;
        if (!window.Enemies || !window.Enemies.hitRemote) return;
        window.Enemies.hitRemote(
            msg.eid, msg.hx, msg.hy, msg.hz,
            msg.dmg, msg.dx, msg.dy, msg.dz,
        );
    }

    function onRemoteState(msg, isFromHost) {
        let rp = mp.remotePlayers.get(msg.id);
        if (!rp) rp = createRemotePlayer(msg.id, msg.name || '?');
        rp.targetX = msg.x; rp.targetY = msg.y; rp.targetZ = msg.z;
        rp.targetYaw = msg.yaw;
        rp.moving = !!msg.moving;
        rp.sprinting = !!msg.sprinting;
        rp.targetCrouchT = (typeof msg.crouchT === 'number')
            ? msg.crouchT
            : (msg.crouching ? 1 : 0);
        rp.lastUpdate = performance.now();

        /* Tool vs. weapon holder swap — driven by the `weaponSlot` field. */
        const wantTool = msg.toolId || null;
        const wantSlot = (typeof msg.weaponSlot === 'number') ? msg.weaponSlot : -1;
        const wantWepKey = msg.weaponKey || null;

        if (rp.model.toolHolders) {
            for (const id in rp.model.toolHolders) {
                rp.model.toolHolders[id].visible =
                    (wantSlot < 0 && id === wantTool);
            }
        }
        if (rp.model.weaponHolders) {
            for (const key in rp.model.weaponHolders) {
                rp.model.weaponHolders[key].visible =
                    (wantSlot >= 0 && key === wantWepKey);
            }
        }
        rp.currentToolId = (wantSlot < 0) ? wantTool : ('W:' + wantWepKey);
        rp.currentWeaponKey = (wantSlot >= 0) ? wantWepKey : null;
    }

    /* =====================================================================
       SENDING
       ===================================================================== */
    function sendToHost(msg) {
        if (mp.isHost) return;
        if (mp._hostConn && mp._hostConn.open) {
            try { mp._hostConn.send(msg); } catch (e) { }
        }
    }
    function broadcastToClients(msg, exceptId) {
        if (!mp.isHost) return;
        for (const [id, c] of mp.clients) {
            if (id === exceptId) continue;
            if (c.conn && c.conn.open) {
                try { c.conn.send(msg); } catch (e) { }
            }
        }
    }
    function broadcastRelay(msg, exceptId) {
        if (msg.t === 'carve' || msg.t === 'boom' ||
            msg.t === 'pickup-spawn' || msg.t === 'pickup-remove' || msg.t === 'pickup-move') {
            if (mp.eventLog.length >= MAX_EVENT_LOG) mp.eventLog.splice(0, MAX_EVENT_LOG >> 1);
            const ev = { t: msg.t };
            if (msg.x !== undefined) ev.x = msg.x;
            if (msg.y !== undefined) ev.y = msg.y;
            if (msg.z !== undefined) ev.z = msg.z;
            if (msg.r !== undefined) ev.r = msg.r;
            if (msg.ignite !== undefined) ev.ignite = msg.ignite;
            if (msg.pid !== undefined) ev.pid = msg.pid;
            if (msg.def !== undefined) ev.def = msg.def;
            mp.eventLog.push(ev);
        }
        broadcastToClients(msg, exceptId);
    }

    /* =====================================================================
       LOCAL EVENT HOOKS  (called by game.js)  — unchanged
       ===================================================================== */
    mp.onLocalCarve = function (x, y, z, rVox, ignite) {
        const msg = { t: 'carve', x, y, z, r: rVox, ignite: !!ignite };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalExplosion = function (x, y, z, rMeters) {
        const msg = { t: 'boom', x, y, z, r: rMeters };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalPickupSpawn = function (p) {
        if (!p.pid) return;
        if (!p.def || !p.def.meta || !p.def.meta.model) return;

        const msg = {
            t: 'pickup-spawn', pid: p.pid,
            def: {
                name: p.def.name,
                iconImage: p.def.iconImage,
                iconImageRotated: p.def.iconImageRotated,
                w: p.def.w, h: p.def.h,
                color: p.def.color,
                meta: p.def.meta,

                // Fields added so weapons / ammo / furniture / stacks survive
                // the round-trip through the host.
                size: p.def.size,
                furnitureKey: p.def.furnitureKey,
                count: p.def.count,
                maxStack: p.def.maxStack,
                isAmmo: !!p.def.isAmmo,
                ammoType: p.def.ammoType,
                isWeapon: !!p.def.isWeapon,
                weaponDef: p.def.weaponDef || null,
            },
            x: p.mesh.position.x,
            y: p.mesh.position.y,
            z: p.mesh.position.z,
        };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalPickupRemove = function (p) {
        if (!p.pid) return;
        const msg = { t: 'pickup-remove', pid: p.pid };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalPickupSettled = function (p) {
        if (!p.pid) return;
        const msg = {
            t: 'pickup-move', pid: p.pid,
            x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z
        };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalPickupGrab = function (p) {
        if (!p.pid) return;
        const msg = { t: 'pickup-grab', pid: p.pid };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalPickupRelease = function (p) {
        if (!p.pid) return;
        const q = p.mesh.quaternion;
        const msg = {
            t: 'pickup-release', pid: p.pid,
            x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
            vx: p.vx, vy: p.vy, vz: p.vz,
            avx: p.avx, avy: p.avy, avz: p.avz
        };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalBlockBatch = function (blocks) {
        if (!blocks || !blocks.length) return;
        const msg = { t: 'set-blocks', blocks: blocks };
        if (mp.isHost) broadcastRelay(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalToolUse = function (toolId) {
        if (!toolId) return;
        const msg = { t: 'tool-use', toolId: toolId };
        if (mp.isHost) broadcastToClients(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    mp.onLocalProjectileSpawn = function (proj) {
        if (!proj || !proj.projId) return;
        const msg = {
            t: 'proj-spawn', projId: proj.projId,
            px: proj.pos.x, py: proj.pos.y, pz: proj.pos.z,
            vx: proj.vel.x, vy: proj.vel.y, vz: proj.vel.z,
            life: proj.life,
        };
        if (mp.isHost) broadcastToClients(msg, null);
        else if (mp.connected) sendToHost(msg);
    };
    /* ---- Enemy sync (host → clients) ---- */
    mp.onEnemySpawned = function (e) {
        if (!mp.connected) return;
        if (!e || !e._mpId) return;
        if (e._remoteOwned) return;              // never echo remote mirrors

        const msg = {
            t: 'enemy-spawn',
            eid: e._mpId,
            type: e.kind,
            x: e.pos.x, y: e.pos.y, z: e.pos.z,
            yaw: e.yaw,
        };
        if (mp.isHost) broadcastToClients(msg, null);
        else sendToHost(msg);                    // ← client path was missing
    };

    mp.requestEnemySpawn = function (type, x, y, z) {
        if (!mp.connected || mp.isHost) return false;
        sendToHost({ t: 'request-spawn', kind: 'enemy', type, x, y, z });
        return true;
    };

    mp.onEnemyKilled = function (e) {
        if (!mp.connected || !mp.isHost) return;
        if (!e || !e._mpId) return;
        broadcastToClients({ t: 'enemy-death', eid: e._mpId }, null);
    };

    mp.onEnemyCarved = function (eid, partKey, wx, wy, wz, rVox) {
        if (!mp.connected || !mp.isHost) return;
        broadcastToClients({
            t: 'enemy-carve',
            eid: eid, key: partKey,
            x: wx, y: wy, z: wz, r: rVox,
        }, null);
    };

    /* ---- Enemy hurt (client → host) ---- */
    mp.sendEnemyHurt = function (eid, hx, hy, hz, dmg, dx, dy, dz) {
        if (!mp.connected || mp.isHost) return;
        sendToHost({
            t: 'enemy-hurt',
            eid: eid,
            hx: hx, hy: hy, hz: hz,
            dmg: dmg,
            dx: dx, dy: dy, dz: dz,
        });
    };

    /* ---- Weapon fire (any → all) ---- */
    mp.onLocalWeaponShot = function (shot) {
        if (!mp.connected || !shot) return;
        const msg = {
            t: 'weapon-shot',
            fx: shot.fx, fy: shot.fy, fz: shot.fz,
            tx: shot.tx, ty: shot.ty, tz: shot.tz,
            c: shot.c, s: shot.s,
        };
        if (mp.isHost) broadcastToClients(msg, null);
        else sendToHost(msg);
    };

    function broadcastEnemyStates() {
        const enemies = Hooks.enemies || [];
        const list = [];
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e._mpId || e._remoteOwned) continue;
            const entry = {
                i: e._mpId,
                x: +e.pos.x.toFixed(3),
                y: +e.pos.y.toFixed(3),
                z: +e.pos.z.toFixed(3),
                yaw: +e.yaw.toFixed(3),
                hp: Math.round(e.hp),
                a: e.alive ? 1 : 0,
                cb: +(e.crawlBlend || 0).toFixed(2),
                sl: +(e.hitSlowTimer || 0).toFixed(2),
            };
            // Boss action state — only for mini/final bosses
            if (e.kind === '__mini_boss__' || e.kind === '__final_boss__') {
                entry.th = e.isThrowing ? 1 : 0;
                entry.tt = +((e.throwTimer || 0).toFixed(2));
                entry.sm = e.isSlamming ? 1 : 0;
                entry.st = +((e.slamTimer || 0).toFixed(2));
                entry.sy = (typeof e.slamYaw === 'number') ? +e.slamYaw.toFixed(2) : 0;
            }
            list.push(entry);
        }
        if (!list.length) return;
        broadcastToClients({ t: 'enemy-batch', list }, null);
    }

    function spawnRemoteTracer(msg) {
        if (typeof THREE === 'undefined') return;
        const scene = Hooks.scene;
        if (!scene) return;

        const from = new THREE.Vector3(msg.fx, msg.fy, msg.fz);
        const to = new THREE.Vector3(msg.tx, msg.ty, msg.tz);
        const dist = from.distanceTo(to);
        if (dist < 0.05) return;

        const size = msg.s || 0.03;
        const geo = new THREE.BoxGeometry(size, size, dist);
        const mat = new THREE.MeshBasicMaterial({
            color: msg.c || 0xffddaa,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            fog: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(from).lerp(to, 0.5);
        mesh.lookAt(to);
        scene.add(mesh);

        let life = 0.055;
        const maxLife = life;
        function fade() {
            life -= 0.016;
            if (life <= 0) {
                if (mesh.parent) mesh.parent.remove(mesh);
                geo.dispose(); mat.dispose();
                return;
            }
            mat.opacity = (life / maxLife) * 0.95;
            requestAnimationFrame(fade);
        }
        requestAnimationFrame(fade);

        // Muzzle flash — quick, additive sphere.
        const fGeo = new THREE.SphereGeometry(0.1, 8, 6);
        const fMat = new THREE.MeshBasicMaterial({
            color: msg.c || 0xffddaa,
            transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false, fog: false,
        });
        const flash = new THREE.Mesh(fGeo, fMat);
        flash.position.copy(from);
        scene.add(flash);
        setTimeout(() => {
            if (flash.parent) flash.parent.remove(flash);
            fGeo.dispose(); fMat.dispose();
        }, 55);
    }

    /* =====================================================================
       STATE BROADCAST  (unchanged)
       ===================================================================== */
    function sendState() {
        if (!mp.connected) return;
        const player = Hooks.player;
        const moving = Math.hypot(player.vel.x, player.vel.z) > 0.5;
        const weaponSlot = (window.Weapons && window.Weapons.getActiveSlot)
            ? window.Weapons.getActiveSlot() : -1;
        const weaponDef = (weaponSlot >= 0 && window.Weapons && window.Weapons.getActiveWeapon)
            ? window.Weapons.getActiveWeapon() : null;

        const msg = {
            t: 'state',
            id: mp.myId,
            name: mp.myName,
            x: player.pos.x,
            y: player.pos.y,
            z: player.pos.z,
            yaw: player.baseYaw,
            pitch: player.pitch,
            moving: moving,
            sprinting: moving && !!player._sprinting,
            crouchT: player.crouchT || 0,
            toolId: Hooks.getCurrentToolId(),
            weaponSlot: weaponSlot,
            weaponKey: weaponDef ? weaponDef.key : null,
        };
        if (mp.isHost) broadcastToClients(msg, null);
        else sendToHost(msg);
    }

    /* =====================================================================
       HEARTBEAT
       ===================================================================== */
    function startHeartbeat() {
        stopHeartbeat();
        if (!mp.isHost || !mp.roomCode || !Rooms) return;
        if (!Rooms.isReady || !Rooms.isReady()) return;
        mp._heartbeatTimer = setInterval(() => {
            if (!mp.isHost || !mp.roomCode) return;
            Rooms.updateHeartbeat(mp.roomCode, { playerCount: 1 + mp.remotePlayers.size });
        }, HEARTBEAT_MS);
    }
    function stopHeartbeat() {
        if (mp._heartbeatTimer) {
            clearInterval(mp._heartbeatTimer);
            mp._heartbeatTimer = null;
        }
    }
    function broadcastHeartbeat() {
        if (!mp.isHost || !mp.roomCode || !Rooms) return;
        Rooms.updateHeartbeat(mp.roomCode, { playerCount: 1 + mp.remotePlayers.size });
    }

    /* =====================================================================
       HOST
       ===================================================================== */
    async function hostGame(name, mapType, isNewWorld, roomName, password) {
        mp.myName = (name || 'Host').slice(0, 16);
        mp.roomPassword = password || '';
        mp.roomName = (roomName || (mp.myName + "'s World")).slice(0, 32);
        mapType = mapType || 'city';

        setHostStatus('Creating room…');

        /* Room registry is BEST-EFFORT.  A guest (or any offline user)
           can still host — the P2P session does not depend on Firestore. */
        let registryAvailable = false;
        if (Rooms) {
            try { await Rooms.init(); registryAvailable = true; }
            catch (e) {
                console.warn('[MP] room registry unavailable — hosting offline:', e);
                registryAvailable = false;
            }
        }

        let Peer;
        try { Peer = await loadPeerJS(); }
        catch (e) { setHostStatus('Could not load PeerJS.'); return; }

        for (let attempt = 0; attempt < 6; attempt++) {
            const roomId = genCode();
            const peerId = ROOM_PREFIX + roomId;
            try {
                const peer = await new Promise((resolve, reject) => {
                    const p = new Peer(peerId, { debug: 1 });
                    let settled = false;
                    p.on('open', () => { if (!settled) { settled = true; resolve(p); } });
                    p.on('error', (err) => {
                        if (!settled) { settled = true; try { p.destroy(); } catch (e) { } reject(err); }
                    });
                });

                /* Register the room for discovery — NON-FATAL if it fails. */
                if (registryAvailable) {
                    try {
                        await Rooms.createRoom({
                            roomId, hostPeerId: peerId,
                            hostName: mp.myName, roomName: mp.roomName,
                            mapType, hasPassword: !!password,
                            maxPlayers: 8,
                        });
                    } catch (e) {
                        console.warn('[MP] room registration failed — code ' +
                            roomId + ' will not appear in the public list:', e);
                    }
                }

                mp.peer = peer;
                mp.isHost = true;
                mp.myId = peerId;
                mp.roomCode = roomId;
                mp.connected = true;
                mp.clients.clear();
                mp.eventLog.length = 0;

                peer.on('connection', onIncomingConnection);
                peer.on('error', (err) => {
                    if (err.type === 'peer-unavailable') setHostStatus('Peer unavailable.');
                });
                peer.on('disconnected', () => console.warn('[MP] signaling disconnected'));

                startHeartbeat();
                updateSessionUI();

                if (isNewWorld) Hooks.startPlaying(mapType);
                else Hooks.beginPlay();
                return;
            } catch (e) {
                console.warn('[MP] host attempt', attempt, 'failed:', e.type || e);
                if (attempt === 5) setHostStatus('Could not create room: ' + (e.type || e.message || 'unknown'));
            }
        }
    }

    function onIncomingConnection(conn) {
        // ---- Challenge handshake -----------------------------------------
        const nonce = Rooms ? Rooms.genNonce() : String(Math.random());
        const needsPassword = !!mp.roomPassword;
        conn._nonce = nonce;
        conn._authed = false;

        conn.on('open', () => {
            try {
                conn.send({ t: 'challenge', nonce: nonce, needsPassword: needsPassword });
            } catch (e) { }
        });

        conn.on('data', async (data) => {
            let msg = data;
            if (typeof msg === 'string') {
                try { msg = JSON.parse(msg); } catch (e) { return; }
            }
            await handleHostIncoming(msg, conn);
        });

        conn.on('close', () => {
            mp.clients.delete(conn.peer);
            removeRemotePlayer(conn.peer);
            broadcastToClients({ t: 'peer-leave', id: conn.peer }, null);
            updateSessionUI();
            broadcastHeartbeat();
        });
        conn.on('error', (err) => console.warn('[MP] conn error', err));
    }

    async function handleHostIncoming(msg, conn) {
        if (!msg || !msg.t) return;
        const senderId = conn.peer;

        if (msg.t === 'hello') {
            // Validate password if this room is protected
            if (mp.roomPassword && Rooms) {
                const expected = await Rooms.hashPassword(mp.roomPassword, conn._nonce);
                if (msg.passwordProof !== expected) {
                    try { conn.send({ t: 'denied', reason: 'bad-password' }); } catch (e) { }
                    setTimeout(() => { try { conn.close(); } catch (e) { } }, 120);
                    return;
                }
            }
            conn._authed = true;
            mp.clients.set(senderId, { conn, name: msg.name || '?', avatar: msg.avatar || null });
            onClientHello(senderId, msg);
            return;
        }

        // Any other message requires successful auth
        if (!conn._authed) return;

        switch (msg.t) {
            case 'state': {
                const relay = Object.assign({}, msg, { id: senderId });
                handleMessage(relay, senderId, false);
                broadcastToClients(relay, senderId);
                break;
            }
            case 'carve':
            case 'boom':
            case 'set-blocks':
            case 'pickup-spawn':
            case 'pickup-grab':
            case 'pickup-release':
            case 'pickup-remove':
            case 'request-spawn':
                if (msg.kind === 'enemy' && window.Enemies && window.Enemies.spawn) {
                    window.Enemies.spawn(msg.type, { x: msg.x, y: msg.y, z: msg.z });
                    // spawnEnemy auto-fires onEnemySpawned → broadcast to all clients
                }
                break;
            case 'pickup-move':
                handleMessage(msg, senderId, false);
                broadcastRelay(msg, senderId);
                break;
            case 'tool-use':
                handleMessage(msg, senderId, false);
                broadcastToClients(msg, senderId);
                break;
            case 'proj-spawn':
                handleMessage(msg, senderId, false);
                broadcastToClients(msg, senderId);
                break;

            case 'enemy-spawn': onRemoteEnemySpawn(msg); break;
            case 'enemy-batch': onRemoteEnemyBatch(msg); break;
            case 'enemy-carve': onRemoteEnemyCarve(msg); break;
            case 'enemy-hurt': if (mp.isHost) onRemoteEnemyHurt(msg); break;
            case 'weapon-shot': spawnRemoteTracer(msg); break;
            case 'enemy-death': onRemoteEnemyDeath(msg); break;
        }
    }

    function onRemoteEnemyDeath(msg) {
        if (mp.isHost) return;
        if (!window.Enemies || !window.Enemies.findByMpId) return;
        const e = window.Enemies.findByMpId(msg.eid);
        if (!e || !e.alive) return;
        // Force the death animation.  `_remoteOwned` is already true on the
        // mirror, so killEnemy won't echo this back to the host.
        e.hp = 0;
        if (window.Enemies.hurt) window.Enemies.hurt(e, 9999);
    }

    /* =====================================================================
       JOIN
       ===================================================================== */
    async function joinGame(name, roomId, password) {
        mp.myName = (name || 'Survivor').slice(0, 16);
        mp._pendingPassword = password || '';
        roomId = String(roomId || '').toUpperCase().trim();
        if (roomId.length !== CODE_LEN) { setJoinStatus('Invalid room ID.'); return; }

        setJoinStatus('Connecting…');
        let Peer;
        try { Peer = await loadPeerJS(); }
        catch (e) { setJoinStatus('Could not load PeerJS.'); return; }

        const hostPeerId = ROOM_PREFIX + roomId;

        try {
            const peer = await new Promise((resolve, reject) => {
                const p = new Peer({ debug: 1 });
                let settled = false;
                p.on('open', () => { if (!settled) { settled = true; resolve(p); } });
                p.on('error', (err) => {
                    if (!settled) { settled = true; try { p.destroy(); } catch (e) { } reject(err); }
                });
            });

            mp.peer = peer;
            mp.isHost = false;
            mp.myId = peer.id;
            mp.hostId = hostPeerId;
            mp.roomCode = roomId;

            peer.on('error', (err) => {
                if (err.type === 'peer-unavailable') {
                    setJoinStatus('Host not found. Room may have closed.');
                    cleanupFailedJoin();
                }
            });

            setJoinStatus('Connecting to host…');
            const conn = peer.connect(hostPeerId, { reliable: true });

            conn.on('open', () => {
                mp.connected = true;
                mp._hostConn = conn;
                setJoinStatus('Authenticating…');
                // We wait for the host's challenge before sending hello.
            });
            conn.on('data', async (data) => {
                let msg = data;
                if (typeof msg === 'string') {
                    try { msg = JSON.parse(msg); } catch (e) { return; }
                }
                if (msg.t === 'challenge') {
                    await handleChallenge(msg);
                    return;
                }
                if (msg.t === 'denied') {
                    if (msg.reason === 'bad-password' && !mp._pwRetried) {
                        mp._pwRetried = true;
                        const pw = window.prompt('Wrong password. Try again:');
                        if (pw) {
                            const myName = mp.myName;
                            const roomId = mp.roomCode;
                            cleanupFailedJoin();
                            joinGame(myName, roomId, pw);
                            return;
                        }
                    }
                    setJoinStatus('Access denied: ' + (msg.reason || 'unknown'));
                    cleanupFailedJoin();
                    return;
                }
                handleMessage(msg, hostPeerId, true);
            });
            conn.on('close', () => {
                if (mp.connected) { setJoinStatus('Disconnected from host.'); leaveGame(false); }
            });
            conn.on('error', (err) => {
                console.warn('[MP] conn err', err);
                setJoinStatus('Connection error.');
            });

        } catch (e) {
            console.error('[MP] join failed', e);
            setJoinStatus('Could not join: ' + (e.type || e.message || 'unknown'));
        }
    }

    async function handleChallenge(msg) {
        const nonce = msg.nonce || '';
        let proof = null;

        if (msg.needsPassword) {
            let pw = mp._pendingPassword;
            if (!pw) {
                pw = window.prompt('This room is password-protected.\nEnter the password:');
                if (pw == null) {
                    setJoinStatus('Cancelled.');
                    cleanupFailedJoin();
                    return;
                }
                mp._pendingPassword = pw;
            }
            if (Rooms) proof = await Rooms.hashPassword(pw, nonce);
        }

        setJoinStatus('Syncing world…');
        sendToHost({
            t: 'hello',
            name: mp.myName,
            passwordProof: proof,
            avatar: myAvatar,               // ← NEW
        });
    }


    function cleanupFailedJoin() {
        if (mp._hostConn) { try { mp._hostConn.close(); } catch (e) { } mp._hostConn = null; }
        if (mp.peer) { try { mp.peer.destroy(); } catch (e) { } mp.peer = null; }
        mp.connected = false;
        mp._pendingPassword = '';
    }

    /* =====================================================================
       LEAVE
       ===================================================================== */
    function leaveGame(doCleanup) {
        if (doCleanup === undefined) doCleanup = true;

        stopHeartbeat();
        if (mp.isHost && mp.roomCode && Rooms) {
            Rooms.deleteRoom(mp.roomCode); // fire-and-forget
        }

        if (!mp.isHost) {
            if (mp._hostConn) { try { mp._hostConn.close(); } catch (e) { } mp._hostConn = null; }
        }

        if (mp.peer) { try { mp.peer.destroy(); } catch (e) { } mp.peer = null; }

        mp.connected = false;
        mp.isHost = false;
        mp.roomCode = '';
        mp.roomName = '';
        mp.roomPassword = '';
        mp.myId = '';
        mp._pendingPassword = '';
        mp.eventLog.length = 0;
        clearRemotePlayers();
        Hooks.setMpBadge('');
        mp._pwRetried = false;

        if (doCleanup) Hooks.stopPlaying();
        updateSessionUI();
    }
    mp.leaveGame = leaveGame;

    /* =====================================================================
       UPDATE LOOP  (unchanged)
       ===================================================================== */
    mp.update = function (dt) {
        if (!mp.connected) return;

        mp._lastSendTime += dt;
        if (mp._lastSendTime >= STATE_SEND_INTERVAL) {
            mp._lastSendTime = 0;
            sendState();
        }

        if (mp.isHost) {
            mp._enemySendTimer += dt;
            if (mp._enemySendTimer >= ENEMY_STATE_INTERVAL) {
                mp._enemySendTimer = 0;
                broadcastEnemyStates();
            }
        }

        const now = performance.now();
        for (const [id, rp] of mp.remotePlayers) {
            const k = Math.min(1, dt * 10);
            rp.group.position.x += (rp.targetX - rp.group.position.x) * k;
            rp.group.position.y += (rp.targetY - rp.group.position.y) * k;
            rp.group.position.z += (rp.targetZ - rp.group.position.z) * k;

            let d = rp.targetYaw - rp.group.rotation.y;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            rp.group.rotation.y += d * Math.min(1, dt * 12);

            const moved = rp.moving ||
                Math.hypot(rp.targetX - rp.group.position.x,
                    rp.targetZ - rp.group.position.z) > 0.06;

            if (moved) rp.bob += dt * (rp.sprinting ? 13 : 9);
            else rp.bob += dt * 1.4;

            const amp = moved ? (rp.sprinting ? 0.46 : 0.64) : 0;
            const sw = Math.sin(rp.bob);
            if (rp.model.legL) rp.model.legL.rotation.x = sw * amp;
            if (rp.model.legR) rp.model.legR.rotation.x = -sw * amp;
            if (rp.model.armL) rp.model.armL.rotation.x = -sw * amp * 0.55;
            if (rp.model.armR) rp.model.armR.rotation.x = sw * amp * 0.55;

            const cTgt = rp.targetCrouchT || 0;
            if (Math.abs(rp.crouchT - cTgt) > 0.001) {
                rp.crouchT += (cTgt - rp.crouchT) * Math.min(1, dt * 12);
            } else {
                rp.crouchT = cTgt;
            }
            const crouchMul = (Hooks.CROUCH_MUL !== undefined) ? Hooks.CROUCH_MUL : 0.55;
            const bodyScaleY = 1 - (1 - crouchMul) * rp.crouchT;
            rp.group.scale.y = bodyScaleY;
            if (rp.tag) rp.tag.scale.y = 0.24 / bodyScaleY;

            if (now - rp.lastUpdate > REMOTE_TIMEOUT) removeRemotePlayer(id);

            if (rp.toolUseAnimT < 1) {
                rp.toolUseAnimT = Math.min(1, rp.toolUseAnimT + dt * 5.5);
                const holder = rp.model.toolHolders && rp.model.toolHolders[rp.currentToolId];
                if (holder && holder.userData.swing !== undefined) {
                    const bell = rp.toolUseAnimT < 1 ? Math.sin(rp.toolUseAnimT * Math.PI) : 0;
                    holder.rotation.x = holder.userData.baseRx + bell * holder.userData.swing;
                    holder.rotation.y = holder.userData.baseRy;
                    holder.rotation.z = holder.userData.baseRz;
                    holder.position.z = holder.userData.basePz + bell * holder.userData.kick;
                }
            }
        }
    };

    mp.onWorldReset = function () { clearRemotePlayers(); };

    /* =====================================================================
       UI
       ===================================================================== */
    function setHostStatus(text) { var el = $('mpHostStatus'); if (el) el.textContent = text || ''; }
    function setJoinStatus(text) { var el = $('mpJoinStatus'); if (el) el.textContent = text || ''; }

    function updateSessionUI() {
        if (mp.connected && mp.roomCode) {
            const count = 1 + mp.remotePlayers.size;
            Hooks.setMpBadge('ROOM ' + mp.roomCode + ' · ' + count + ' PLAYER' + (count === 1 ? '' : 'S'));
        } else {
            Hooks.setMpBadge('');
        }

        const overlayMpBtn = $('mpBtn');
        const overlayLeaveBtn = $('mpLeaveBtn');
        if (overlayMpBtn) overlayMpBtn.classList.toggle('hidden', !!mp.connected);
        if (overlayLeaveBtn) overlayLeaveBtn.classList.toggle('hidden', !mp.connected);
    }

    function showPicker() {
        var picker = $('mpPicker'); if (picker) picker.classList.remove('hidden');
        var nameField = $('mpNameField'); if (nameField) nameField.classList.remove('hidden');
        $('mpActions').classList.remove('hidden');
        $('mpHostPanel').classList.add('hidden');
        $('mpJoinPanel').classList.add('hidden');
        $('mpPasswordPrompt').classList.add('hidden');
        setHostStatus('');
        setJoinStatus('');
    }

    // ---- Room list -------------------------------------------------------
    let currentRooms = [];
    let pendingJoinRoom = null;

    function openRoomList() {
        $('mpActions').classList.add('hidden');
        $('mpHostPanel').classList.add('hidden');
        $('mpPasswordPrompt').classList.add('hidden');
        $('mpJoinPanel').classList.remove('hidden');
        setJoinStatus('');

        const ci = $('mpJoinCode');
        if (ci) ci.value = '';

        startRoomListSubscription();
    }

    function closeRoomList() {
        stopRoomListSubscription();
        $('mpJoinPanel').classList.add('hidden');
        $('mpPasswordPrompt').classList.add('hidden');
        $('mpNameField').classList.remove('hidden');   // <-- add this
        $('mpActions').classList.remove('hidden');
        setJoinStatus('');
    }

    function startRoomListSubscription() {
        if (mp._roomsUnsub) return;
        if (!Rooms) {
            renderRoomList([]);
            return;
        }
        const list = $('mpRoomList');
        if (list) list.innerHTML = '<div class="mp-room-empty">Loading rooms…</div>';
        mp._roomsUnsub = Rooms.subscribeRooms(renderRoomList);
    }

    function stopRoomListSubscription() {
        if (mp._roomsUnsub) {
            try { mp._roomsUnsub(); } catch (e) { }
            mp._roomsUnsub = null;
        }
    }

    function renderRoomList(rooms) {
        currentRooms = rooms || [];
        const list = $('mpRoomList');
        if (!list) return;

        if (!currentRooms.length) {
            list.innerHTML = '<div class="mp-room-empty">No rooms online — host one!</div>';
            return;
        }

        list.innerHTML = '';
        for (const r of currentRooms) {
            const row = document.createElement('div');
            row.className = 'mp-room-row';

            const info = document.createElement('div');
            info.className = 'mp-room-info';

            const name = document.createElement('div');
            name.className = 'mp-room-name';
            name.textContent = r.roomName || r.hostName || 'Unnamed Room';
            info.appendChild(name);

            const meta = document.createElement('div');
            meta.className = 'mp-room-meta';
            const mapLabel = r.mapType === 'sandbox' ? 'SANDBOX' : 'RUIN CITY';
            meta.textContent =
                (r.hostName || '?') + ' · ' + mapLabel +
                ' · ' + (r.playerCount || 1) + '/' + (r.maxPlayers || 8) + ' players' +
                (r.hasPassword ? ' · 🔒 locked' : '');
            info.appendChild(meta);

            row.appendChild(info);

            const btn = document.createElement('button');
            btn.className = 'btn mp-room-join';
            btn.textContent = r.hasPassword ? '🔒 JOIN' : 'JOIN';
            btn.addEventListener('click', () => onJoinRoomClick(r.roomId));
            row.appendChild(btn);

            list.appendChild(row);
        }
    }

    function onJoinRoomClick(roomId) {
        const name = ($('mpName').value || '').trim();
        if (!name) { setJoinStatus('Enter a name first.'); return; }

        const room = currentRooms.find(r => r.roomId === roomId);
        if (!room) { setJoinStatus('Room no longer available.'); return; }

        if (room.hasPassword) {
            pendingJoinRoom = room;
            $('mpJoinPanel').classList.add('hidden');
            $('mpPasswordPrompt').classList.remove('hidden');
            const lbl = $('mpPasswordRoomName');
            if (lbl) lbl.textContent = 'Password for "' + (room.roomName || room.hostName || 'room') + '"';
            $('mpJoinPassword').value = '';
            setJoinStatus('');
            setTimeout(() => $('mpJoinPassword').focus(), 40);
            return;
        }

        joinGame(name, roomId, '');
    }

    function onPasswordConfirm() {
        if (!pendingJoinRoom) return;
        const pw = $('mpJoinPassword').value;
        if (!pw) { setJoinStatus('Enter the password.'); return; }
        const name = ($('mpName').value || '').trim();
        const roomId = pendingJoinRoom.roomId;
        pendingJoinRoom = null;
        $('mpPasswordPrompt').classList.add('hidden');
        joinGame(name, roomId, pw);
    }

    function onPasswordCancel() {
        pendingJoinRoom = null;
        $('mpPasswordPrompt').classList.add('hidden');
        $('mpJoinPanel').classList.remove('hidden');
        setJoinStatus('');
    }

    function onJoinByCode() {
        const name = ($('mpName').value || '').trim();
        if (!name) { setJoinStatus('Enter a name first.'); return; }

        const input = $('mpJoinCode');
        const code = (input.value || '').trim().toUpperCase();
        if (code.length !== CODE_LEN) {
            setJoinStatus('Enter the ' + CODE_LEN + '-character room code.');
            input.focus();
            return;
        }

        // 若该房间恰好在列表里且有密码，走原来的密码提示 UI
        const known = currentRooms.find(r => r.roomId === code);
        if (known && known.hasPassword) {
            pendingJoinRoom = known;
            $('mpJoinPanel').classList.add('hidden');
            $('mpPasswordPrompt').classList.remove('hidden');
            const lbl = $('mpPasswordRoomName');
            if (lbl) lbl.textContent = 'Password for "' +
                (known.roomName || known.hostName || 'room') + '"';
            $('mpJoinPassword').value = '';
            setJoinStatus('');
            setTimeout(() => $('mpJoinPassword').focus(), 40);
            return;
        }

        // 直接 P2P 连——完全绕过 Firestore
        stopRoomListSubscription();
        joinGame(name, code, '');
    }

    // ---- Name preference -------------------------------------------------
    function applyDefaultName() {
        const nameInput = $('mpName');
        if (!nameInput) return;

        // Explicit user preference always wins
        let saved = '';
        try { saved = localStorage.getItem('arive-name') || ''; } catch (e) { }
        if (saved) { nameInput.value = saved; return; }

        // Otherwise, seed from Google if signed in
        if (global.ARiveAuthUI && global.ARiveAuthUI.isSignedIn()) {
            const display = global.ARiveAuthUI.getDisplayName();
            if (display && display !== 'Survivor') {
                nameInput.value = display.slice(0, 16);
            }
        }
    }

    function attachAuthListener() {
        if (!global.ARiveAuthUI || !global.ARiveAuthUI.onChange) return;
        global.ARiveAuthUI.onChange(function (profile) {
            // If the user has typed a custom name, never overwrite it
            let saved = '';
            try { saved = localStorage.getItem('arive-name') || ''; } catch (e) { }
            if (saved) return;

            const nameInput = $('mpName');
            if (!nameInput) return;
            if (profile && profile.displayName) {
                nameInput.value = profile.displayName.slice(0, 16);
            }
        });
    }

    function initUI() {
        const nameInput = $('mpName');
        if (!nameInput) return;

        applyDefaultName();
        attachAuthListener();

        nameInput.addEventListener('input', () => {
            try { localStorage.setItem('arive-name', nameInput.value); } catch (e) { }
        });

        // ---- Entry from the main map-select screen ----
        const mapMpBtn = $('mapMpBtn');
        if (mapMpBtn) {
            mapMpBtn.addEventListener('click', () => {
                if (mp.connected) return;
                mp._hostFromGame = false;
                $('mapSelect').classList.add('hidden');
                $('mpScreen').classList.remove('hidden');
                showPicker();
                setTimeout(() => nameInput.focus(), 40);
            });
        }

        // ---- Entry from the ESC overlay ----
        const overlayMpBtn = $('mpBtn');
        if (overlayMpBtn) {
            overlayMpBtn.addEventListener('click', () => {
                if (mp.connected) return;
                mp._hostFromGame = true;
                $('overlay').classList.add('hidden');
                $('mpScreen').classList.remove('hidden');
                showPicker();
                setTimeout(() => nameInput.focus(), 40);
            });
        }

        $('mpHostBtn').addEventListener('click', async () => {
            const n = nameInput.value.trim();
            if (!n) { setHostStatus('Enter a name first.'); nameInput.focus(); return; }

            if (mp._hostFromGame) {
                await hostGame(n, Hooks.getCurrentMapType(), false, '', '');
                return;
            }

            $('mpNameField').classList.add('hidden');   // <-- add this
            $('mpActions').classList.add('hidden');
            $('mpJoinPanel').classList.add('hidden');
            $('mpHostPanel').classList.remove('hidden');
            $('mpRoomName').value = n + "'s World";
            $('mpRoomPrivate').checked = false;
            $('mpPasswordField').classList.add('hidden');
            $('mpRoomPassword').value = '';
            setHostStatus('');
        });

        $('mpJoinBtn').addEventListener('click', () => {
            const n = nameInput.value.trim();
            if (!n) { setJoinStatus('Enter a name first.'); nameInput.focus(); return; }
            $('mpNameField').classList.add('hidden');   // <-- add this
            openRoomList();
        });

        // Password toggle in the host panel
        $('mpRoomPrivate').addEventListener('change', (e) => {
            $('mpPasswordField').classList.toggle('hidden', !e.target.checked);
            if (e.target.checked) setTimeout(() => $('mpRoomPassword').focus(), 40);
        });

        // Host map cards
        document.querySelectorAll('#mpScreen .map-card[data-host-map]').forEach(card => {
            card.addEventListener('click', async () => {
                const n = nameInput.value.trim();
                if (!n) { setHostStatus('Enter a name first.'); return; }

                const roomName = ($('mpRoomName').value || '').trim() || (n + "'s World");
                const wantsPassword = $('mpRoomPrivate').checked;
                const password = wantsPassword ? ($('mpRoomPassword').value || '') : '';

                if (wantsPassword && !password) {
                    setHostStatus('Enter a password or untick the box.');
                    return;
                }

                await hostGame(n, card.dataset.hostMap, true, roomName, password);
            });
        });

        $('mpHostBack').addEventListener('click', () => {
            $('mpHostPanel').classList.add('hidden');
            $('mpNameField').classList.remove('hidden');   // <-- add this
            $('mpActions').classList.remove('hidden');
            setHostStatus('');
        });

        // ---- Join by room code ----
        const codeInput = $('mpJoinCode');
        const codeBtn = $('mpJoinCodeBtn');
        if (codeBtn) codeBtn.addEventListener('click', onJoinByCode);
        if (codeInput) {
            codeInput.addEventListener('input', (e) => {
                e.target.value = e.target.value.toUpperCase()
                    .replace(new RegExp('[^' + CODE_CHARS + ']', 'g'), '');
            });
            codeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); onJoinByCode(); }
            });
        }

        $('mpJoinBack').addEventListener('click', closeRoomList);

        $('mpPasswordConfirm').addEventListener('click', onPasswordConfirm);
        $('mpPasswordCancel').addEventListener('click', onPasswordCancel);
        $('mpJoinPassword').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onPasswordConfirm(); }
        });

        // ---- Back to previous screen ----
        $('mpBackBtn').addEventListener('click', () => {
            closeRoomList();
            $('mpScreen').classList.add('hidden');
            if (mp._hostFromGame) $('overlay').classList.remove('hidden');
            else $('mapSelect').classList.remove('hidden');
            showPicker();
        });

        // ---- Leave session from ESC overlay ----
        const overlayLeaveBtn = $('mpLeaveBtn');
        if (overlayLeaveBtn) {
            overlayLeaveBtn.addEventListener('click', () => {
                if (!confirm('Leave the multiplayer session?')) return;
                leaveGame(true);
            });
        }

        // ---- Auto-open the join panel from a legacy ?join=XXXXXX link ----
        const params = new URLSearchParams(location.search);
        const joinCode = params.get('join');
        if (joinCode) {
            try { history.replaceState({}, '', location.pathname); } catch (e) { }
            setTimeout(() => {
                $('mapSelect').classList.add('hidden');
                $('overlay').classList.add('hidden');
                $('mpScreen').classList.remove('hidden');
                openRoomList();
                // Pre-fill a password prompt if this specific room exists
                const r = currentRooms.find(x => x.roomId === joinCode.toUpperCase());
                if (r) onJoinRoomClick(r.roomId);
            }, 80);
        }

        updateSessionUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        initUI();
    }

    console.log('[MP] module ready');
})(window);