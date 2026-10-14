/* =========================================================================
   ARive — Weapon Sound Table
   ------------------------------------------------------------------------
    Data-only companion to weapons.js.  Load this BEFORE weapons.js:

       <script src="weaponSound.js"></script>
       <script src="weapons.js"></script>

   Shape:
     window.WEAPON_SOUNDS[<weapon key>][<event>] = {
         url:    'assets/sounds/...',
         volume: 0..1,
         loop:   true | false          // only meaningful for `fire`
     };

   Events understood by weapons.js:
     fire    One-shot per trigger pull.  If `loop: true`, the file is
             treated as a sustained-fire sample: it starts once when the
             trigger goes down (and ammo remains) and stops on
             trigger-up / reload / weapon switch / mag-empty.
     empty   Dry-trigger click.  Throttled so spam-clicking a dry mag
             can't machine-gun the sample.
     reload  Played once when a reload starts.

   Any weapon whose `key` is missing from this table just plays
   silently — it will not crash.
   ========================================================================= */
(function () {
    'use strict';

    window.WEAPON_SOUNDS = {
        pistol: {
            fire: { url: 'assets/sounds/pistol_fire.mp3', volume: 0.55 },
            empty: { url: 'assets/sounds/gun_empty.mp3', volume: 0.45 },
            reload: { url: 'assets/sounds/pistol_reload.mp3', volume: 0.50 }
        },
        smg: {
            fire: { url: 'assets/sounds/smg_loop.mp3', volume: 0.40, loop: true },
            empty: { url: 'assets/sounds/gun_empty.mp3', volume: 0.45 },
            reload: { url: 'assets/sounds/smg_reload.mp3', volume: 0.50 }
        },

        /* ---- Rifles — every weapon with weaponType:"rifle" routes here ----
           One-shot per shot.  Auto rifles retrigger this sample every
           fireRate seconds (M4: 0.09 s ≈ 11 rounds/s), giving a natural
           rapid-fire cadence from a single recording. */
        rifle: {
            fire: { url: 'assets/sounds/rifle_fire.mp3', volume: 0.45 },
            empty: { url: 'assets/sounds/gun_empty.mp3', volume: 0.45 },
            reload: { url: 'assets/sounds/rifle_reload.mp3', volume: 0.55 }
        },

        shotgun: {
            fire: { url: 'assets/sounds/shotgun_fire.mp3', volume: 0.65 },
            empty: { url: 'assets/sounds/gun_empty.mp3', volume: 0.45 },
            reload: { url: 'assets/sounds/shotgun_relaod.mp3', volume: 0.55 }
        },
        sniper: {
            fire: { url: 'assets/sounds/sniper_fire.mp3', volume: 0.70 },
            empty: { url: 'assets/sounds/gun_empty.mp3', volume: 0.45 },
            reload: { url: 'assets/sounds/sniper_reload.mp3', volume: 0.55 }
        }
    };
})();