/* =========================================================================
   ARive — Weapon Skin System
   ------------------------------------------------------------------------
   A skin keeps every gameplay field of its base weapon (damage, fire
   rate, mag size, grip poses, anim curves, ammo type) and only swaps:

     · model         ← from a source JSON file, or an inline fallback
     · muzzleLocal   ← same
     · sightLocal    ← same
     · color / icon  for the HUD bar and inventory tiles

   Skins declare their 3D data by pointing at ANOTHER weapon JSON file:

       { id: "connore", name: "M4 CONNORE", sourceKey: "m4_connore" }

   At boot, bindSkinSources(WEAPON_MODEL_DATA) links each skin's
   `sourceKey` to the def that the folder loader produced, so
   applySkin() reads the real model / muzzle / sight from the file.

   Public API
   ----------
     WeaponSkins.getSkins(key)              → [skin, ...]
     WeaponSkins.getSkin(key, id)           → skin
     WeaponSkins.randomSkin(key)            → skin
     WeaponSkins.applySkin(baseDef, id)     → cached derived def
     WeaponSkins.bindSkinSources(defs)      → call once at boot
     WeaponSkins.isSkinSource(key)          → true if `key` is only a source
   ========================================================================= */
(function () {
    "use strict";

    /* -----------------------------------------------------------------
       Palette — retained so the inline fallback below stays readable,
       and so future skins can hardcode a colour if they need one.
       ----------------------------------------------------------------- */
    const PALETTE = {
        black: 0x0a0a0c,
        gunmetal: 0x1a1a1c,
        darkGrey: 0x25252a,
        midGrey: 0x2a2a2e,
        grey: 0x303035,
        lightGrey: 0x404044,

        redDark: 0x6a1010,
        red: 0x8a1a1a,
        redBright: 0xa02020,
        redVivid: 0xc02020,

        white: 0xd0d0d0,
        offwhite: 0xb8b8b4,
    };

    /* =====================================================================
       INLINE FALLBACK MODEL — M4 CONNORE
       ---------------------------------------------------------------------
       Only used if `assets/model/weaponModel/m4_connore.json` fails to
       load at boot.  Matches the JSON exactly, so the gun looks identical
       either way.  You can delete this array once you're confident the
       folder loader is working — the skin will still find the model via
       `sourceKey`.
       ===================================================================== */
    const M4_CONNORE_FALLBACK = [
        { p: [0, 0.052, -0.62], s: [0.042, 0.042, 0.24], c: 1710620 },
        { p: [0, 0.052, -0.51], s: [0.046, 0.046, 0.02], c: 9040928 },
        { p: [0.02, 0.062, -0.60], s: [0.018, 0.018, 0.05], c: 13684944 },
        { p: [0, 0.052, -0.75], s: [0.048, 0.048, 0.018], c: 657930 },
        { p: [0, 0.052, -0.49], s: [0.048, 0.048, 0.014], c: 657930 },
        { p: [0, 0.052, -0.46], s: [0.024, 0.024, 0.08], c: 657930 },
        { p: [0, 0.052, -0.28], s: [0.064, 0.062, 0.28], c: 2763310 },
        { p: [0, 0.08, -0.22], s: [0.05, 0.014, 0.12], c: 9040928 },
        { p: [0.028, 0.05, -0.32], s: [0.012, 0.04, 0.09], c: 9040928 },
        { p: [-0.022, 0.06, -0.35], s: [0.02, 0.03, 0.05], c: 13684944 },
        { p: [0, 0.088, -0.28], s: [0.042, 0.012, 0.28], c: 1710620 },
        { p: [0, 0.096, -0.28], s: [0.032, 0.006, 0.26], c: 657930 },
        { p: [0, 0.035, -0.18], s: [0.05, 0.014, 0.055], c: 1710620 },
        { p: [0, -0.008, -0.16], s: [0.04, 0.075, 0.055], c: 1710620, r: [-0.35, 0, 0] },
        { p: [0, 0.055, 0.02], s: [0.058, 0.062, 0.32], c: 2763310 },
        { p: [0.028, 0.07, 0.06], s: [0.012, 0.03, 0.10], c: 9040928 },
        { p: [-0.028, 0.06, -0.02], s: [0.01, 0.04, 0.08], c: 9040928 },
        { p: [0.02, 0.082, -0.06], s: [0.014, 0.02, 0.04], c: 13684944 },
        { p: [0, 0.09, 0.02], s: [0.038, 0.01, 0.30], c: 1710620 },
        { p: [0, 0.098, 0.02], s: [0.028, 0.006, 0.28], c: 657930 },
        { p: [0, 0.115, 0.08], s: [0.022, 0.038, 0.02], c: 1710620 },
        { p: [0.042, 0.078, -0.10], s: [0.018, 0.016, 0.06], c: 10567968 },
        { p: [0, 0.008, 0.08], s: [0.052, 0.075, 0.22], c: 2894892 },
        { p: [0.032, 0.018, 0.12], s: [0.012, 0.016, 0.016], c: 10567968 },
        { p: [0, -0.028, 0.16], s: [0.024, 0.04, 0.055], c: 10567968 },
        { p: [0, -0.018, 0.14], s: [0.008, 0.024, 0.008], c: 657930 },
        { p: [0, -0.05, 0.08], s: [0.03, 0.05, 0.09], c: 1710620 },
        { p: [0, -0.088, 0.10], s: [0.03, 0.05, 0.09], c: 1710620, r: [-0.18, 0, 0] },
        { p: [0, -0.124, 0.125], s: [0.03, 0.04, 0.09], c: 1710620, r: [-0.35, 0, 0] },
        { p: [0, -0.152, 0.148], s: [0.034, 0.01, 0.098], c: 9040928, r: [-0.35, 0, 0] },
        { p: [0, -0.09, 0.17], s: [0.04, 0.13, 0.058], c: 1710620, r: [0.18, 0, 0] },
        { p: [0, -0.10, 0.175], s: [0.042, 0.1, 0.015], c: 2894892, r: [0.18, 0, 0] },
        { p: [0, 0.04, 0.30], s: [0.042, 0.042, 0.14], c: 1710620 },
        { p: [0, 0.06, 0.45], s: [0.04, 0.016, 0.22], c: 3026490 },
        { p: [0, 0.00, 0.45], s: [0.04, 0.016, 0.22], c: 3026490 },
        { p: [0, 0.03, 0.55], s: [0.042, 0.085, 0.02], c: 3026490 },
        { p: [0.022, 0.062, 0.42], s: [0.01, 0.014, 0.08], c: 9040928 },
        { p: [0, 0.03, 0.563], s: [0.044, 0.09, 0.01], c: 9040928 },
    ];

    /* =====================================================================
       SKIN TABLE
       ---------------------------------------------------------------------
       `sourceKey` names a weapon JSON file (its `key` field) that the
       folder loader has already produced.  At boot, bindSkinSources()
       links that name to the actual def, so applySkin() reads the real
       model / muzzleLocal / sightLocal from the file.
       ===================================================================== */
    const SKINS = {
        m4: [
            {
                id: "default",
                name: "M4 CARBINE",
                icon: "≡",
                color: "#404044",
                /* no source, no model → uses the base M4's own model */
            },
            {
                id: "connore",
                name: "M4 CONNORE",
                icon: "≡",
                color: "#8a2020",
                sourceKey: "m4_connore",
                /* Inline fallback — only used if m4_connore.json fails to load. */
                model: M4_CONNORE_FALLBACK,
                muzzleLocal: [0, 0.052, -0.76],
                sightLocal: [0, 0.135, 0.06],
            },
        ],
    };

    /* =====================================================================
       PUBLIC API
       ===================================================================== */
    const _skinCache = new Map();

    function getSkins(key) {
        return (SKINS[key] || []).slice();
    }

    function getSkin(key, id) {
        const list = SKINS[key];
        if (!list || !list.length) return null;
        if (!id) return list[0];
        return list.find((s) => s.id === id) || null;
    }

    function randomSkin(key) {
        const list = SKINS[key];
        if (!list || !list.length) return null;
        return list[(Math.random() * list.length) | 0];
    }

    /* Called once from game.js right after loadWeaponsFromFolder()
       resolves.  Links each skin's `sourceKey` to the loaded weapon def
       so applySkin() can read the model from the JSON file. */
    function bindSkinSources(weaponDefs) {
        if (!Array.isArray(weaponDefs)) return;
        let bound = 0;
        for (const baseKey in SKINS) {
            for (const skin of SKINS[baseKey]) {
                if (!skin.sourceKey) continue;
                const src = weaponDefs.find((d) => d && d.key === skin.sourceKey);
                if (src) {
                    skin._source = src;
                    bound++;
                } else {
                    console.warn(
                        "[WeaponSkins] source def not loaded: " + skin.sourceKey +
                        " — falling back to inline model for skin '" + skin.id + "'",
                    );
                }
            }
        }
        if (bound > 0) {
            console.log("[WeaponSkins] bound " + bound + " skin source(s)");
        }
    }

    /* True if `key` is referenced by any skin's `sourceKey`.  Weapons
       that answer true are meant to be skins, not standalone spawns —
       game.js uses this to hide them from the dev panel. */
    function isSkinSource(key) {
        for (const baseKey in SKINS) {
            for (const skin of SKINS[baseKey]) {
                if (skin.sourceKey === key) return true;
            }
        }
        return false;
    }

    /* Derive a def whose `model` is the skin's model.  Cached, so the
       thumbnail rendered at boot stays attached to the same object that
       comes back from every later call. */
    function applySkin(baseDef, skinId) {
        if (!baseDef || !baseDef.key) return baseDef;

        const skin = getSkin(baseDef.key, skinId);
        if (!skin) return baseDef;

        /* Resolve to the original (unskinned) def. */
        const base = baseDef._baseDef || baseDef;
        const cacheKey = base.key + "|" + skin.id;
        if (_skinCache.has(cacheKey)) return _skinCache.get(cacheKey);

        const src = skin._source || null;

        const out = Object.assign({}, base, {
            model: src ? src.model : (skin.model || base.model),
            muzzleLocal: src ? src.muzzleLocal : (skin.muzzleLocal || base.muzzleLocal),
            sightLocal: src ? src.sightLocal : (skin.sightLocal || base.sightLocal),

            /* Scope behaviour follows the skin's SOURCE weapon, not the
               base it's replacing.  A scopeless skin (M4 CONNORE) must
               not inherit the base weapon's sniper flag / scope FOV, or
               it'll try to draw a lens for a gun with no optic tube. */
            scopeMode: src && src.scopeMode !== undefined
                ? src.scopeMode
                : base.scopeMode,
            scopeFov: src && src.scopeFov !== undefined
                ? src.scopeFov
                : base.scopeFov,
            hasScope: src && src.hasScope !== undefined
                ? src.hasScope
                : base.hasScope,
            hideWeaponOnAds: src && src.hideWeaponOnAds !== undefined
                ? src.hideWeaponOnAds
                : base.hideWeaponOnAds,
            hideScopeOnAds: src && src.hideScopeOnAds !== undefined
                ? src.hideScopeOnAds
                : base.hideScopeOnAds,
            inlineLensLocal: src && src.inlineLensLocal !== undefined
                ? src.inlineLensLocal
                : base.inlineLensLocal,

            color: skin.color || base.color,
            icon: skin.icon || base.icon,
            skinId: skin.id,
            skinName: skin.name || base.name,
            _baseDef: base,
        });

        _skinCache.set(cacheKey, out);
        return out;
    }

    window.WeaponSkins = {
        SKINS,
        PALETTE,
        getSkins,
        getSkin,
        randomSkin,
        applySkin,
        bindSkinSources,
        isSkinSource,
    };
})();