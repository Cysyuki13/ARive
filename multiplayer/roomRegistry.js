/* =========================================================================
   ARive — Room Registry (Firestore-backed room discovery)
   -------------------------------------------------------------------------
   Tiny wrapper around Cloud Firestore that stores one document per live
   room.  Used only to advertise rooms and let clients browse / click-to-join.
   All actual gameplay traffic still flows P2P over PeerJS — Firestore never
   sees game state.

   Exposes window.ARiveRooms:
       init()                       — load SDK + return firestore instance
       createRoom({...})            — write a room doc
       updateHeartbeat(roomId, p)   — bump lastHeartbeat (and playerCount)
       deleteRoom(roomId)           — remove a room doc
       subscribeRooms(cb)           — realtime room list, returns unsub fn
       hashPassword(pw, nonce)      — SHA-256 hex, used for challenge/response
       genNonce()                   — random 16-byte hex nonce
   ========================================================================= */
(function (global) {
    'use strict';

    const FIRESTORE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js';
    const COLLECTION = 'arive-rooms';
    const STALE_MS = 45000;   // room disappears from the list after this long with no heartbeat

    let db = null;
    let initPromise = null;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[src="' + src + '"]');
            if (existing && existing.dataset.ariveLoaded === '1') return resolve();
            const el = existing || document.createElement('script');
            el.src = src;
            el.async = false;
            el.addEventListener('load', () => { el.dataset.ariveLoaded = '1'; resolve(); });
            el.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
            if (!existing) document.head.appendChild(el);
        });
    }

    function init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            await global.ARiveAuth.waitForReady();
            if (!global.firebase || !global.firebase.apps.length) {
                throw new Error('[Rooms] Firebase not initialised');
            }
            if (!global.firebase.firestore) {
                await loadScript(FIRESTORE_SDK);
            }
            db = global.firebase.firestore();
            return db;
        })();
        return initPromise;
    }

    function isReady() { return !!db; }

    async function sha256Hex(text) {
        const data = new TextEncoder().encode(text);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // Per-connection password proof.  The nonce is random per join,
    // so a proof observed on one connection is useless on another.
    function hashPassword(password, nonce) {
        if (!password) return Promise.resolve('');
        return sha256Hex('arive-pw:' + nonce + ':' + password);
    }

    function genNonce() {
        const buf = new Uint8Array(16);
        (global.crypto || window.crypto).getRandomValues(buf);
        return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function createRoom(room) {
        await init();
        const user = global.firebase.auth().currentUser;
        const doc = {
            roomId: room.roomId,
            hostPeerId: room.hostPeerId,
            hostUid: user ? user.uid : null,
            hostName: room.hostName,
            roomName: room.roomName || ((room.hostName || 'Survivor') + "'s World"),
            mapType: room.mapType || 'city',
            hasPassword: !!room.hasPassword,
            maxPlayers: room.maxPlayers || 8,
            playerCount: 1,
            createdAt: Date.now(),
            lastHeartbeat: Date.now(),
        };
        await db.collection(COLLECTION).doc(room.roomId).set(doc);
        return doc;
    }

    async function updateHeartbeat(roomId, patch) {
        if (!db || !roomId) return;
        const body = Object.assign({ lastHeartbeat: Date.now() }, patch || {});
        try { await db.collection(COLLECTION).doc(roomId).update(body); }
        catch (e) { /* room may already be gone — that's fine */ }
    }

    async function deleteRoom(roomId) {
        if (!db || !roomId) return;
        try { await db.collection(COLLECTION).doc(roomId).delete(); } catch (e) { }
    }

    function subscribeRooms(callback) {
        let unsub = null;
        // ✅ 放到回调外部：整轮订阅期间只创建一次，才能在快照之间留存记录
        const deletionAttempts = new Map();
        const DELETION_RETRY_COOLDOWN = 30000;

        init().then(() => {
            unsub = db.collection(COLLECTION).onSnapshot((snap) => {
                const now = Date.now();
                const rooms = [];
                const presentStale = new Set(); // 用于回收已消失房间的尝试记录

                snap.forEach((doc) => {
                    const r = doc.data();
                    if (!r) return;

                    const isStale = now - (r.lastHeartbeat || 0) > STALE_MS;

                    if (isStale) {
                        presentStale.add(doc.id);

                        const lastAttempt = deletionAttempts.get(doc.id) || 0;
                        if (now - lastAttempt < DELETION_RETRY_COOLDOWN) {
                            return; // 冷却期内，跳过
                        }

                        deletionAttempts.set(doc.id, now);

                        doc.ref.delete()
                            .then(() => {
                                // 删除成功后从 Map 移除；下一轮快照里该文档已不存在
                                deletionAttempts.delete(doc.id);
                            })
                            .catch((e) => {
                                const code = e.code || '';
                                if (code !== 'permission-denied' && code !== 'not-found') {
                                    console.warn('[Rooms] Failed to delete stale room:', doc.id, e.message);
                                }
                                // permission-denied 静默处理，等冷却期结束再试
                            });
                        return;
                    }

                    rooms.push(r);
                });

                // 🧹 回收：本次快照中已经不存在的陈旧房间，清掉其尝试记录，避免 Map 无限增长
                for (const id of deletionAttempts.keys()) {
                    if (!presentStale.has(id)) deletionAttempts.delete(id);
                }

                rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                callback(rooms);
            }, (err) => {
                console.warn('[Rooms] snapshot error:', err);
                callback([]);
            });
        }).catch((e) => {
            console.warn('[Rooms] init failed:', e);
            callback([]);
        });

        return function unsubscribe() {
            if (unsub) { try { unsub(); } catch (e) { } unsub = null; }
        };
    }

    global.ARiveRooms = {
        init, isReady,
        createRoom, updateHeartbeat, deleteRoom, subscribeRooms,
        hashPassword, genNonce,
        STALE_MS,
    };
})(window);