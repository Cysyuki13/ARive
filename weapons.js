/* =========================================================================
   ARive — Weapons System
   ------------------------------------------------------------------------
   Guns live OUTSIDE the tool hotbar.  Two weapon slots, keys 1 / 2.
   Tools move to keys 3–7.

   Controls (only when a weapon slot is active):
     LMB          fire   (auto weapons: hold to fire)
     RMB (hold)   scope  (FOV + sensitivity + pose change)
     R            reload
     1 / 2        select weapon slot
     3 – 7        select tool  (weapon slot is deactivated)

   Exposes window.Weapons. Uses window.ARiveHooks lazily.
   ========================================================================= */
(function () {
    'use strict';

    function H() { return window.ARiveHooks || {}; }

    /* Smooth interpolation for animation keyframes.
   Returns 0 below `a`, 1 above `b`, smooth S-curve between. */
    function smoothstep(t, a, b) {
        if (t <= a) return 0;
        if (t >= b) return 1;
        const u = (t - a) / (b - a);
        return u * u * (3 - 2 * u);
    }

    /* =====================================================================
   SFX — minimal Web Audio wrapper
   ---------------------------------------------------------------------
   • Lazy AudioContext creation (respects browser autoplay policy)
   • Preloads buffers via fetch + decodeAudioData
   • Buffers are keyed by URL, so two guns sharing the same file
     (e.g. gun_empty.mp3) only fetch/decode it once.
   • Overlapping playback — multiple BufferSources can sound at once,
     which matters for auto-fire (SMG fires every 75 ms)
   • Looping sources supported (SMG sustained-fire loop)
   • Auto-unlocks on the first pointerdown / keydown anywhere on the page
   ===================================================================== */
    const Sfx = (function () {
        let ctx = null;
        let masterGain = null;           // final bus for every weapon sound
        let masterVolume = 1;            // 0..1, set by game.js
        const buffers = new Map();       // url -> AudioBuffer
        const pendingLoads = new Map();  // url -> Promise
        let unlocked = false;
        let autoUnlockBound = false;

        function ensureCtx() {
            if (ctx) return ctx;
            try {
                ctx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('[Sfx] AudioContext unavailable:', e);
                return null;
            }
            masterGain = ctx.createGain();
            masterGain.gain.value = masterVolume;
            masterGain.connect(ctx.destination);
            return ctx;
        }

        function unlock() {
            const c = ensureCtx();
            if (!c) return;
            if (c.state === 'suspended') c.resume().catch(function () { });
            unlocked = true;
        }

        function bindAutoUnlock() {
            if (autoUnlockBound) return;
            autoUnlockBound = true;
            const handler = function () { unlock(); };
            window.addEventListener('pointerdown', handler, true);
            window.addEventListener('keydown', handler, true);
        }

        function load(url) {
            if (!url) return;
            if (buffers.has(url) || pendingLoads.has(url)) return;
            const c = ensureCtx();
            if (!c) return;
            const p = fetch(url, { cache: 'force-cache' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.arrayBuffer();
                })
                .then(function (buf) { return c.decodeAudioData(buf); })
                .then(function (decoded) {
                    buffers.set(url, decoded);
                    pendingLoads.delete(url);
                    console.log('[Sfx] \u2713 loaded', url);
                })
                .catch(function (e) {
                    pendingLoads.delete(url);
                    console.warn('[Sfx] \u2717 failed', url, e.message || e);
                });
            pendingLoads.set(url, p);
        }

        /* opts: { volume, rate, loop } */
        function play(url, opts) {
            const c = ensureCtx();
            if (!c) return null;
            if (!unlocked) unlock();
            const buf = buffers.get(url);
            if (!buf) return null;
            const vol = (opts && typeof opts.volume === 'number') ? opts.volume : 1;
            const rate = (opts && typeof opts.rate === 'number') ? opts.rate : 1;
            const loop = !!(opts && opts.loop);
            const src = c.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = rate;
            src.loop = loop;
            const gain = c.createGain();
            gain.gain.value = vol;
            src.connect(gain).connect(masterGain || c.destination);
            try { src.start(0); } catch (e) { return null; }
            return { src: src, gain: gain };
        }

        /* Stop a handle returned by play().  `fade` is seconds of
           gain ramp-down used to avoid a click — pass ~0.02 for loops. */
        function stop(handle, fade) {
            if (!handle) return;
            const c = ctx;
            const t = (typeof fade === 'number' && fade > 0) ? fade : 0;
            if (c && t > 0) {
                const now = c.currentTime;
                try {
                    handle.gain.gain.cancelScheduledValues(now);
                    handle.gain.gain.setValueAtTime(handle.gain.gain.value, now);
                    handle.gain.gain.linearRampToValueAtTime(0.0001, now + t);
                } catch (e) { /* ignore */ }
                try { handle.src.stop(now + t); }
                catch (e) { try { handle.src.stop(); } catch (e2) { } }
            } else {
                try { handle.src.stop(); } catch (e) { /* ignore */ }
            }
        }

        function setVolume(v) {
            masterVolume = Math.max(0, Math.min(1, v));
            ensureCtx();
            if (masterGain) masterGain.gain.value = masterVolume;
        }

        return {
            load: load,
            play: play,
            stop: stop,
            unlock: unlock,
            bindAutoUnlock: bindAutoUnlock,
            setVolume: setVolume
        };
    })();

    /* ---------------------------------------------------------------------
       Tunables
       --------------------------------------------------------------------- */
    const MAX_SLOTS = 2;
    const MAX_RANGE = 120;      // metres
    const KICK_SPRING_K = 55;
    const KICK_SPRING_C = 9;

    /* =====================================================================
Per-weapon sound table lives in weapon_sounds.js (loaded before this
file).  It defines window.WEAPON_SOUNDS, mapping weapon `key` → an
object of event → { url, volume, [loop] }.

Recognised events:
 fire    one-shot per shot, OR sustained loop if `loop: true`
 empty   dry-trigger click (shared by every gun)
 reload  played once when a reload starts

If window.WEAPON_SOUNDS is missing, weapons run silently rather than
throwing — a warning is logged once from init().
===================================================================== */
    function soundTable() { return window.WEAPON_SOUNDS || null; }

    function getSoundEntry(def, slot) {
        if (!def || !def.key) return null;
        const table = soundTable();
        if (!table) return null;
        const gun = table[def.key];
        if (!gun) return null;
        const entry = gun[slot];
        if (!entry || !entry.url) return null;
        return entry;
    }

    /* Throttle so rapid clicking on an empty mag can't machine-gun the
       "click" sample.  Both the audio throttle and fireCooldown start
       counting from the same instant. */
    let lastEmptySoundAt = 0;
    const EMPTY_SOUND_THROTTLE_MS = 150;

    function playWeaponSound(def, slot) {
        const entry = getSoundEntry(def, slot);
        if (!entry) return;
        /* Looping fire sounds are managed by the fire-loop helper,
           not fired per-shot. */
        if (entry.loop) return;
        Sfx.play(entry.url, { volume: entry.volume });
    }

    /* ---------------------------------------------------------------------
       Sustained-fire loop (SMG etc.)
       --------------------------------------------------------------------- */
    let fireLoopHandle = null;
    let fireLoopUrl = null;

    function startFireLoop() {
        const def = slots[activeSlot];
        const entry = getSoundEntry(def, 'fire');
        if (!entry || !entry.loop) return;
        if (fireLoopHandle && fireLoopUrl === entry.url) return;   // already running
        stopFireLoop();
        fireLoopHandle = Sfx.play(entry.url, { volume: entry.volume, loop: true });
        fireLoopUrl = entry.url;
    }

    function stopFireLoop() {
        if (fireLoopHandle) Sfx.stop(fireLoopHandle, 0.02);
        fireLoopHandle = null;
        fireLoopUrl = null;
    }

    /* ---------------------------------------------------------------------
       State
       --------------------------------------------------------------------- */
    const slots = [null, null];   // weapon defs
    const mags = [0, 0];         // current rounds in mag
    const holders = [null, null];   // { holder, weaponGroup, muzzle, def }

    let activeSlot = -1;           // -1 = none (tool active)
    let ammoPools = {};           // ammoType → count
    let triggerHeld = false;
    let scoped = false;
    let scopeT = 0;

    let fireCooldown = 0;
    let fireAnimT = 1;
    let reloadingSlot = -1;
    let reloadTimer = 0;
    let reloadAnimT = 1;

    let baseFov = 76;
    let recoilOffset = 0;            // un-recovered pitch offset (radians)

    const bullets = [];              // { mesh, life, maxLife }
    const impacts = [];              // { mesh, life, maxLife, grow }

    /* ---------------------------------------------------------------------
       Weapon-bar UI  (2 slots, sits just above the tool hotbar)
       --------------------------------------------------------------------- */
    let weaponBarEl = null;
    const slotEls = [];

    function buildWeaponBar() {
        if (weaponBarEl) return;
        weaponBarEl = document.createElement('div');
        weaponBarEl.id = 'weaponBar';
        weaponBarEl.style.cssText =
            'position:fixed;left:50%;bottom:114px;transform:translateX(-50%);' +
            'display:flex;gap:14px;z-index:5;pointer-events:none;' +
            'font-family:"Courier New",monospace;';
        document.body.appendChild(weaponBarEl);

        for (let i = 0; i < MAX_SLOTS; i++) {
            const el = document.createElement('div');
            el.style.cssText =
                'width:110px;height:36px;background:#12161d;' +
                'border:2px solid #3a2e26;' +
                'box-shadow:inset 0 0 0 1px #05070a;' +
                'font:bold 10px "Courier New",monospace;letter-spacing:1px;' +
                'display:flex;align-items:center;justify-content:center;' +
                'position:relative;transition:border-color .12s,color .12s,opacity .15s;';
            weaponBarEl.appendChild(el);
            slotEls.push(el);
        }
    }

    function refreshSlotsUI() {
        buildWeaponBar();
        for (let i = 0; i < MAX_SLOTS; i++) {
            const el = slotEls[i];
            if (!el) continue;
            const def = slots[i];
            const active = (i === activeSlot);

            el.style.borderColor = active ? '#e8c86a' : '#3a2e26';
            el.style.color = active ? '#f6dd8b' : '#a89a84';

            if (!def) {
                el.innerHTML = '<span style="opacity:.5">' + (i + 1) + ' · EMPTY</span>';
                continue;
            }

            const m = mags[i];
            const mg = def.magSize;
            const pool = ammoPools[def.ammoType] || 0;

            el.innerHTML =
                '<span style="position:absolute;top:1px;left:4px;font-size:8px;' +
                'color:' + (active ? '#f6dd8b' : '#6a5a44') + ';">' + (i + 1) + '</span>' +
                '<span style="font-size:11px;color:' + (active ? '#f6dd8b' : '#c8b88a') + ';">' +
                (def.icon || '◉') + ' ' + (def.name || '?') +
                '</span>' +
                '<span style="position:absolute;bottom:1px;right:5px;font-size:10px;' +
                'color:' + (m === 0 ? '#d04030' : '#e8c86a') + ';">' +
                m + ' / ' + pool +
                '</span>';
        }
    }

    /* ---------------------------------------------------------------------
       Weapon meshes  (attached to the right hand)
       --------------------------------------------------------------------- */
    function buildWeaponMesh(def) {
        const group = new THREE.Group();
        for (const part of def.model) {
            const geo = new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
            const col = (typeof part.c === 'number') ? part.c : 0x808080;
            const mat = new THREE.MeshLambertMaterial({ color: col, fog: true });
            const m = new THREE.Mesh(geo, mat);
            m.position.set(part.p[0], part.p[1], part.p[2]);
            if (part.r) m.rotation.set(part.r[0], part.r[1], part.r[2]);
            group.add(m);
        }
        const muzzle = new THREE.Object3D();
        const ml = def.muzzleLocal || [0, 0, -0.3];
        muzzle.position.set(ml[0], ml[1], ml[2]);
        group.add(muzzle);
        return { group, muzzle };
    }

    /* ---------------------------------------------------------------------
   Weapon mesh — now parented to fpRoot (not handR).  The WEAPON
   position is the primary transform; the two hands are then placed
   ON the weapon using the grip data.
   --------------------------------------------------------------------- */
    let weaponRig = null;   // single Group, child of fpRoot

    function ensureWeaponRig() {
        if (weaponRig) return;
        const fpRoot = H().fpRoot;
        if (!fpRoot) return;
        weaponRig = new THREE.Group();
        fpRoot.add(weaponRig);
    }

    function buildWeaponMesh(def) {
        const group = new THREE.Group();
        for (const part of def.model) {
            const geo = new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
            const col = (typeof part.c === 'number') ? part.c : 0x808080;
            const mat = new THREE.MeshLambertMaterial({ color: col, fog: true });
            const m = new THREE.Mesh(geo, mat);
            m.position.set(part.p[0], part.p[1], part.p[2]);
            if (part.r) m.rotation.set(part.r[0], part.r[1], part.r[2]);
            group.add(m);
        }
        const muzzle = new THREE.Object3D();
        const ml = def.muzzleLocal || [0, 0, -0.3];
        muzzle.position.set(ml[0], ml[1], ml[2]);
        group.add(muzzle);
        return { group, muzzle };
    }

    function attachWeapon(slotIdx) {
        ensureWeaponRig();
        if (!weaponRig) return;
        const def = slots[slotIdx];
        if (!def) return;

        detachWeapon(slotIdx);

        const { group, muzzle } = buildWeaponMesh(def);
        group.visible = false;

        weaponRig.add(group);
        holders[slotIdx] = { weaponGroup: group, muzzle, def };
    }

    function detachWeapon(slotIdx) {
        const h = holders[slotIdx];
        if (!h) return;
        if (h.weaponGroup.parent) h.weaponGroup.parent.remove(h.weaponGroup);
        h.weaponGroup.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                const ms = Array.isArray(o.material) ? o.material : [o.material];
                ms.forEach(m => m.dispose());
            }
        });
        holders[slotIdx] = null;
    }

    /* ---------------------------------------------------------------------
       Auto-ADS: compute the weapon pose that puts the sight on the eye.
       Result is in fpRoot space:
         sight  = adsPose.p + adsPose.r * sightLocal   (r = identity)
         want   = (0, 0, -0.02)   (just in front of the eye)
       Solving with r = identity:
         adsPose.p = (0, 0, -0.02) - sightLocal
       --------------------------------------------------------------------- */
    const _adsVec = new THREE.Vector3();
    function computeAdsPose(def) {
        const s = def.sightLocal || [0, 0, 0];
        return {
            p: [-s[0], -s[1], -0.02 - s[2]],
            r: [0, 0, 0],
        };
    }

    /* ---------------------------------------------------------------------
       Per-frame pose: 
         1. Place the weapon rig at (hip → ads, blended by scopeT)
         2. Place both hands on the weapon using grip data
         3. Tell game.js to skip its idle hand-anim (we drive them)
       --------------------------------------------------------------------- */
    const _qTemp = new THREE.Quaternion();
    const _eTemp = new THREE.Euler();
    const _vTemp = new THREE.Vector3();

    function applyGrip(hand, grip, weaponQuat, weaponPos) {
        if (!hand || !grip) return;
        // hand position = weaponPos + weaponQuat * grip.p
        _vTemp.set(grip.p[0], grip.p[1], grip.p[2]).applyQuaternion(weaponQuat);
        hand.position.copy(weaponPos).add(_vTemp);
        // hand rotation = weaponQuat * gripEuler
        _eTemp.set(grip.r[0], grip.r[1], grip.r[2]);
        _qTemp.setFromEuler(_eTemp);
        hand.quaternion.copy(weaponQuat).multiply(_qTemp);
    }

    function applyPose(slotIdx, dt) {
        const h = holders[slotIdx];
        if (!h || !weaponRig) return;
        const def = h.def;
        const g = H();
        const handL = g.handL, handR = g.handR;
        const updateArmBones = g.updateArmBones;
        const setWeaponDrivesHands = g.setWeaponDrivesHands;
        if (setWeaponDrivesHands) setWeaponDrivesHands(true);

        const hip = def.hipPose || def.heldPose;
        const ads = def.adsPose || computeAdsPose(def);

        // Blend hip → ads by scopeT
        weaponRig.position.set(
            hip.p[0] + (ads.p[0] - hip.p[0]) * scopeT,
            hip.p[1] + (ads.p[1] - hip.p[1]) * scopeT,
            hip.p[2] + (ads.p[2] - hip.p[2]) * scopeT
        );
        weaponRig.rotation.set(
            hip.r[0] + (ads.r[0] - hip.r[0]) * scopeT,
            hip.r[1] + (ads.r[1] - hip.r[1]) * scopeT,
            hip.r[2] + (ads.r[2] - hip.r[2]) * scopeT
        );

        /* ---- Fire recoil kick ---- */
        const fireBell = fireAnimT < 1 ? Math.sin(fireAnimT * Math.PI) : 0;
        const kc = def.anim ? def.anim.kick : 0.04;
        weaponRig.position.z += fireBell * kc;
        weaponRig.rotation.x += fireBell * (def.anim ? def.anim.swing : 0.10);

        /* ============================================================
           RELOAD ANIMATION
           ------------------------------------------------------------
           reloadAnimT is reload progress (0 → 1), driven from
           reloadTimer in update() so gun motion and mag refill are
           always synchronised.

           Phases:
             0.00 – 0.15   dip: gun pitches down and rolls out of aim
             0.15 – 0.55   hold: gun stays tilted; support hand leaves
                           front grip, cycles to magwell, pulls the old
                           mag out, pushes a fresh one in
             0.55 – 0.68   rack: brief forward snap (slide release)
             0.68 – 1.00   return: gun comes back to aim pose
           ============================================================ */
        if (reloadingSlot === slotIdx && reloadAnimT < 1) {
            const p = reloadAnimT;

            /* Gun dip + roll — rises fast, holds through the mag swap,
               falls back near the end. */
            const gunHold = Math.min(
                smoothstep(p, 0.05, 0.15),
                1 - smoothstep(p, 0.68, 0.88)
            );
            weaponRig.position.x += gunHold * 0.02;
            weaponRig.position.y -= gunHold * 0.08;
            weaponRig.position.z += gunHold * 0.05;
            weaponRig.rotation.x -= gunHold * 0.55;
            weaponRig.rotation.z += gunHold * 0.35;

            /* Slide rack — a short forward snap right after the mag
               seats.  Adds pitch-up and pushes the whole rig forward
               for ~80 ms. */
            const rack = Math.min(
                smoothstep(p, 0.55, 0.60),
                1 - smoothstep(p, 0.63, 0.69)
            );
            weaponRig.position.z -= rack * 0.03;
            weaponRig.rotation.x += rack * 0.30;
        }

        // Place the two hands at their base grip pose (already reflecting
        // whatever dip / roll the reload just applied to the rig).
        applyGrip(handR, def.gripR, weaponRig.quaternion, weaponRig.position);
        applyGrip(handL, def.gripL, weaponRig.quaternion, weaponRig.position);

        /* ---- Support hand reload motion ----------------------------
           Offsets are in weapon-local space, so they rotate with the
           dipping / rolling gun instead of drifting in world space.

           "Out"  = hand has left the front grip and is at the magwell.
           "Pull" = short pulse where the hand drags the magazine out
                    (and, without a mag mesh, does the push-back-in).  */
        if (reloadingSlot === slotIdx && reloadAnimT < 1) {
            const p = reloadAnimT;

            const lhOut = Math.min(
                smoothstep(p, 0.12, 0.24),
                1 - smoothstep(p, 0.55, 0.72)
            );
            const lhPull = Math.min(
                smoothstep(p, 0.30, 0.38),
                1 - smoothstep(p, 0.44, 0.54)
            );

            /* Local translation: down (−Y), back toward the grip (+Z),
               a hair inward so it doesn't clip the gun body. */
            _vTemp.set(
                lhOut * 0.015,
                -(lhOut * 0.06 + lhPull * 0.05),
                lhOut * 0.09
            ).applyQuaternion(weaponRig.quaternion);
            handL.position.add(_vTemp);

            /* Wrist rotation — breaks the "rigid hand on rails" look. */
            _eTemp.set(
                lhOut * 0.35 + lhPull * 0.20,
                lhOut * -0.25,
                lhOut * 0.20
            );
            _qTemp.setFromEuler(_eTemp);
            handL.quaternion.multiply(_qTemp);
        }

        // Arm bones follow the final hand positions, so the forearm
        // tracks the support hand down to the magwell and back.
        if (updateArmBones) {
            updateArmBones(+1, handR);
            updateArmBones(-1, handL);
        }
    }

    /* ---------------------------------------------------------------------
       Firing
       --------------------------------------------------------------------- */
    function rayAABB(origin, dir, cx, cy, cz, hw, hh, hd, maxT) {
        const ix = 1 / (dir.x || 1e-9);
        const iy = 1 / (dir.y || 1e-9);
        const iz = 1 / (dir.z || 1e-9);
        const t1 = (cx - hw - origin.x) * ix, t2 = (cx + hw - origin.x) * ix;
        const t3 = (cy - hh - origin.y) * iy, t4 = (cy + hh - origin.y) * iy;
        const t5 = (cz - hd - origin.z) * iz, t6 = (cz + hd - origin.z) * iz;
        const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4), Math.min(t5, t6));
        const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4), Math.max(t5, t6));
        if (tmax < 0 || tmin > tmax || tmin > maxT) return null;
        return tmin;
    }

    function fireOneShot() {
        const def = slots[activeSlot];
        const h = holders[activeSlot];
        if (!def || !h) return;

        const g = H();
        const cam = g.camera;
        if (!cam) return;

        if (mags[activeSlot] <= 0) { fireCooldown = 0.25; return; }
        mags[activeSlot]--;

        /* Fire sound — non-looping weapons play one sample per shot.
           Looping weapons (SMG) are driven by the fire-loop manager,
           so playWeaponSound() is a no-op for them. */
        playWeaponSound(def, 'fire');

        /* Direction with spread (scope tightens). */
        const dir = g.getLookDir().clone();
        const spreadMul = 1 - 0.75 * scopeT;
        const sp = (def.spread || 0) * spreadMul;
        if (sp > 0) {
            const up = new THREE.Vector3(0, 1, 0);
            const right = new THREE.Vector3().crossVectors(dir, up).normalize();
            const realUp = new THREE.Vector3().crossVectors(right, dir).normalize();
            dir.addScaledVector(right, (Math.random() - 0.5) * 2 * sp);
            dir.addScaledVector(realUp, (Math.random() - 0.5) * 2 * sp);
            dir.normalize();
        }

        const origin = cam.position.clone();

        /* Raycast voxels + enemies — nearest hit wins. */
        const hitVoxel = g.raycastVoxel(origin, dir, MAX_RANGE);
        const enemies = g.enemies || [];
        let hitEnemy = null;
        let hitT = hitVoxel ? hitVoxel.t : MAX_RANGE;

        for (const e of enemies) {
            if (!e.alive) continue;
            const t = rayAABB(origin, dir,
                e.pos.x, e.pos.y + 0.85, e.pos.z,
                0.36, 0.85, 0.36, hitT);
            if (t !== null && t < hitT) { hitT = t; hitEnemy = e; }
        }

        let endPoint;
        if (hitEnemy) {
            endPoint = origin.clone().addScaledVector(dir, hitT);
            if (g.hurtEnemy) g.hurtEnemy(hitEnemy, def.damage);
            spawnImpact(endPoint, 0xff5050, true);
        } else if (hitVoxel) {
            endPoint = origin.clone().addScaledVector(dir, hitVoxel.t);
            const cx = hitVoxel.x + hitVoxel.nx;
            const cy = hitVoxel.y + hitVoxel.ny;
            const cz = hitVoxel.z + hitVoxel.nz;
            if (g.carveSphere) {
                g.carveSphere(cx, cy, cz, 1.1, { debrisChance: 0.12 });
            }
            if (g.net && g.net.sendCarve) g.net.sendCarve(cx, cy, cz, 1.1, false);
            spawnImpact(endPoint, def.bulletColor, false);
        } else {
            endPoint = origin.clone().addScaledVector(dir, MAX_RANGE);
        }

        /* Visuals. */
        const muzzleWorld = new THREE.Vector3();
        h.muzzle.getWorldPosition(muzzleWorld);
        spawnTracer(muzzleWorld, endPoint, def);
        spawnMuzzleFlash(muzzleWorld, def);

        /* Recoil. */
        const kick = def.recoilKick || 0.025;
        const player = g.player;
        if (player) {
            player.pitch += kick;
            recoilOffset += kick;
        }
        if (g.shakeCamera) g.shakeCamera(0.055);

        fireCooldown = def.fireRate || 0.2;
        fireAnimT = 0;
        refreshSlotsUI();
    }

    function spawnTracer(from, to, def) {
        const scene = H().scene;
        if (!scene) return;
        const dist = from.distanceTo(to);
        if (dist < 0.05) return;
        const size = def.bulletSize || 0.03;
        const geo = new THREE.BoxGeometry(size, size, dist);
        const mat = new THREE.MeshBasicMaterial({
            color: def.bulletColor || 0xffddaa,
            transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false, fog: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(from).lerp(to, 0.5);
        mesh.lookAt(to);
        scene.add(mesh);
        bullets.push({ mesh, life: 0.055, maxLife: 0.055 });
    }

    function spawnMuzzleFlash(pos, def) {
        const scene = H().scene;
        if (!scene) return;
        const geo = new THREE.SphereGeometry(0.10, 8, 6);
        const mat = new THREE.MeshBasicMaterial({
            color: def.bulletColor || 0xffddaa,
            transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false, fog: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(pos);
        scene.add(mesh);
        impacts.push({ mesh, life: 0.05, maxLife: 0.05, grow: 3.8 });
    }

    function spawnImpact(pos, color, isEnemy) {
        const scene = H().scene;
        if (!scene) return;
        const c = isEnemy ? 0xff4040 : (color || 0xffddaa);
        const geo = new THREE.SphereGeometry(0.075, 6, 5);
        const mat = new THREE.MeshBasicMaterial({
            color: c, transparent: true, opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false, fog: false
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(pos);
        scene.add(mesh);
        impacts.push({ mesh, life: 0.22, maxLife: 0.22, grow: 1.8 });
    }

    /* ---------------------------------------------------------------------
       Reload
       --------------------------------------------------------------------- */
    function startReload() {
        if (activeSlot < 0 || reloadingSlot >= 0) return;
        const def = slots[activeSlot];
        if (!def) return;
        if (mags[activeSlot] >= def.magSize) return;
        if ((ammoPools[def.ammoType] || 0) <= 0) return;

        stopFireLoop();                     // silence the sustained-fire loop
        playWeaponSound(def, 'reload');     // NEW — reload sample starts here
        reloadingSlot = activeSlot;
        reloadTimer = def.reloadTime || 1.5;
        reloadAnimT = 0;
    }

    function finishReload() {
        const def = slots[reloadingSlot];
        if (!def) { reloadingSlot = -1; return; }
        const need = def.magSize - mags[reloadingSlot];
        const have = ammoPools[def.ammoType] || 0;
        const take = Math.min(need, have);
        mags[reloadingSlot] += take;
        ammoPools[def.ammoType] = have - take;
        reloadingSlot = -1;
        reloadAnimT = 1;
        refreshSlotsUI();
    }

    /* ---------------------------------------------------------------------
       Update
       --------------------------------------------------------------------- */
    function update(dt) {
        if (fireCooldown > 0) fireCooldown -= dt;
        if (fireAnimT < 1) fireAnimT = Math.min(1, fireAnimT + dt * 9);

        if (reloadingSlot >= 0) {
            reloadTimer -= dt;

            /* reloadAnimT is now driven from the actual reload timer,
               not from its own independent tick.  Result: the gun's
               animation always finishes exactly when the mag is full,
               regardless of what `reloadTime` the weapon JSON says. */
            if (reloadTimer <= 0) {
                finishReload();          // sets reloadAnimT = 1, reloadingSlot = -1
            } else {
                const def = slots[reloadingSlot];
                const total = (def && def.reloadTime) || 1.5;
                reloadAnimT = Math.max(0, Math.min(1, 1 - reloadTimer / total));
            }
        } else if (reloadAnimT < 1) {
            /* Safety net — if a reload was ever interrupted, ease the
               gun back rather than snapping it. */
            reloadAnimT = Math.min(1, reloadAnimT + dt * 3);
        }

        /* Scope blend + FOV. */
        const wantScope = scoped && activeSlot >= 0 && reloadingSlot < 0;
        const targetScopeT = wantScope ? 1 : 0;
        scopeT += (targetScopeT - scopeT) * Math.min(1, dt * 12);
        if (scopeT < 0.001) scopeT = 0;

        const cam = H().camera;
        if (cam) {
            const def = activeSlot >= 0 ? slots[activeSlot] : null;
            const targetFov = (def && wantScope) ? (def.scopeFov || 55) : baseFov;
            const cur = cam.fov + (targetFov - cam.fov) * Math.min(1, dt * 12);
            if (Math.abs(cur - cam.fov) > 0.005) {
                cam.fov = cur;
                cam.updateProjectionMatrix();
            }
        }

        /* Recoil recovery — apply negative pitch over time. */
        if (recoilOffset > 0) {
            const recover = Math.min(recoilOffset, dt * KICK_SPRING_K * 0.045);
            const player = H().player;
            if (player) player.pitch -= recover;
            recoilOffset -= recover;
            if (recoilOffset < 0.0005) recoilOffset = 0;
        }

        /* Auto fire. */
        if (triggerHeld && activeSlot >= 0 && reloadingSlot < 0) {
            const def = slots[activeSlot];
            if (def && def.auto && fireCooldown <= 0 && mags[activeSlot] > 0) {
                fireOneShot();
            }
        }

        /* Sustained-fire loop (SMG etc.).
           Runs while the trigger is held, ammo remains, and we aren't
           mid-reload.  startFireLoop() is idempotent, so calling it
           every frame is fine. */
        {
            const loopDef = activeSlot >= 0 ? slots[activeSlot] : null;
            const loopEntry = loopDef ? getSoundEntry(loopDef, 'fire') : null;
            const wantsLoop = !!(
                loopEntry && loopEntry.loop &&
                triggerHeld &&
                activeSlot >= 0 &&
                reloadingSlot < 0 &&
                mags[activeSlot] > 0
            );
            if (wantsLoop) startFireLoop();
            else stopFireLoop();
        }

        /* Pose. */
        if (activeSlot >= 0) applyPose(activeSlot, dt);

        /* Fade tracer bullets. */
        for (let i = bullets.length - 1; i >= 0; i--) {
            const b = bullets[i];
            b.life -= dt;
            if (b.mesh.material) b.mesh.material.opacity = Math.max(0, b.life / b.maxLife) * 0.95;
            if (b.life <= 0) {
                if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
                b.mesh.geometry.dispose();
                b.mesh.material.dispose();
                bullets.splice(i, 1);
            }
        }
        /* Fade impacts. */
        for (let i = impacts.length - 1; i >= 0; i--) {
            const im = impacts[i];
            im.life -= dt;
            const t = im.life / im.maxLife;
            if (im.mesh.material) im.mesh.material.opacity = Math.max(0, t) * 0.9;
            if (im.grow) im.mesh.scale.setScalar(1 + (1 - t) * im.grow);
            if (im.life <= 0) {
                if (im.mesh.parent) im.mesh.parent.remove(im.mesh);
                im.mesh.geometry.dispose();
                im.mesh.material.dispose();
                impacts.splice(i, 1);
            }
        }
    }

    /* ---------------------------------------------------------------------
       Slot selection
       --------------------------------------------------------------------- */
    function selectSlot(i) {
        if (i === activeSlot) return;
        stopFireLoop();                 // silence whichever loop was running
        if (activeSlot >= 0 && holders[activeSlot]) {
            holders[activeSlot].weaponGroup.visible = false;
        }
        activeSlot = i;
        if (activeSlot >= 0 && holders[activeSlot]) {
            holders[activeSlot].weaponGroup.visible = true;
        } else {
            // Leaving weapon mode — hand control returns to game.js
            if (H().setWeaponDrivesHands) H().setWeaponDrivesHands(false);
        }
        scoped = false;
        refreshSlotsUI();
        if (H().updateHeldToolModel) H().updateHeldToolModel();
    }

    /* ---------------------------------------------------------------------
       Input entry points (called from game.js)
       --------------------------------------------------------------------- */
    function onTriggerDown() {
        triggerHeld = true;
        if (activeSlot < 0 || reloadingSlot >= 0) return;
        const def = slots[activeSlot];
        if (!def) return;

        if (mags[activeSlot] <= 0) {
            /* Dry trigger — play the click, but throttle the sample so
               spamming LMB doesn't machine-gun it. */
            const now = performance.now();
            if (now - lastEmptySoundAt > EMPTY_SOUND_THROTTLE_MS) {
                playWeaponSound(def, 'empty');
                lastEmptySoundAt = now;
            }
            fireCooldown = 0.25;
            return;
        }

        if (fireCooldown > 0) return;
        fireOneShot();
    }

    function onTriggerUp() {
        triggerHeld = false;
        stopFireLoop();
    }

    function onScopeDown() { if (activeSlot >= 0) scoped = true; }
    function onScopeUp() { scoped = false; }
    function onReloadKey() { startReload(); }

    function isActive() { return activeSlot >= 0; }
    function getActiveSlot() { return activeSlot; }
    function getActiveWeapon() { return activeSlot >= 0 ? slots[activeSlot] : null; }

    /* Sensitivity multiplier consumed by game.js mousemove. */
    function getSensitivityMul() {
        if (activeSlot < 0) return 1;
        const def = slots[activeSlot];
        const s = def && def.scopeSens !== undefined ? def.scopeSens : 0.5;
        return 1 - (1 - s) * scopeT;
    }

    /* Scope blend 0..1 — consumed by game.js's FP-view-model so the
   eye can align with the barrel while ADS is engaged. */
    function getScopeT() { return scopeT; }

    /* ---------------------------------------------------------------------
       Loadout
       --------------------------------------------------------------------- */
    function addAmmo(type, count) {
        const cap = (window.AMMO_TYPES && window.AMMO_TYPES[type] &&
            window.AMMO_TYPES[type].max) || Infinity;
        ammoPools[type] = Math.min(cap, (ammoPools[type] || 0) + count);
        refreshSlotsUI();
    }

    function giveWeapon(slotIdx, def) {
        if (slotIdx < 0 || slotIdx >= MAX_SLOTS || !def) return;
        slots[slotIdx] = def;
        mags[slotIdx] = def.magSize;
        attachWeapon(slotIdx);
        refreshSlotsUI();
    }

    /* ---------------------------------------------------------------------
       Init / reset
       --------------------------------------------------------------------- */
    function init() {
        buildWeaponBar();

        const defs = window.WEAPON_MODEL_DATA || [];
        const pistol = defs.find(d => d.key === 'pistol');
        const smg = defs.find(d => d.key === 'smg');

        if (pistol) giveWeapon(0, pistol);
        if (smg) giveWeapon(1, smg);

        const at = window.AMMO_TYPES || {};
        for (const k in at) ammoPools[k] = Math.min(60, (at[k].max || 300));

        if (H().camera) baseFov = H().camera.fov;
        refreshSlotsUI();

        /* ---- Sound boot ----
   Preload every sample defined in weapon_sounds.js, and arm the
   auto-unlock so the very first click anywhere on the page
   resumes the AudioContext.  Buffers are keyed by URL, so
   gun_empty.mp3 (shared by pistol and SMG) is fetched and
   decoded just once, and preloading survives a reset() / map
   change. */
        Sfx.bindAutoUnlock();
        const table = soundTable();
        if (!table) {
            console.warn('[Weapons] window.WEAPON_SOUNDS is not defined — ' +
                'weapon audio disabled. Load weaponSound.js before weapons.js.');
        } else {
            const seenUrls = new Set();
            for (const wkey in table) {
                const gun = table[wkey];
                for (const slot in gun) {
                    const entry = gun[slot];
                    if (entry && entry.url && !seenUrls.has(entry.url)) {
                        seenUrls.add(entry.url);
                        Sfx.load(entry.url);
                    }
                }
            }
        }
    }

    function reset() {
        stopFireLoop();
        for (let i = 0; i < MAX_SLOTS; i++) detachWeapon(i);
        slots[0] = slots[1] = null;
        mags[0] = mags[1] = 0;
        activeSlot = -1;
        ammoPools = {};
        scoped = false; scopeT = 0;
        triggerHeld = false;
        reloadingSlot = -1;
        reloadAnimT = 1;
        recoilOffset = 0;
        if (H().setWeaponDrivesHands) H().setWeaponDrivesHands(false);
        for (const b of bullets) b.mesh.parent && b.mesh.parent.remove(b.mesh);
        bullets.length = 0;
        for (const im of impacts) im.mesh.parent && im.mesh.parent.remove(im.mesh);
        impacts.length = 0;
        refreshSlotsUI();
    }

    /* ---------------------------------------------------------------------
       Expose
       --------------------------------------------------------------------- */
    window.Weapons = {
        init, reset, update,
        selectSlot, isActive, getActiveSlot, getActiveWeapon,
        onTriggerDown, onTriggerUp,
        onScopeDown, onScopeUp, onReloadKey,
        getSensitivityMul,
        getScopeT,
        addAmmo, giveWeapon,
        refreshUI: refreshSlotsUI,
        getAmmo: (t) => ammoPools[t] || 0,
        getMag: (s) => mags[s] || 0,
        setSoundVolume: (v) => Sfx.setVolume(v)
    };
})();