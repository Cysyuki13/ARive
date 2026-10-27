/* =========================================================================
   ARive — Avatar persistence + conversion helpers
   ========================================================================= */
(function (global) {
    'use strict';

    const LOCAL_KEY = 'arive-avatar-v1';
    const COLLECTION = 'user-avatars';

    // Matches current FP_MODEL.colors + AVATAR_MODEL_DATA.colors defaults
    const DEFAULT_AVATAR = {
        version: 1,
        colors: {
            skin: '#d4a686',
            hair: '#3a2418',
            shirt: '#3a4a30',
            pants: '#2a3a4a',
            boot: '#18181a',
            accent: '#808890',
        },
        parts: [],
    };

    function _hexToInt(h) {
        if (typeof h === 'number') return h | 0;
        return parseInt(String(h).replace(/^#/, ''), 16) | 0;
    }
    function _intToHex(n) {
        return '#' + (n >>> 0).toString(16).padStart(6, '0');
    }
    function _clone(a) { return JSON.parse(JSON.stringify(a)); }

    function normalize(av) {
        const out = _clone(DEFAULT_AVATAR);
        if (!av) return out;
        if (av.colors) {
            for (const k in out.colors) {
                if (typeof av.colors[k] === 'string') out.colors[k] = av.colors[k];
                else if (typeof av.colors[k] === 'number') out.colors[k] = _intToHex(av.colors[k]);
            }
        }
        if (Array.isArray(av.parts)) {
            out.parts = av.parts
                .filter(p => p && Array.isArray(p.s) && Array.isArray(p.p))
                .map(p => ({
                    parent: p.parent || 'torso',
                    s: [+p.s[0], +p.s[1], +p.s[2]],
                    p: [+p.p[0], +p.p[1], +p.p[2]],
                    c: typeof p.c === 'string' ? p.c : _intToHex(p.c || 0xffffff),
                    r: Array.isArray(p.r) ? [+p.r[0], +p.r[1], +p.r[2]] : undefined,
                }));
        }
        return out;
    }

    let _cached = null;
    let _db = null;

    async function _initDb() {
        if (_db) return _db;
        if (!global.firebase || !global.firebase.apps.length) return null;
        if (!global.firebase.firestore) {
            await new Promise((res, rej) => {
                const el = document.createElement('script');
                el.src = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js';
                el.onload = res; el.onerror = () => rej(new Error('firestore load'));
                document.head.appendChild(el);
            });
        }
        _db = global.firebase.firestore();
        return _db;
    }

    function loadLocal() {
        try { return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')); }
        catch (e) { return _clone(DEFAULT_AVATAR); }
    }
    function saveLocal(av) {
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify(normalize(av))); } catch (e) { }
    }

    async function loadCloud() {
        await (global.ARiveAuth && global.ARiveAuth.waitForReady ? global.ARiveAuth.waitForReady() : Promise.resolve());
        const user = global.firebase && global.firebase.auth && global.firebase.auth().currentUser;
        if (!user) return null;
        try {
            const db = await _initDb();
            if (!db) return null;
            const doc = await db.collection(COLLECTION).doc(user.uid).get();
            return doc.exists ? normalize(doc.data()) : null;
        } catch (e) {
            console.warn('[Avatar] cloud load failed:', e && e.message);
            return null;
        }
    }

    async function saveCloud(av) {
        await (global.ARiveAuth && global.ARiveAuth.waitForReady ? global.ARiveAuth.waitForReady() : Promise.resolve());
        const user = global.firebase && global.firebase.auth && global.firebase.auth().currentUser;
        if (!user) throw new Error('not signed in');
        const db = await _initDb();
        if (!db) throw new Error('firestore unavailable');
        await db.collection(COLLECTION).doc(user.uid).set(normalize(av));
    }

    // Cloud-first if signed in (non-anonymous), then local.
    async function load() {
        if (_cached) return _cached;
        const signedIn = global.ARiveAuth && global.ARiveAuth.isSignedIn && global.ARiveAuth.isSignedIn();
        if (signedIn) {
            const cloud = await loadCloud();
            if (cloud) {
                saveLocal(cloud);
                _cached = cloud;
                return cloud;
            }
        }
        _cached = loadLocal();
        return _cached;
    }

    async function save(av) {
        saveLocal(av);
        _cached = normalize(av);
        const signedIn = global.ARiveAuth && global.ARiveAuth.isSignedIn && global.ARiveAuth.isSignedIn();
        if (signedIn) {
            try { await saveCloud(av); return 'cloud'; }
            catch (e) { console.warn('[Avatar] cloud save failed, kept local:', e && e.message); }
        }
        return 'local';
    }

    // Conversion for buildRemotePlayerMesh — returns AVATAR_MODEL_DATA shape
    function toRemoteModelData(av) {
        const a = normalize(av);
        const base = global.AVATAR_MODEL_DATA || {};
        return Object.assign({}, base, {
            colors: {
                skin: _hexToInt(a.colors.skin),
                hair: _hexToInt(a.colors.hair),
                shirt: _hexToInt(a.colors.shirt),
                pants: _hexToInt(a.colors.pants),
                boot: _hexToInt(a.colors.boot),
                accent: _hexToInt(a.colors.accent),
            },
            parts: a.parts.map(p => ({
                parent: p.parent,
                s: p.s,
                p: p.p,
                c: _hexToInt(p.c),
                r: p.r,
            })),
        });
    }

    // Conversion for FPV — FPV materials only use skin/pants/boot/sleeve(=shirt)
    function toFpvModelData(av) {
        const a = normalize(av);
        const base = global.PLAYER_MODEL_DATA || {};
        return Object.assign({}, base, {
            colors: Object.assign({}, base.colors, {
                skin: _hexToInt(a.colors.skin),
                pants: _hexToInt(a.colors.pants),
                boot: _hexToInt(a.colors.boot),
                sleeve: _hexToInt(a.colors.shirt),
            }),
        });
    }

    global.ARiveAvatar = {
        DEFAULT: DEFAULT_AVATAR,
        normalize, load, save, loadLocal, saveLocal, loadCloud, saveCloud,
        toRemoteModelData, toFpvModelData,
        getDefault: () => _clone(DEFAULT_AVATAR),
    };
})(window);