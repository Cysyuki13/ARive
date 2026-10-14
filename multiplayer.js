/* =========================================================================
   ARive — PeerJS Multiplayer
   -------------------------------------------------------------------------
   • Host picks a world on the main multiplayer screen and is dropped
     straight into it — no lobby, no waiting.
   • Clients enter a 4-char code (or use a ?join=XXXX link) and are
     dropped straight into the host's live world.
   • Syncs: world seed, carve/explosion events, dropped pickups, and
     remote player models.
   • Host relays all client traffic (authoritative hub).
   ========================================================================= */
(function (global) {
    'use strict';

    const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    const ROOM_PREFIX = 'arive-v1-';
    const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const CODE_LEN = 4;
    const STATE_SEND_HZ = 15;
    const STATE_SEND_INTERVAL = 1 / STATE_SEND_HZ;
    const REMOTE_TIMEOUT = 6000;
    const MAX_EVENT_LOG = 5000;

    const Hooks = global.ARiveHooks;
    if (!Hooks) {
        console.warn('[MP] ARiveHooks missing — multiplayer disabled. ' +
            'Make sure multiplayer.js is loaded AFTER game.js.');
        return;
    }

    /* =====================================================================
       STATE
       ===================================================================== */
    const mp = {
        peer: null,
        isHost: false,
        roomCode: '',
        myName: '',
        myId: '',
        hostId: '',
        connected: false,
        clients: new Map(),       // host: peerId -> { conn, name }
        remotePlayers: new Map(), // everyone: peerId -> rp
        eventLog: [],             // host: replay for late joiners
        _lastSendTime: 0,
        _hostConn: null,          // client: connection to host
        _hostFromGame: false,     // true → host uses the world already running
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
       REMOTE PLAYER RENDERING
       ===================================================================== */
    function makeNameTag(name) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
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
        const mat = new THREE.SpriteMaterial({
            map: tex, transparent: true, depthTest: false, depthWrite: false
        });
        const sp = new THREE.Sprite(mat);
        sp.scale.set(0.95, 0.24, 1);
        sp.position.y = 2.05;
        sp.renderOrder = 5;
        return sp;
    }

    function createRemotePlayer(id, name) {
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

        const model = Hooks.buildRemotePlayerMesh();
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
            crouchT: 0,
            targetCrouchT: 0,
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

        // Drop anything the departing player was holding.
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

    /* Attach an existing pickup mesh to a remote player's right-hand
   pivot (armR).  Physically reparents the mesh so three.js drives
   its world transform automatically as the player moves / walks. */
    function applyRemotePickupGrab(msg, senderId) {
        const rp = mp.remotePlayers.get(senderId);
        if (!rp) return;

        let pickup = null;
        for (const p of Hooks.pickups) {
            if (p.pid === msg.pid) { pickup = p; break; }
        }
        if (!pickup) return;

        rp.heldPickupPid = msg.pid;
        pickup.carriedBy = senderId;

        if (pickup.mesh.parent) pickup.mesh.parent.remove(pickup.mesh);
        // Hand-local offset: below and slightly in front of the shoulder.
        pickup.mesh.position.set(0, -0.58, -0.10);
        pickup.mesh.rotation.set(0, 0, 0);
        pickup.mesh.scale.setScalar(0.85);
        rp.model.armR.add(pickup.mesh);
    }

    /* Un-parent a pickup from a remote player's arm and drop it back
       into the world at the position / orientation / velocity that
       the releasing client told us about. */
    function applyRemotePickupRelease(msg, senderId) {
        const rp = mp.remotePlayers.get(senderId);
        if (rp) rp.heldPickupPid = null;

        let pickup = null;
        for (const p of Hooks.pickups) {
            if (p.pid === msg.pid) { pickup = p; break; }
        }
        if (!pickup) return;

        pickup.carriedBy = null;

        if (pickup.mesh.parent) pickup.mesh.parent.remove(pickup.mesh);
        pickup.mesh.scale.setScalar(1);
        pickup.mesh.position.set(
            msg.x !== undefined ? msg.x : 0,
            msg.y !== undefined ? msg.y : 0,
            msg.z !== undefined ? msg.z : 0
        );
        if (msg.qx !== undefined) {
            pickup.mesh.quaternion.set(msg.qx, msg.qy, msg.qz, msg.qw);
        } else {
            pickup.mesh.rotation.set(0, 0, 0);
        }

        pickup.vx = msg.vx || 0;
        pickup.vy = msg.vy || 0;
        pickup.vz = msg.vz || 0;
        pickup.avx = msg.avx || 0;
        pickup.avy = msg.avy || 0;
        pickup.avz = msg.avz || 0;
        pickup.settled = false;

        Hooks.scene.add(pickup.mesh);
    }

    /* =====================================================================
       REMOTE EVENT APPLICATION
       ===================================================================== */
    function applyRemoteCarve(x, y, z, rVox, ignite) {
        Hooks.carveSphere(x, y, z, rVox, { ignite: !!ignite, debrisChance: 0.08 });
    }

    function applyRemoteExplosion(x, y, z, rMeters) {
        /* The originating client already broadcast this one.  Pass
           silent=true so we don't echo it back and re-send it through
           the relay chain.  Chain reactions triggered locally (e.g. a
           barrel next to the blast) will still be sent out normally. */
        Hooks.explodeAt(x, y, z, rMeters, true);
    }

    function applyRemotePickupSpawn(msg) {
        if (!msg || !msg.def || !msg.def.meta || !msg.def.meta.model) return;
        for (const p of Hooks.pickups) if (p.pid === msg.pid) return;
        const pos = new THREE.Vector3(msg.x, msg.y, msg.z);
        const p = Hooks.spawnPickup(msg.def, pos, msg.pid);
        if (p && msg.carriedBy) {
            applyRemotePickupGrab({ pid: msg.pid }, msg.carriedBy);
        }
    }

    function applyRemotePickupRemove(pid) {
        const list = Hooks.pickups;
        for (let i = list.length - 1; i >= 0; i--) {
            const p = list[i];
            if (p.pid === pid) {
                Hooks.scene.remove(p.mesh);
                p.mesh.traverse(o => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) o.material.dispose();
                });
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
                    createRemotePlayer(msg.id, msg.name);
                }
                break;
            case 'peer-leave':
                if (!mp.isHost) {
                    mp.clients.delete(msg.id);
                    removeRemotePlayer(msg.id);
                }
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
        }
    }

    function onClientHello(clientId, msg) {
        // Build current peer list (excluding the newcomer)
        const peers = [];
        for (const [id, c] of mp.clients) {
            if (id === clientId) continue;
            peers.push({ id, name: c.name });
        }

        // Snapshot of live pickups
        const pickupSnapshots = [];
        for (const p of Hooks.pickups) {
            if (!p.pid) continue;
            if (!p.def || !p.def.meta || !p.def.meta.model) continue;
            pickupSnapshots.push({
                pid: p.pid,
                def: {
                    name: p.def.name,
                    iconImage: p.def.iconImage,
                    iconImageRotated: p.def.iconImageRotated,
                    w: p.def.w, h: p.def.h,
                    color: p.def.color,
                    meta: p.def.meta,
                },
                x: p.mesh.position.x,
                y: p.mesh.position.y,
                z: p.mesh.position.z,
                // 'local' means "the host is holding it"; convert to the
                // host's peerId so the client can find the right avatar.
                carriedBy: p.carriedBy === 'local' ? mp.myId
                    : (p.carriedBy || null),
            });
        }

        const welcome = {
            t: 'welcome',
            hostId: mp.myId,
            hostName: mp.myName,
            seed: Hooks.getCurrentSeed(),
            mapType: Hooks.getCurrentMapType(),
            peers: peers,
            pickups: pickupSnapshots,
            eventLog: mp.eventLog,
        };
        try { mp.clients.get(clientId).conn.send(welcome); } catch (e) { console.warn(e); }

        // Tell existing clients about the newcomer
        for (const [id, c] of mp.clients) {
            if (id === clientId) continue;
            try { c.conn.send({ t: 'peer-join', id: clientId, name: msg.name }); } catch (e) { }
        }

        createRemotePlayer(clientId, msg.name);
        updateSessionUI();
    }

    function onWelcome(msg) {
        mp.hostId = msg.hostId;

        // Show the loading screen while we sync-load the world.
        Hooks.showLoadingScreen();

        // Defer so the browser has a chance to paint the loading screen.
        setTimeout(function () {
            // 1. Synchronously regenerate the host's world.
            Hooks.regenerateWorld(msg.seed, msg.mapType || 'city');

            // 2. Track all other peers.
            createRemotePlayer(msg.hostId, msg.hostName);
            for (const p of (msg.peers || [])) {
                mp.clients.set(p.id, { name: p.name });
                createRemotePlayer(p.id, p.name);
            }

            // 3. Restore live pickups.
            for (const snap of (msg.pickups || [])) {
                applyRemotePickupSpawn(snap);
            }

            // 4. Replay the host's event history.
            const log = msg.eventLog || [];
            for (const ev of log) {
                if (ev.t === 'carve') applyRemoteCarve(ev.x, ev.y, ev.z, ev.r, ev.ignite);
                else if (ev.t === 'boom') applyRemoteExplosion(ev.x, ev.y, ev.z, ev.r);
                else if (ev.t === 'pickup-spawn') applyRemotePickupSpawn(ev);
                else if (ev.t === 'pickup-remove') applyRemotePickupRemove(ev.pid);
                else if (ev.t === 'pickup-move') applyRemotePickupMove(ev);
            }

            // 5. Drop into the world.
            mp.connected = true;
            updateSessionUI();
            Hooks.beginPlay();
        }, 60);
    }

    function onHostLeft() {
        Hooks.setMpBadge('HOST LEFT');
        setTimeout(function () {
            leaveGame(false);
            Hooks.stopPlaying();
            if (global.ARiveMP && global.ARiveMP.leaveGame) {
                // no-op, we already left
            }
            var mpScr = $('mpScreen');
            if (mpScr) mpScr.classList.remove('hidden');
        }, 1500);
    }

    /* =====================================================================
   REMOTE TOOL-USE ANIMATION
   Fires the same bell-curve swing the local FP rig uses, but on the
   remote player's hand.  Also corrects their tool visibility if the
   swing arrives before the next state tick does.
   ===================================================================== */
    function onRemoteToolUse(msg, senderId) {
        const rp = mp.remotePlayers.get(senderId);
        if (!rp) return;

        // Make sure the right holder is visible — a swing packet can
        // arrive just after a tool swap, before the next state packet.
        if (msg.toolId && rp.currentToolId !== msg.toolId) {
            rp.currentToolId = msg.toolId;
            if (rp.model.toolHolders) {
                for (const id in rp.model.toolHolders) {
                    rp.model.toolHolders[id].visible = (id === msg.toolId);
                }
            }
        }

        rp.toolUseAnimT = 0;   // restart the swing
    }

    function onRemoteState(msg, isFromHost) {
        let rp = mp.remotePlayers.get(msg.id);
        if (!rp) rp = createRemotePlayer(msg.id, msg.name || '?');
        rp.targetX = msg.x;
        rp.targetY = msg.y;
        rp.targetZ = msg.z;
        rp.targetYaw = msg.yaw;
        rp.moving = !!msg.moving;
        rp.sprinting = !!msg.sprinting;
        rp.targetCrouchT = (typeof msg.crouchT === 'number')
            ? msg.crouchT
            : (msg.crouching ? 1 : 0);   // fallback for older clients
        rp.lastUpdate = performance.now();

        /* Toggle the visible tool holder on the remote rig. */
        const wantTool = msg.toolId || null;
        if (rp.currentToolId !== wantTool && rp.model.toolHolders) {
            rp.currentToolId = wantTool;
            for (const id in rp.model.toolHolders) {
                rp.model.toolHolders[id].visible = (id === wantTool);
            }
        }
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
            if (mp.eventLog.length >= MAX_EVENT_LOG) {
                mp.eventLog.splice(0, MAX_EVENT_LOG >> 1);
            }
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
       LOCAL EVENT HOOKS  (called by game.js)
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
            t: 'pickup-spawn',
            pid: p.pid,
            def: {
                name: p.def.name,
                iconImage: p.def.iconImage,
                iconImageRotated: p.def.iconImageRotated,
                w: p.def.w, h: p.def.h,
                color: p.def.color,
                meta: p.def.meta,
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
            t: 'pickup-move',
            pid: p.pid,
            x: p.mesh.position.x,
            y: p.mesh.position.y,
            z: p.mesh.position.z,
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
            t: 'pickup-release',
            pid: p.pid,
            x: p.mesh.position.x,
            y: p.mesh.position.y,
            z: p.mesh.position.z,
            qx: q.x, qy: q.y, qz: q.z, qw: q.w,
            vx: p.vx, vy: p.vy, vz: p.vz,
            avx: p.avx, avy: p.avy, avz: p.avz,
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
            t: 'proj-spawn',
            projId: proj.projId,
            px: proj.pos.x,
            py: proj.pos.y,
            pz: proj.pos.z,
            vx: proj.vel.x,
            vy: proj.vel.y,
            vz: proj.vel.z,
            life: proj.life
        };
        if (mp.isHost) broadcastToClients(msg, null);
        else if (mp.connected) sendToHost(msg);
    };

    /* =====================================================================
       STATE BROADCAST
       ===================================================================== */
    function sendState() {
        if (!mp.connected) return;
        const player = Hooks.player;
        const moving = Math.hypot(player.vel.x, player.vel.z) > 0.5;
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
        };
        if (mp.isHost) broadcastToClients(msg, null);
        else sendToHost(msg);
    }

    /* =====================================================================
       HOST / JOIN
       ===================================================================== */
    async function hostGame(name, mapType, isNewWorld) {
        mp.myName = (name || 'Host').slice(0, 16);
        mapType = mapType || 'city';
        setHostStatus('Creating room…');

        let Peer;
        try { Peer = await loadPeerJS(); }
        catch (e) { setHostStatus('Could not load PeerJS.'); return; }

        for (let attempt = 0; attempt < 6; attempt++) {
            const code = genCode();
            const peerId = ROOM_PREFIX + code;
            try {
                const peer = await new Promise((resolve, reject) => {
                    const p = new Peer(peerId, { debug: 1 });
                    let settled = false;
                    p.on('open', () => { if (!settled) { settled = true; resolve(p); } });
                    p.on('error', (err) => {
                        if (!settled) { settled = true; try { p.destroy(); } catch (e) { } reject(err); }
                    });
                });

                mp.peer = peer;
                mp.isHost = true;
                mp.myId = peerId;
                mp.roomCode = code;
                mp.connected = true;
                mp.clients.clear();
                mp.eventLog.length = 0;

                peer.on('connection', onIncomingConnection);
                peer.on('error', (err) => {
                    if (err.type === 'peer-unavailable') setHostStatus('Peer unavailable.');
                });
                peer.on('disconnected', () => console.warn('[MP] signaling disconnected'));

                updateSessionUI();

                if (isNewWorld) {
                    // Host picked a map on the multiplayer screen → boot it.
                    Hooks.startPlaying(mapType);
                } else {
                    // Host was already playing → resume the running world.
                    // We deliberately do NOT call boot() here, so the host's
                    // voxel edits, dropped items, and player state survive
                    // the transition into hosting.
                    Hooks.beginPlay();
                }
                return;
            } catch (e) {
                console.warn('[MP] host attempt', attempt, 'failed:', e.type || e);
                if (attempt === 5) setHostStatus('Could not create room: ' + (e.type || e.message || 'unknown'));
            }
        }
    }

    function onIncomingConnection(conn) {
        conn.on('open', () => {
            mp.clients.set(conn.peer, { conn, name: '?' });
        });
        conn.on('data', (data) => {
            let msg = data;
            if (typeof msg === 'string') {
                try { msg = JSON.parse(msg); } catch (e) { return; }
            }
            handleHostIncoming(msg, conn);
        });
        conn.on('close', () => {
            mp.clients.delete(conn.peer);
            removeRemotePlayer(conn.peer);
            broadcastToClients({ t: 'peer-leave', id: conn.peer }, null);
            updateSessionUI();
        });
        conn.on('error', (err) => console.warn('[MP] conn error', err));
    }

    function handleHostIncoming(msg, conn) {
        if (!msg || !msg.t) return;
        const senderId = conn.peer;
        switch (msg.t) {
            case 'hello':
                mp.clients.set(senderId, { conn, name: msg.name || '?' });
                onClientHello(senderId, msg);
                break;
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
        }
    }

    async function joinGame(name, code) {
        mp.myName = (name || 'Survivor').slice(0, 16);
        code = String(code || '').toUpperCase().trim();
        if (code.length !== CODE_LEN) { setJoinStatus('Code must be 4 characters.'); return; }

        setJoinStatus('Loading PeerJS…');
        let Peer;
        try { Peer = await loadPeerJS(); }
        catch (e) { setJoinStatus('Could not load PeerJS.'); return; }

        const hostPeerId = ROOM_PREFIX + code;
        setJoinStatus('Connecting…');

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
            mp.roomCode = code;

            peer.on('error', (err) => {
                if (err.type === 'peer-unavailable') {
                    setJoinStatus('Host not found. Check the code.');
                    leaveGame(false);
                }
            });

            setJoinStatus('Connecting to host…');
            const conn = peer.connect(hostPeerId, { reliable: true });

            conn.on('open', () => {
                mp.connected = true;
                mp._hostConn = conn;
                setJoinStatus('Syncing world…');
                conn.send({ t: 'hello', name: mp.myName });
            });
            conn.on('data', (data) => {
                let msg = data;
                if (typeof msg === 'string') {
                    try { msg = JSON.parse(msg); } catch (e) { return; }
                }
                handleMessage(msg, hostPeerId, true);
            });
            conn.on('close', () => {
                if (mp.connected) { setJoinStatus('Disconnected from host.'); leaveGame(false); }
            });
            conn.on('error', (err) => { console.warn('[MP] conn err', err); setJoinStatus('Connection error.'); });

        } catch (e) {
            console.error('[MP] join failed', e);
            setJoinStatus('Could not join: ' + (e.type || e.message || 'unknown'));
        }
    }

    function leaveGame(doCleanup) {
        if (doCleanup === undefined) doCleanup = true;

        if (mp.isHost) {
            for (const [, c] of mp.clients) { try { c.conn.close(); } catch (e) { } }
            mp.clients.clear();
        } else {
            if (mp._hostConn) { try { mp._hostConn.close(); } catch (e) { } mp._hostConn = null; }
        }
        if (mp.peer) { try { mp.peer.destroy(); } catch (e) { } mp.peer = null; }

        mp.connected = false;
        mp.isHost = false;
        mp.roomCode = '';
        mp.myId = '';
        mp.eventLog.length = 0;
        clearRemotePlayers();
        Hooks.setMpBadge('');

        if (doCleanup) {
            // Return to the main map-select screen.
            Hooks.stopPlaying();
        }
        updateSessionUI();
    }
    mp.leaveGame = leaveGame;

    /* =====================================================================
       UPDATE LOOP  (called every frame from game.js)
       ===================================================================== */
    mp.update = function (dt) {
        if (!mp.connected) return;

        mp._lastSendTime += dt;
        if (mp._lastSendTime >= STATE_SEND_INTERVAL) {
            mp._lastSendTime = 0;
            sendState();
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

            /* -------- crouch squash (mirrors the local FP rig) ------------------- */
            const cTgt = rp.targetCrouchT || 0;
            if (Math.abs(rp.crouchT - cTgt) > 0.001) {
                rp.crouchT += (cTgt - rp.crouchT) * Math.min(1, dt * 12);
            } else {
                rp.crouchT = cTgt;
            }
            const crouchMul = (Hooks.CROUCH_MUL !== undefined) ? Hooks.CROUCH_MUL : 0.55;
            const bodyScaleY = 1 - (1 - crouchMul) * rp.crouchT;
            rp.group.scale.y = bodyScaleY;
            /* The name tag is a child of the group, so its sprite would get squashed
               too.  Counter-scale just the sprite so the text stays legible. */
            if (rp.tag) rp.tag.scale.y = 0.24 / bodyScaleY;

            if (now - rp.lastUpdate > REMOTE_TIMEOUT) removeRemotePlayer(id);

            /* -------- tool-use swing (mirrors updateHeldToolAnim in game.js) ---- */
            if (rp.toolUseAnimT < 1) {
                rp.toolUseAnimT = Math.min(1, rp.toolUseAnimT + dt * 5.5);
                const holder = rp.model.toolHolders &&
                    rp.model.toolHolders[rp.currentToolId];
                if (holder && holder.userData.swing !== undefined) {
                    const bell = rp.toolUseAnimT < 1
                        ? Math.sin(rp.toolUseAnimT * Math.PI)
                        : 0;
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
        // Top-left HUD badge
        if (mp.connected && mp.roomCode) {
            const count = 1 + mp.remotePlayers.size;
            Hooks.setMpBadge('ROOM ' + mp.roomCode + ' · ' + count + ' PLAYER' + (count === 1 ? '' : 'S'));
        } else {
            Hooks.setMpBadge('');
        }

        // ESC-overlay button visibility
        const overlayMpBtn = $('mpBtn');
        const overlayLeaveBtn = $('mpLeaveBtn');
        if (overlayMpBtn) overlayMpBtn.classList.toggle('hidden', !!mp.connected);
        if (overlayLeaveBtn) overlayLeaveBtn.classList.toggle('hidden', !mp.connected);
    }

    function showPicker() {
        var picker = $('mpPicker');
        if (picker) picker.classList.remove('hidden');
        $('mpActions').classList.remove('hidden');
        $('mpHostPanel').classList.add('hidden');
        $('mpJoinPanel').classList.add('hidden');
        setHostStatus('');
        setJoinStatus('');
    }

    function initUI() {
        const nameInput = $('mpName');
        if (!nameInput) return;

        try {
            const saved = localStorage.getItem('arive-name');
            if (saved) nameInput.value = saved;
        } catch (e) { }
        nameInput.addEventListener('input', () => {
            try { localStorage.setItem('arive-name', nameInput.value); } catch (e) { }
        });

        // ---- Entry from the main map-select screen ----
        const mapMpBtn = $('mapMpBtn');
        if (mapMpBtn) {
            mapMpBtn.addEventListener('click', () => {
                if (mp.connected) return;    // already in a session
                mp._hostFromGame = false;    // ← new: came from main menu
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
                mp._hostFromGame = true;     // ← new: came from in-game
                $('overlay').classList.add('hidden');
                $('mpScreen').classList.remove('hidden');
                showPicker();
                setTimeout(() => nameInput.focus(), 40);
            });
        }

        // ---- Pick host or join ----
        $('mpHostBtn').addEventListener('click', async () => {
            const n = nameInput.value.trim();
            if (!n) { setHostStatus('Enter a name first.'); nameInput.focus(); return; }

            if (mp._hostFromGame) {
                // Skip the map picker entirely — host the current world.
                await hostGame(n, Hooks.getCurrentMapType(), false);
                return;
            }

            // From the main menu: show the map picker as before.
            $('mpActions').classList.add('hidden');
            $('mpJoinPanel').classList.add('hidden');
            $('mpHostPanel').classList.remove('hidden');
            setHostStatus('');
        });

        $('mpJoinBtn').addEventListener('click', () => {
            const n = nameInput.value.trim();
            if (!n) { setJoinStatus('Enter a name first.'); nameInput.focus(); return; }
            $('mpActions').classList.add('hidden');
            $('mpHostPanel').classList.add('hidden');
            $('mpJoinPanel').classList.remove('hidden');
            setJoinStatus('');
            setTimeout(() => $('mpCode').focus(), 40);
        });

        $('mpHostBack').addEventListener('click', () => {
            $('mpHostPanel').classList.add('hidden');
            $('mpActions').classList.remove('hidden');
            setHostStatus('');
        });
        $('mpJoinBack').addEventListener('click', () => {
            $('mpJoinPanel').classList.add('hidden');
            $('mpActions').classList.remove('hidden');
            setJoinStatus('');
        });

        // ---- Pick a map to host → host immediately ----
        document.querySelectorAll('#mpScreen .map-card[data-host-map]').forEach(card => {
            card.addEventListener('click', async () => {
                const n = nameInput.value.trim();
                if (!n) { setHostStatus('Enter a name first.'); return; }
                await hostGame(n, card.dataset.hostMap, true);   // ← isNewWorld = true
            });
        });

        // ---- Join with a code ----
        $('mpJoinConfirm').addEventListener('click', async () => {
            const n = nameInput.value.trim();
            const c = $('mpCode').value.trim().toUpperCase();
            if (!n) { setJoinStatus('Enter a name first.'); return; }
            if (c.length !== CODE_LEN) { setJoinStatus('Code must be 4 characters.'); return; }
            await joinGame(n, c);
        });

        // ---- Back to previous screen from MP screen ----
        $('mpBackBtn').addEventListener('click', () => {
            $('mpScreen').classList.add('hidden');
            if (mp._hostFromGame) {
                // Came from ESC overlay → return to the pause menu.
                $('overlay').classList.remove('hidden');
            } else {
                // Came from main menu → return to map select.
                $('mapSelect').classList.remove('hidden');
            }
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

        // ---- Auto-open join panel from ?join=XXXX ----
        const params = new URLSearchParams(location.search);
        const joinCode = params.get('join');
        if (joinCode) {
            try { history.replaceState({}, '', location.pathname); } catch (e) { }
            setTimeout(() => {
                $('mapSelect').classList.add('hidden');
                $('overlay').classList.add('hidden');
                $('mpScreen').classList.remove('hidden');
                $('mpActions').classList.add('hidden');
                $('mpHostPanel').classList.add('hidden');
                $('mpJoinPanel').classList.remove('hidden');
                $('mpCode').value = joinCode.toUpperCase().slice(0, 4);
                nameInput.focus();
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