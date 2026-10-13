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
    const COLLECTION    = 'arive-rooms';
    const STALE_MS      = 45000;   // room disappears from the list after this long with no heartbeat

    let db = null;
    let initPromise = null;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[src="' + src + '"]');
            if (existing && existing.dataset.ariveLoaded === '1') return resolve();
            const el = existing || document.createElement('script');
            el.src = src;
            el.async = false;
            el.addEventListener('load',  () => { el.dataset.ariveLoaded = '1'; resolve(); });
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
            roomId:        room.roomId,
            hostPeerId:    room.hostPeerId,
            hostUid:       user ? user.uid : null,
            hostName:      room.hostName,
            roomName:      room.roomName || ((room.hostName || 'Survivor') + "'s World"),
            mapType:       room.mapType || 'city',
            hasPassword:   !!room.hasPassword,
            maxPlayers:    room.maxPlayers || 8,
            playerCount:   1,
            createdAt:     Date.now(),
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
        try { await db.collection(COLLECTION).doc(roomId).delete(); } catch (e) {}
    }

    function subscribeRooms(callback) {
        let unsub = null;
        init().then(() => {
            unsub = db.collection(COLLECTION).onSnapshot((snap) => {
                const now = Date.now();
                const rooms = [];
                snap.forEach((doc) => {
                    const r = doc.data();
                    if (!r) return;
                    if (now - (r.lastHeartbeat || 0) > STALE_MS) return; // stale
                    rooms.push(r);
                });
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
            if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        };
    }

    global.ARiveRooms = {
        init, isReady,
        createRoom, updateHeartbeat, deleteRoom, subscribeRooms,
        hashPassword, genNonce,
        STALE_MS,
    };
})(window);