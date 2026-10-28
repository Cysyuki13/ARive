/* =========================================================================
   ARive — Avatar persistence + conversion helpers
   ========================================================================= */
(function (global) {
    'use strict';

    const LOCAL_KEY = 'arive-avatar-v1';
    const COLLECTION = 'user-avatars';

    /* Per-part size modifiers. Max increased to 2.5 */
    const SCALE_KEYS = ['head', 'torso', 'hip', 'armL', 'armR', 'legL', 'legR'];
    const SCALE_MIN = 0.5;
    const SCALE_MAX = 2.5;

    function _clampScale(v) {
        const n = +v;
        if (!isFinite(n)) return 1;
        return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
    }

    function _normScaleObj(v) {
        if (typeof v === 'number') {
            const c = _clampScale(v);
            return { x: c, y: c, z: c };
        }
        if (Array.isArray(v)) {
            return { x: _clampScale(v[0]), y: _clampScale(v[1]), z: _clampScale(v[2]) };
        }
        if (v && typeof v === 'object') {
            return {
                x: _clampScale(v.x),
                y: _clampScale(v.y),
                z: _clampScale(v.z),
            };
        }
        return { x: 1, y: 1, z: 1 };
    }

    function _defaultScales() {
        const s = {};
        for (let i = 0; i < SCALE_KEYS.length; i++) s[SCALE_KEYS[i]] = { x: 1, y: 1, z: 1 };
        return s;
    }

    const DEFAULT_AVATAR = {
        version: 4,
        colors: {
            skin: '#d4a686',
            hair: '#3a2418',
            shirt: '#3a4a30',
            pants: '#2a3a4a',
            boot: '#18181a',
            accent: '#808890',
        },
        scales: _defaultScales(),
        hairStyle: 'default',
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

        if (typeof av.hairStyle === 'string') {
            out.hairStyle = av.hairStyle;
        }

        if (av.scales && typeof av.scales === 'object') {
            for (let i = 0; i < SCALE_KEYS.length; i++) {
                const k = SCALE_KEYS[i];
                if (av.scales[k] !== undefined && av.scales[k] !== null) {
                    out.scales[k] = _normScaleObj(av.scales[k]);
                }
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

    function toRemoteModelData(av) {
        const a = normalize(av);
        const base = global.AVATAR_MODEL_DATA || {};
        const scalesOut = {};
        for (let i = 0; i < SCALE_KEYS.length; i++) {
            const k = SCALE_KEYS[i];
            scalesOut[k] = { x: a.scales[k].x, y: a.scales[k].y, z: a.scales[k].z };
        }
        return Object.assign({}, base, {
            colors: {
                skin: _hexToInt(a.colors.skin),
                hair: _hexToInt(a.colors.hair),
                shirt: _hexToInt(a.colors.shirt),
                pants: _hexToInt(a.colors.pants),
                boot: _hexToInt(a.colors.boot),
                accent: _hexToInt(a.colors.accent),
            },
            scales: scalesOut,
            hairStyle: a.hairStyle,
            parts: a.parts.map(p => ({
                parent: p.parent,
                s: p.s,
                p: p.p,
                c: _hexToInt(p.c),
                r: p.r,
            })),
        });
    }

    function toFpvModelData(av) {
        const a = normalize(av);
        const base = global.PLAYER_MODEL_DATA || {};
        const scalesOut = {};
        for (let i = 0; i < SCALE_KEYS.length; i++) {
            const k = SCALE_KEYS[i];
            scalesOut[k] = { x: a.scales[k].x, y: a.scales[k].y, z: a.scales[k].z };
        }
        return Object.assign({}, base, {
            colors: Object.assign({}, base.colors, {
                skin: _hexToInt(a.colors.skin),
                pants: _hexToInt(a.colors.pants),
                boot: _hexToInt(a.colors.boot),
                sleeve: _hexToInt(a.colors.shirt),
            }),
            scales: scalesOut,
            hairStyle: a.hairStyle,
        });
    }

    global.ARiveAvatar = {
        DEFAULT: DEFAULT_AVATAR,
        SCALE_KEYS, SCALE_MIN, SCALE_MAX,
        normalize, load, save, loadLocal, saveLocal, loadCloud, saveCloud,
        toRemoteModelData, toFpvModelData,
        getDefault: () => _clone(DEFAULT_AVATAR),
    };
})(window);