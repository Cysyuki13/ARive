/* =========================================================================
   ARive — Weapon Model Loader
   -------------------------------------------------------------------------
   Fetches every JSON file listed in assets/model/weaponModel/index.js
   and merges them into window.WEAPON_MODEL_DATA (array, same shape the
   old monolithic file used to define).

   Loaded by index.html BEFORE game.js.  Game.js awaits
   window.loadWeaponsFromFolder() during boot() so weapons.js init()
   sees a populated array.

   To add a weapon:  export it from weaponEditor.html, drop the .json
   file into assets/model/weaponModel/, and add its filename to
   assets/model/weaponModel/index.js.
   ========================================================================= */
(function () {
    'use strict';

    const BASE = 'assets/model/weaponModel/';

    /* Ammo registry — kept here for backwards compatibility with the
       old weaponModel.js.  Same values as before. */
    window.AMMO_TYPES = Object.assign(
        { '9mm': { name: '9mm', color: '#e8c86a', max: 300, icon: '•' } },
        window.AMMO_TYPES || {}
    );

    /* Empty until the loader runs.  weapons.js reads this after
       game.js's boot() has awaited loadWeaponsFromFolder(). */
    window.WEAPON_MODEL_DATA = window.WEAPON_MODEL_DATA || [];

    function normalise(def) {
        if (!def || !def.key) return null;

        if (!Array.isArray(def.model)) def.model = [];
        if (!def.anim) def.anim = { swing: 0.10, kick: 0.04 };
        if (typeof def.anim.swing !== 'number') def.anim.swing = 0.10;
        if (typeof def.anim.kick !== 'number') def.anim.kick = 0.04;

        if (!def.hipPose) def.hipPose = { p: [0.14, -0.16, -0.24], r: [0.10, 0.20, -0.04] };
        if (!def.hipPose.p) def.hipPose.p = [0.14, -0.16, -0.24];
        if (!def.hipPose.r) def.hipPose.r = [0.10, 0.20, -0.04];

        if (!def.gripR) def.gripR = { p: [0, -0.03, 0.02], r: [0.10, 0, 0] };
        if (!def.gripL) def.gripL = { p: [-0.035, -0.03, -0.01], r: [0.10, 0.20, 0.15] };

        if (!def.sightLocal) def.sightLocal = [0, 0.078, -0.10];
        if (!def.muzzleLocal) def.muzzleLocal = [0, 0.055, -0.30];

        if (!def.shoulderL) def.shoulderL = [-0.18, -0.06, 0.04];
        if (!def.shoulderR) def.shoulderR = [0.18, -0.06, 0.04];

        if (typeof def.adsAuto !== 'boolean') def.adsAuto = !def.adsPose;
        if (def.adsAuto && !def.adsPose) def.adsPose = null;

        if (typeof def.magSize !== 'number') def.magSize = 12;
        if (typeof def.fireRate !== 'number') def.fireRate = 0.2;
        if (typeof def.reloadTime !== 'number') def.reloadTime = 1.5;
        if (typeof def.damage !== 'number') def.damage = 20;
        if (typeof def.spread !== 'number') def.spread = 0.01;
        if (typeof def.recoilKick !== 'number') def.recoilKick = 0.025;
        if (typeof def.scopeFov !== 'number') def.scopeFov = 60;
        if (typeof def.scopeSens !== 'number') def.scopeSens = 0.7;
        if (typeof def.bulletSpeed !== 'number') def.bulletSpeed = 130;
        if (typeof def.bulletSize !== 'number') def.bulletSize = 0.034;
        if (typeof def.bulletColor !== 'number') def.bulletColor = 0xffd8a0;
        if (typeof def.auto !== 'boolean') def.auto = false;
        if (typeof def.ammoType !== 'string') def.ammoType = '9mm';

        return def;
    }

    window.loadWeaponsFromFolder = async function () {
        const names = window.ARIVE_WEAPON_FILES || [];

        if (!names.length) {
            console.warn('[ARive] No weapon files listed — ' +
                'add filenames to assets/model/weaponModel/index.js');
            return [];
        }

        console.log('[ARive] Loading ' + names.length +
            ' weapon file(s): ' + names.join(', '));

        const loaded = await Promise.all(names.map(async (name) => {
            try {
                const r = await fetch(BASE + name, { cache: 'no-cache' });
                if (!r.ok) {
                    console.warn('[ARive] ✗ weapon', name, r.status);
                    return null;
                }
                return await r.json();
            } catch (e) {
                console.warn('[ARive] ✗ weapon', name, e.message);
                return null;
            }
        }));

        const out = [];
        for (const raw of loaded) {
            const def = normalise(raw);
            if (!def) continue;
            out.push(def);
            console.log('[ARive] ✓ weapon', def.key,
                '(' + def.model.length + ' parts)');
        }

        window.WEAPON_MODEL_DATA = out;
        console.log('[ARive] Loaded ' + out.length + ' weapon(s)');
        return out;
    };
})();