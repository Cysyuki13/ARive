/* =========================================================================
   ARive — Weapons System
   ------------------------------------------------------------------------
   Guns live OUTSIDE the tool hotbar.  Two weapon slots, keys 1 / 2.
   Tools move to keys 3–7.

   Controls (only when a weapon slot is active):
     LMB          fire   (auto weapons: hold to fire)
     RMB (hold)   scope
     R            reload
     Y            inspect (per-weapon showcase animation)
     1 / 2        select weapon slot
     3 – 7        select tool

   Exposes window.Weapons. Uses window.ARiveHooks lazily.
   ========================================================================= */
(function () {
  "use strict";

  function H() {
    return window.ARiveHooks || {};
  }

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
       ===================================================================== */
  const Sfx = (function () {
    let ctx = null;
    let masterGain = null;
    let masterVolume = 1;
    const buffers = new Map();
    const pendingLoads = new Map();
    let unlocked = false;
    let autoUnlockBound = false;

    function ensureCtx() {
      if (ctx) return ctx;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn("[Sfx] AudioContext unavailable:", e);
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
      if (c.state === "suspended") c.resume().catch(function () { });
      unlocked = true;
    }

    function bindAutoUnlock() {
      if (autoUnlockBound) return;
      autoUnlockBound = true;
      const handler = function () {
        unlock();
      };
      window.addEventListener("pointerdown", handler, true);
      window.addEventListener("keydown", handler, true);
    }

    function load(url) {
      if (!url) return;
      if (buffers.has(url) || pendingLoads.has(url)) return;
      const c = ensureCtx();
      if (!c) return;
      const p = fetch(url, { cache: "force-cache" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          return c.decodeAudioData(buf);
        })
        .then(function (decoded) {
          buffers.set(url, decoded);
          pendingLoads.delete(url);
          console.log("[Sfx] \u2713 loaded", url);
        })
        .catch(function (e) {
          pendingLoads.delete(url);
          console.warn("[Sfx] \u2717 failed", url, e.message || e);
        });
      pendingLoads.set(url, p);
    }

    function play(url, opts) {
      const c = ensureCtx();
      if (!c) return null;
      if (!unlocked) unlock();
      const buf = buffers.get(url);
      if (!buf) return null;
      const vol = opts && typeof opts.volume === "number" ? opts.volume : 1;
      const rate = opts && typeof opts.rate === "number" ? opts.rate : 1;
      const loop = !!(opts && opts.loop);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.loop = loop;
      const gain = c.createGain();
      gain.gain.value = vol;
      src.connect(gain).connect(masterGain || c.destination);
      try {
        src.start(0);
      } catch (e) {
        return null;
      }
      return { src: src, gain: gain };
    }

    function stop(handle, fade) {
      if (!handle) return;
      const c = ctx;
      const t = typeof fade === "number" && fade > 0 ? fade : 0;
      if (c && t > 0) {
        const now = c.currentTime;
        try {
          handle.gain.gain.cancelScheduledValues(now);
          handle.gain.gain.setValueAtTime(handle.gain.gain.value, now);
          handle.gain.gain.linearRampToValueAtTime(0.0001, now + t);
        } catch (e) {
          /* ignore */
        }
        try {
          handle.src.stop(now + t);
        } catch (e) {
          try {
            handle.src.stop();
          } catch (e2) { }
        }
      } else {
        try {
          handle.src.stop();
        } catch (e) {
          /* ignore */
        }
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
      setVolume: setVolume,
    };
  })();

  /* ---------------------------------------------------------------------
       Tunables
       --------------------------------------------------------------------- */
  const MAX_SLOTS = 2;
  const MAX_RANGE = 120;
  const KICK_SPRING_K = 55;
  const KICK_SPRING_C = 9;

  /* =====================================================================
       AMMO — canonical identity
       ===================================================================== */
  const AMMO_ALIASES = {
    "9mm": "9mm",
    "9x19": "9mm",
    "9x19mm": "9mm",
    "9mmluger": "9mm",
    "9mmpara": "9mm",
    "9mmparabellum": "9mm",
    556: "556",
    "556x45": "556",
    "556x45mm": "556",
    "556nato": "556",
    223: "556",
    "223rem": "556",
    shell: "shell",
    shells: "shell",
    "12ga": "shell",
    "12gauge": "shell",
    "12g": "shell",
    buckshot: "shell",
    short: "short",
    shortshell: "short",
    "12gashort": "short",
    minishell: "short",
  };

  function canonAmmo(t) {
    if (typeof t !== "string") return "";
    const k = t.trim().toLowerCase().replace(/[\s_\-×x]+/g, "");
    return AMMO_ALIASES[k] || k;
  }

  window.ARiveAmmo = window.ARiveAmmo || {};
  window.ARiveAmmo.canon = canonAmmo;

  const DEFAULT_AMMO_DEFS = {
    "9mm": { name: "9MM", icon: "▮", color: "#b09040", maxStack: 200 },
    556: { name: "5.56", icon: "▮", color: "#8a9a50", maxStack: 200 },
    shell: { name: "SHELL", icon: "▮", color: "#a05030", maxStack: 100 },
    short: { name: "SHORT", icon: "▮", color: "#a05030", maxStack: 100 },
  };

  function resolveAmmoDef(type) {
    const g = H();
    if (g.getAmmoDef) {
      let d = g.getAmmoDef(type);
      if (!d) d = g.getAmmoDef(canonAmmo(type));
      if (!d) d = g.getAmmoDef(String(type).toUpperCase());
      if (d) return d;
    }
    return DEFAULT_AMMO_DEFS[canonAmmo(type)] || null;
  }

  /* =====================================================================
     WEAPON TYPE — single source of truth
     ---------------------------------------------------------------------
     Every weapon declares its own `weaponType` in its JSON:

         "weaponType": "pistol" | "smg" | "rifle" | "shotgun" | "sniper"

     Everything that used to guess the class from `def.key` — sound
     lookup, inspect animation, ADS behaviour — now reads this instead.

     The legacy key-guess is kept as a fallback so old JSON files that
     don't set `weaponType` still boot correctly.
     ===================================================================== */
  const VALID_WEAPON_TYPES = {
    pistol: 1,
    smg: 1,
    rifle: 1,
    shotgun: 1,
    sniper: 1
  };

  function getWeaponType(def) {
    if (!def) return "rifle";

    if (typeof def.weaponType === "string") {
      const t = def.weaponType.toLowerCase();
      if (VALID_WEAPON_TYPES[t]) return t;
    }

    /* Legacy fallback — infer from key for older JSON files. */
    const k = def.key;
    if (k === "pistol") return "pistol";
    if (k === "smg") return "smg";
    if (k === "shotgun") return "shotgun";
    if (k === "sniper") return "sniper";
    return "rifle";
  }

  /* Shotgun JSONs that forget `pellets` still fire a proper spread
   instead of a single slug.  Non-shotguns default to 1. */
  function getPelletCount(def) {
    if (!def) return 1;
    if (typeof def.pellets === "number" && def.pellets > 0) {
      return Math.max(1, def.pellets | 0);
    }
    if (getWeaponType(def) === "shotgun") return 8;
    return 1;
  }

  /* =====================================================================
       Sound table — window.WEAPON_SOUNDS, loaded before this file.
       ===================================================================== */
  function soundTable() {
    return window.WEAPON_SOUNDS || null;
  }

  function getSoundEntry(def, slot) {
    if (!def) return null;
    const table = soundTable();
    if (!table) return null;

    // 1. Exact key — table.m4.fire
    let gun = def.key ? table[def.key] : null;

    // 2. Explicit soundKey override — "soundKey": "rifle"
    if (!gun && def.soundKey) gun = table[def.soundKey];

    // 3. Weapon TYPE fallback — "weaponType": "rifle" → table.rifle.fire
    if (!gun) {
      const type = getWeaponType(def);
      gun = table[type];
    }

    if (!gun) return null;
    const entry = gun[slot];
    if (!entry || !entry.url) return null;
    return entry;
  }

  let lastEmptySoundAt = 0;
  const EMPTY_SOUND_THROTTLE_MS = 150;

  function playWeaponSound(def, slot) {
    const entry = getSoundEntry(def, slot);
    if (!entry) return;
    if (entry.loop) return;
    Sfx.play(entry.url, { volume: entry.volume });
  }

  let fireLoopHandle = null;
  let fireLoopUrl = null;

  function startFireLoop() {
    const def = slots[activeSlot];
    const entry = getSoundEntry(def, "fire");
    if (!entry || !entry.loop) return;
    if (fireLoopHandle && fireLoopUrl === entry.url) return;
    stopFireLoop();
    fireLoopHandle = Sfx.play(entry.url, { volume: entry.volume, loop: true });
    fireLoopUrl = entry.url;
  }

  function stopFireLoop() {
    if (fireLoopHandle) Sfx.stop(fireLoopHandle, 0.02);
    fireLoopHandle = null;
    fireLoopUrl = null;
  }

  function deselectActiveSlot() {
    if (activeSlot < 0) return;

    stopFireLoop();

    if (holders[activeSlot] && holders[activeSlot].weaponGroup) {
      holders[activeSlot].weaponGroup.visible = false;
    }

    activeSlot = -1;
    scoped = false;
    scopeT = 0;
    triggerHeld = false;

    inspecting = false;
    inspectAnimT = 1;
    inspectElapsed = 0;
    inspectCyclePhase = 0;
    inspectRestTimer = 0;

    if (H().setWeaponDrivesHands) H().setWeaponDrivesHands(false);
    if (H().updateHeldToolModel) H().updateHeldToolModel();

    if (scopeOverlayEl) scopeOverlayEl.style.opacity = "0";
    if (sightRig) sightRig.visible = false;

    refreshSlotsUI();
    updateCrosshairForWeapon();
  }

  /* =====================================================================
   INLINE SCOPE
   ===================================================================== */
  function modelHasScopeParts(def) {
    if (!def || !Array.isArray(def.model)) return false;
    for (let i = 0; i < def.model.length; i++) {
      const p = def.model[i];
      if (p && p.scope === true) return true;
    }
    return false;
  }

  function getScopeMode(def) {
    if (!def) return "none";
    if (def.scopeMode === "none") return "none";

    if (def.scopeMode === "sniper") return "sniper";
    if (def.hasScope === true) return "sniper";

    if (def.scopeMode === "inline") {
      if (!modelHasScopeParts(def) && !def.inlineLensLocal) return "none";
      return "inline";
    }

    if (
      typeof def.scopeFov === "number" &&
      def.scopeFov <= baseFov * 0.5 &&
      modelHasScopeParts(def)
    ) {
      return "sniper";
    }
    return "none";
  }

  let inlineRT = null;
  let inlineRTCamera = null;
  const INLINE_RT_SIZE = 512;

  function ensureInlineRT() {
    if (inlineRT) return;
    if (typeof THREE === "undefined") return;
    inlineRT = new THREE.WebGLRenderTarget(INLINE_RT_SIZE, INLINE_RT_SIZE, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    });
    inlineRTCamera = new THREE.PerspectiveCamera(8, 1, 0.04, 200);
  }

  let sightRig = null;
  function ensureSightRig() {
    if (sightRig) return sightRig;
    const fpRoot = H().fpRoot;
    if (!fpRoot) return null;
    sightRig = new THREE.Group();
    sightRig.visible = false;
    fpRoot.add(sightRig);
    return sightRig;
  }

  function buildInlineLens(def) {
    ensureInlineRT();
    if (!inlineRT) return null;

    const r =
      typeof def.inlineLensRadius === "number" ? def.inlineLensRadius : 0.013;

    const group = new THREE.Group();

    const baffleGeo = new THREE.CircleGeometry(r * 1.6, 48);
    const baffleMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.DoubleSide,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const baffle = new THREE.Mesh(baffleGeo, baffleMat);
    baffle.position.z = -0.004;
    baffle.renderOrder = 1;
    group.add(baffle);
    group.userData.baffle = baffle;

    const lensGeo = new THREE.CircleGeometry(r, 48);
    const lensMat = new THREE.MeshBasicMaterial({
      map: inlineRT.texture,
      transparent: true,
      opacity: 0,
      fog: false,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.renderOrder = 2;
    lens.visible = false;
    group.add(lens);
    group.userData.lens = lens;

    const p = def.inlineLensLocal || [0, 0.15, -0.075];
    group.position.set(p[0], p[1], p[2]);
    return group;
  }

  function renderInlineRT(def) {
    const g = H();
    const camera = g.camera;
    const scene = g.scene;
    const renderer = g.renderer;
    const fpRoot = g.fpRoot;
    if (!camera || !scene || !renderer || !inlineRTCamera || !inlineRT) return;

    inlineRTCamera.position.copy(camera.position);
    inlineRTCamera.quaternion.copy(camera.quaternion);
    inlineRTCamera.fov =
      typeof def.inlineFov === "number"
        ? def.inlineFov
        : def.scopeFov
          ? def.scopeFov * 0.4
          : 8;
    inlineRTCamera.aspect = 1;
    inlineRTCamera.near = camera.near;
    inlineRTCamera.far = camera.far;
    inlineRTCamera.updateProjectionMatrix();
    inlineRTCamera.updateMatrixWorld(true);

    const prevVis = fpRoot ? fpRoot.visible : null;
    if (fpRoot) fpRoot.visible = false;

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(inlineRT);
    renderer.render(scene, inlineRTCamera);
    renderer.setRenderTarget(prevTarget);

    if (fpRoot && prevVis !== null) fpRoot.visible = prevVis;
  }

  /* ---------------------------------------------------------------------
       State
       --------------------------------------------------------------------- */
  const slots = [null, null];
  const mags = [0, 0];
  const holders = [null, null];

  let activeSlot = -1;
  let triggerHeld = false;
  let scoped = false;
  let scopeT = 0;

  let fireCooldown = 0;
  let fireAnimT = 1;
  let reloadingSlot = -1;

  let reloadTimer = 0;
  let reloadAnimT = 1;

  /* ---- Inspect (Y key) ------------------------------------------- */
  let inspecting = false;
  let inspectAnimT = 1;         // 0..1 — position within ONE cycle
  let inspectDur = 2.4;         // seconds for one full play-through (per weapon)
  let inspectElapsed = 0;       // real seconds since the inspect session began
  let inspectCyclePhase = 0;    // 0..1 progress within the active cycle
  let inspectRestTimer = 0;     // seconds remaining of the inter-cycle rest
  let inspectCycleTime = 2.4;   // this cycle's adjusted duration (with jitter)

  const INSPECT_TIME_MUL = 1.5;

  const INSPECT_REST_MIN = 0.45;
  const INSPECT_REST_MAX = 1.25;

  const INSPECT_LOOP_DURATION = 14;

  /* --- Pistol inspect: keep rolling until the session timer runs out --- */
  const PISTOL_INSPECT_DURATION = 5;   // seconds the pistol keeps spinning
  const PISTOL_SPIN_PERIOD = 0.25; // seconds per full revolution

  /* Per-session inspect state — latched in onInspectKey(). */
  const _inspectCtx = { elapsed: 0, duration: INSPECT_LOOP_DURATION };
  let inspectLoopDuration = INSPECT_LOOP_DURATION;
  let inspectContinuous = false;

  /* ---- Dwell shaper ------------------------------------------------ */
  function dwell(x, k) {
    return Math.tanh(k * x) / Math.tanh(k);
  }

  /* =====================================================================
   INSPECT PROFILES
   ===================================================================== */
  const _insE = new THREE.Euler();
  const _insP = new THREE.Vector3();

  function _qFromEuler(x, y, z) {
    _insE.set(x, y, z, "YXZ");
    return new THREE.Quaternion().setFromEuler(_insE);
  }

  const INSPECT_PROFILES = {

    /* ---------- PISTOL — continuous reversed trigger-guard spin ----------
The pistol rolls around the trigger guard for the ENTIRE inspect
session (≈ one turn every PISTOL_SPIN_PERIOD seconds) instead of a
single snap-spin.  The roll eases out over the last quarter so the
gun lands square, and the left hand drops naturally out of the way
as the gun comes up, then returns to the grip as the gun settles. */
    pistol: function (t, def, ctx) {
      const dur = (ctx && ctx.duration) || PISTOL_INSPECT_DURATION;

      /* Whole number of turns so the gun finishes unrotated. */
      const turns = Math.max(1, Math.round(dur / PISTOL_SPIN_PERIOD));

      /* Linear while spinning, then a matched-slope ease-out over the
         final 25% — the roll decelerates smoothly into place. */
      let spinT;
      if (t < 0.75) {
        spinT = t;
      } else {
        const u = (t - 0.75) / 0.25;
        spinT = 0.75 + 0.25 * (u + u * u - u * u * u);
      }

      /* NEGATIVE angle → reversed roll around +X. */
      const spin = -spinT * turns * Math.PI * 2;

      /* Hand lifts off the grip early, stays clear while the pistol
         spins, then comes back on as the gun settles. */
      const rise = Math.min(
        smoothstep(t, 0.02, 0.16),
        1 - smoothstep(t, 0.84, 0.98),
      );

      return {
        dPos: [0, rise * 0.10, rise * 0.03],

        /* Reversed forward roll around the trigger guard. */
        quat: new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(1, 0, 0),
          spin,
        ),
        pivot: [0, -0.02, -0.06],

        handL: {
          freezeAtBase: true,
          dPos: [-rise * 0.10, -rise * 0.18, -rise * 0.04],
          dQuat: _qFromEuler(
            -rise * 0.40,
            rise * 0.15,
            rise * 0.30,
          ),
        },

        /* Right hand stays anchored at its canonical grip — the
           pistol spins inside the palm. */
        handR: { freezeAtBase: true },
      };
    },

    smg: function (t) {
      const rise = Math.sin(t * Math.PI);
      const viewT = smoothstep(t, 0.10, 0.90);
      const sweep = Math.sin(viewT * Math.PI * 2);
      const yaw = dwell(sweep, 4) * 0.85;
      const roll = dwell(sweep, 4) * 0.15;

      const swayY = Math.sin(t * Math.PI * 3) * 0.010;
      const swayZ = Math.cos(t * Math.PI * 2) * 0.008;
      const rollL = Math.sin(t * Math.PI * 2) * 0.06;
      const rollR = Math.sin(t * Math.PI * 2 + 1.4) * 0.05;

      return {
        dPos: [0, rise * 0.09, rise * 0.04],
        quat: _qFromEuler(rise * 0.15, yaw, roll),
        pivot: null,
        handFollow: 0.45,
        handL: {
          dPos: [0, swayY, swayZ],
          dQuat: _qFromEuler(0, 0, rollL),
        },
        handR: {
          dPos: [0, -swayY * 0.6, swayZ * 0.5],
          dQuat: _qFromEuler(0, 0, rollR),
        },
      };
    },

    shotgun: function (t) {
      const rise = Math.sin(t * Math.PI);

      const showT = Math.min(
        smoothstep(t, 0.10, 0.30),
        1 - smoothstep(t, 0.72, 0.92),
      );
      const yaw = showT * -1.15;
      const roll = showT * 0.30;

      const pumpBack = Math.max(
        0,
        Math.sin(Math.max(0, (t - 0.35) / 0.40) * Math.PI),
      );

      const rollR = Math.sin(t * Math.PI * 2) * 0.05;

      return {
        dPos: [0, rise * 0.06, rise * 0.02],
        quat: _qFromEuler(rise * 0.10, yaw, roll),
        pivot: null,
        handFollow: 0.55,
        handL: {
          dPos: [0, 0, pumpBack * 0.14],
          dQuat: null,
        },
        handR: {
          dPos: [0, 0, 0],
          dQuat: _qFromEuler(0, 0, rollR),
        },
      };
    },

    sniper: function (t) {
      const rise = Math.sin(t * Math.PI);
      const viewT = smoothstep(t, 0.05, 0.95);
      const sweep = Math.sin(viewT * Math.PI * 2);
      const yaw = dwell(sweep, 4) * 0.70;
      const roll = dwell(sweep, 4) * 0.10;

      const reach = Math.max(
        0,
        Math.sin(Math.max(0, (t - 0.30) / 0.40) * Math.PI),
      );

      const breathY = Math.sin(t * Math.PI * 2) * 0.006;
      const rollR = Math.sin(t * Math.PI * 1.5) * 0.04;

      return {
        dPos: [0, rise * 0.08, rise * 0.03],
        quat: _qFromEuler(rise * 0.12, yaw, roll),
        pivot: null,
        handFollow: 0.35,
        handL: {
          dPos: [-reach * 0.10, reach * 0.05 + breathY, reach * 0.15],
          dQuat: null,
        },
        handR: {
          dPos: [0, breathY * 0.5, 0],
          dQuat: _qFromEuler(0, 0, rollR),
        },
      };
    },

    rifle: function (t) {
      const rise = Math.sin(t * Math.PI);
      const viewT = smoothstep(t, 0.10, 0.90);
      const sweep = Math.sin(viewT * Math.PI * 2);
      const yaw = dwell(sweep, 4) * 0.75;
      const roll = dwell(sweep, 4) * 0.12;

      const swayY = Math.sin(t * Math.PI * 3) * 0.010;
      const swayZ = Math.cos(t * Math.PI * 2) * 0.008;
      const rollL = Math.sin(t * Math.PI * 2) * 0.06;
      const rollR = Math.sin(t * Math.PI * 2 + 1.4) * 0.05;

      return {
        dPos: [0, rise * 0.08, rise * 0.04],
        quat: _qFromEuler(rise * 0.15, yaw, roll),
        pivot: null,
        handFollow: 0.42,
        handL: {
          dPos: [0, swayY, swayZ],
          dQuat: _qFromEuler(0, 0, rollL),
        },
        handR: {
          dPos: [0, -swayY * 0.6, swayZ * 0.5],
          dQuat: _qFromEuler(0, 0, rollR),
        },
      };
    },
  };

  function getInspectProfile(def) {
    if (!def) return INSPECT_PROFILES.rifle;

    /* Explicit override wins — a rifle can opt into the shotgun-style
       inspect by setting "inspectProfile": "shotgun" in its JSON. */
    if (def.inspectProfile && INSPECT_PROFILES[def.inspectProfile]) {
      return INSPECT_PROFILES[def.inspectProfile];
    }

    const type = getWeaponType(def);
    return INSPECT_PROFILES[type] || INSPECT_PROFILES.rifle;
  }

  /* ---- Physical gun-body recoil ---------------------------------- */
  let recoilTravel = 0;
  let recoilTravelVel = 0;
  let _prevRecoilTravel = 0;

  const RECOIL_K = 900;
  const RECOIL_C = 45;
  const RECOIL_IMPULSE = 30;

  const DEFAULT_AIM_TRAVEL_MUL = 1.5;

  let baseFov = 76;

  const RECOIL_PERSIST_FRACTION = 0.45;
  const RECOIL_RECOVER_RATE = 5.0;

  let recoilPitchRecover = 0;
  let recoilYawRecover = 0;

  const bullets = [];
  const impacts = [];

  /* ---------------------------------------------------------------------
       Weapon-bar UI
       --------------------------------------------------------------------- */
  let weaponBarEl = null;
  const slotEls = [];

  let scopeOverlayEl = null;
  function getScopeOverlay() {
    if (scopeOverlayEl) return scopeOverlayEl;
    scopeOverlayEl = document.getElementById("scopeOverlay");
    if (!scopeOverlayEl) {
      scopeOverlayEl = document.createElement("div");
      scopeOverlayEl.id = "scopeOverlay";
      scopeOverlayEl.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:5;" +
        "background:radial-gradient(circle at center," +
        "  transparent 38%, rgba(0,0,0,0.98) 46%);" +
        "opacity:0;transition:opacity .06s linear;";
      document.body.appendChild(scopeOverlayEl);
    }
    return scopeOverlayEl;
  }

  function buildWeaponBar() {
    if (weaponBarEl) return;
    weaponBarEl = document.createElement("div");
    weaponBarEl.id = "weaponBar";
    weaponBarEl.style.cssText =
      "position:fixed;left:50%;bottom:114px;transform:translateX(-50%);" +
      "display:flex;gap:14px;z-index:5;pointer-events:none;" +
      'font-family:"Courier New",monospace;';
    document.body.appendChild(weaponBarEl);

    for (let i = 0; i < MAX_SLOTS; i++) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:110px;height:36px;background:#12161d;" +
        "border:2px solid #3a2e26;" +
        "box-shadow:inset 0 0 0 1px #05070a;" +
        'font:bold 10px "Courier New",monospace;letter-spacing:1px;' +
        "display:flex;align-items:center;justify-content:center;" +
        "position:relative;transition:border-color .12s,color .12s,opacity .15s;";
      weaponBarEl.appendChild(el);
      slotEls.push(el);
    }
  }

  /* =====================================================================
       AMMO SOURCE OF TRUTH
       ===================================================================== */
  function getInventoryAmmo(type) {
    if (!type) return 0;
    const inv = H().getInventory && H().getInventory();
    if (!inv || !Array.isArray(inv.items)) return 0;
    const want = canonAmmo(type);
    let total = 0;
    for (let i = 0; i < inv.items.length; i++) {
      const it = inv.items[i];
      if (!it) continue;
      if (!it.isAmmo && !it.ammoType) continue;
      if (canonAmmo(it.ammoType) !== want) continue;
      total += typeof it.count === "number" ? it.count : 0;
    }
    return total;
  }

  function consumeInventoryAmmo(type, amount) {
    const inv = H().getInventory && H().getInventory();
    if (!inv || !Array.isArray(inv.items) || amount <= 0) return 0;

    const want = canonAmmo(type);
    let need = amount;
    let taken = 0;

    for (let i = inv.items.length - 1; i >= 0 && need > 0; i--) {
      const it = inv.items[i];
      if (!it) continue;
      if (!it.isAmmo && !it.ammoType) continue;
      if (canonAmmo(it.ammoType) !== want) continue;
      const have = typeof it.count === "number" ? it.count : 0;
      if (have <= 0) continue;
      const take = Math.min(have, need);
      it.count -= take;
      need -= take;
      taken += take;
      if (it.count <= 0) inv.items.splice(i, 1);
    }

    if (taken > 0) {
      if (typeof inv.render === "function") inv.render();
      if (typeof inv._emitChange === "function") inv._emitChange();
    }
    return taken;
  }

  let _ammoUiCache = "";

  function refreshSlotsUI() {
    buildWeaponBar();
    for (let i = 0; i < MAX_SLOTS; i++) {
      const el = slotEls[i];
      if (!el) continue;
      const def = slots[i];
      const active = i === activeSlot;

      el.style.borderColor = active ? "#e8c86a" : "#3a2e26";
      el.style.color = active ? "#f6dd8b" : "#a89a84";

      if (!def) {
        el.innerHTML =
          '<span style="opacity:.5">' + (i + 1) + " · EMPTY</span>";
        continue;
      }

      const m = mags[i];
      const pool = getInventoryAmmo(def.ammoType);

      el.innerHTML =
        '<span style="position:absolute;top:1px;left:4px;font-size:8px;' +
        "color:" +
        (active ? "#f6dd8b" : "#6a5a44") +
        ';">' +
        (i + 1) +
        "</span>" +
        '<span style="font-size:11px;color:' +
        (active ? "#f6dd8b" : "#c8b88a") +
        ';">' +
        (def.icon || "◉") +
        " " +
        (def.name || "?") +
        "</span>" +
        '<span style="position:absolute;bottom:1px;right:5px;font-size:10px;' +
        "color:" +
        (m === 0 ? "#d04030" : "#e8c86a") +
        ';">' +
        m +
        " / " +
        pool +
        "</span>";
    }

    const parts = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const d = slots[i];
      parts.push(
        d
          ? d.ammoType + ":" + getInventoryAmmo(d.ammoType) + ":" + mags[i]
          : "-",
      );
    }
    _ammoUiCache = parts.join("|");
  }

  function refreshSlotsUIIfInventoryChanged() {
    const parts = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      const d = slots[i];
      parts.push(
        d
          ? d.ammoType + ":" + getInventoryAmmo(d.ammoType) + ":" + mags[i]
          : "-",
      );
    }
    if (parts.join("|") !== _ammoUiCache) refreshSlotsUI();
  }

  /* ---------------------------------------------------------------------
       Weapon rig
       --------------------------------------------------------------------- */
  let weaponRig = null;

  function ensureWeaponRig() {
    if (weaponRig) return;
    const fpRoot = H().fpRoot;
    if (!fpRoot) return;
    weaponRig = new THREE.Group();
    fpRoot.add(weaponRig);
  }

  function buildWeaponMesh(def) {
    const group = new THREE.Group();
    const scopeGroup = new THREE.Group();
    scopeGroup.visible = true;
    group.add(scopeGroup);

    for (const part of def.model) {
      const geo = new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
      const col = typeof part.c === "number" ? part.c : 0x808080;
      const mat = new THREE.MeshLambertMaterial({ color: col, fog: true });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(part.p[0], part.p[1], part.p[2]);
      if (part.r) m.rotation.set(part.r[0], part.r[1], part.r[2]);

      if (part.scope === true) scopeGroup.add(m);
      else group.add(m);
    }

    const muzzle = new THREE.Object3D();
    const ml = def.muzzleLocal || [0, 0, -0.3];
    muzzle.position.set(ml[0], ml[1], ml[2]);
    group.add(muzzle);

    return { group, muzzle, scopeGroup };
  }

  function attachWeapon(slotIdx) {
    ensureWeaponRig();
    if (!weaponRig) return;
    const def = slots[slotIdx];
    if (!def) return;

    detachWeapon(slotIdx);

    const { group, muzzle, scopeGroup } = buildWeaponMesh(def);
    group.visible = false;

    weaponRig.add(group);
    holders[slotIdx] = { weaponGroup: group, muzzle, def, scopeGroup };

    if (getScopeMode(def) === "inline") {
      ensureSightRig();
      const lensGroup = buildInlineLens(def);
      if (lensGroup) holders[slotIdx].inlineLens = lensGroup;
    }
  }

  function detachWeapon(slotIdx) {
    const h = holders[slotIdx];
    if (!h) return;
    if (h.weaponGroup.parent) h.weaponGroup.parent.remove(h.weaponGroup);
    h.weaponGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => m.dispose());
      }
    });
    if (h.inlineLens) {
      if (h.inlineLens.parent) h.inlineLens.parent.remove(h.inlineLens);
      h.inlineLens.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    holders[slotIdx] = null;
  }

  /* ---------------------------------------------------------------------
       Pose / animation
       --------------------------------------------------------------------- */
  function computeAdsPose(def) {
    const s = def.sightLocal || [0, 0, 0];
    return {
      p: [-s[0], -s[1], -0.02 - s[2]],
      r: [0, 0, 0],
    };
  }

  const _qTemp = new THREE.Quaternion();
  const _eTemp = new THREE.Euler();
  const _vTemp = new THREE.Vector3();

  function applyGrip(hand, grip, weaponQuat, weaponPos) {
    if (!hand || !grip) return;
    _vTemp.set(grip.p[0], grip.p[1], grip.p[2]).applyQuaternion(weaponQuat);
    hand.position.copy(weaponPos).add(_vTemp);
    _eTemp.set(grip.r[0], grip.r[1], grip.r[2]);
    _qTemp.setFromEuler(_eTemp);
    hand.quaternion.copy(weaponQuat).multiply(_qTemp);
  }

  /* ============================================================
     Blend a hand's grip pose between the pre-animation rig and
     the current (post-inspect-animation) rig.
     ============================================================ */
  const _blendQuat = new THREE.Quaternion();
  const _blendPos = new THREE.Vector3();

  function applyGripBlended(hand, grip, follow, baseQuat, basePos) {
    if (!hand || !grip) return;

    if (follow >= 1 || !baseQuat || !basePos) {
      applyGrip(hand, grip, weaponRig.quaternion, weaponRig.position);
      return;
    }

    const f = Math.max(0, follow);

    _blendQuat.copy(baseQuat).slerp(weaponRig.quaternion, f);
    _blendPos.lerpVectors(basePos, weaponRig.position, f);

    _vTemp.set(grip.p[0], grip.p[1], grip.p[2]).applyQuaternion(_blendQuat);
    hand.position.copy(_blendPos).add(_vTemp);

    _eTemp.set(grip.r[0], grip.r[1], grip.r[2]);
    _qTemp.setFromEuler(_eTemp);
    hand.quaternion.copy(_blendQuat).multiply(_qTemp);
  }

  function weaponHasScope(def) {
    return getScopeMode(def) !== "none";
  }

  function applyPose(slotIdx, dt) {
    const h = holders[slotIdx];
    if (!h || !weaponRig) return;
    const def = h.def;
    let insOver = null;
    let baseWeaponQuat = null;
    let baseWeaponPos = null;

    const g = H();
    const handL = g.handL,
      handR = g.handR;
    const updateArmBones = g.updateArmBones;
    const setWeaponDrivesHands = g.setWeaponDrivesHands;
    if (setWeaponDrivesHands) setWeaponDrivesHands(true);

    const mode = getScopeMode(def);

    const sniperHidden = mode === "sniper" && scopeT >= 0.8;
    const gunHidden = def.hideWeaponOnAds === true && scopeT >= 0.8;
    if (h.weaponGroup) h.weaponGroup.visible = !(sniperHidden || gunHidden);

    if (h.scopeGroup) {
      const scopeHidden =
        def.hideScopeOnAds === true && scopeT >= 0.8 && mode === "inline";
      h.scopeGroup.visible = !scopeHidden;
    }

    if (mode === "sniper") {
      const ovl = getScopeOverlay();
      const t = Math.max(0, Math.min(1, (scopeT - 0.6) * 2.5));
      ovl.style.opacity = t.toFixed(2);
    } else if (scopeOverlayEl) {
      scopeOverlayEl.style.opacity = "0";
    }

    const hip = def.hipPose || def.heldPose;
    const ads = def.adsPose || computeAdsPose(def);

    const basePX = hip.p[0] + (ads.p[0] - hip.p[0]) * scopeT;
    const basePY = hip.p[1] + (ads.p[1] - hip.p[1]) * scopeT;
    const basePZ = hip.p[2] + (ads.p[2] - hip.p[2]) * scopeT;
    const baseRX = hip.r[0] + (ads.r[0] - hip.r[0]) * scopeT;
    const baseRY = hip.r[1] + (ads.r[1] - hip.r[1]) * scopeT;
    const baseRZ = hip.r[2] + (ads.r[2] - hip.r[2]) * scopeT;

    weaponRig.position.set(basePX, basePY, basePZ);
    weaponRig.rotation.set(baseRX, baseRY, baseRZ);

    baseWeaponQuat = weaponRig.quaternion.clone();
    baseWeaponPos = weaponRig.position.clone();

    if (sightRig) {
      if (mode === "inline") {
        if (h.inlineLens && h.inlineLens.parent !== sightRig) {
          for (let i = sightRig.children.length - 1; i >= 0; i--) {
            sightRig.remove(sightRig.children[i]);
          }
          sightRig.add(h.inlineLens);
        }
        sightRig.visible = scopeT > 0.3;
        sightRig.position.set(basePX, basePY, basePZ);
        sightRig.rotation.set(baseRX, baseRY, baseRZ);
      } else {
        sightRig.visible = false;
      }
    }

    if (h.inlineLens) {
      const lo = Math.max(0, Math.min(1, (scopeT - 0.3) * 3.33));
      const lensMesh = h.inlineLens.userData.lens;
      const baffleMesh = h.inlineLens.userData.baffle;
      if (lensMesh) {
        lensMesh.material.opacity = lo;
        lensMesh.visible = lo > 0.01;
      }
      if (baffleMesh) {
        baffleMesh.material.opacity = lo;
        baffleMesh.visible = lo > 0.01;
      }
    }

    const fireBell = fireAnimT < 1 ? Math.sin(fireAnimT * Math.PI) : 0;
    const kc = def.anim ? def.anim.kick : 0.04;
    weaponRig.position.z += fireBell * kc;
    weaponRig.rotation.x += fireBell * (def.anim ? def.anim.swing : 0.1);

    weaponRig.position.z += recoilTravel;

    /* ---- Inspect animation (Y key) --------------------------------- */
    insOver = null;
    if (inspecting && inspectAnimT < 1) {
      const profile = getInspectProfile(def);
      if (profile) {
        _inspectCtx.elapsed = inspectElapsed;
        _inspectCtx.duration = inspectLoopDuration;
        insOver = profile(inspectAnimT, def, _inspectCtx);

        if (insOver.dPos) {
          weaponRig.position.x += insOver.dPos[0];
          weaponRig.position.y += insOver.dPos[1];
          weaponRig.position.z += insOver.dPos[2];
        }

        if (insOver.quat) {
          if (insOver.pivot) {
            _insP.set(insOver.pivot[0], insOver.pivot[1], insOver.pivot[2]);
            _insP.applyQuaternion(weaponRig.quaternion).add(weaponRig.position);

            const rel = weaponRig.position.clone().sub(_insP);
            rel.applyQuaternion(insOver.quat);
            weaponRig.position.copy(_insP).add(rel);
            weaponRig.quaternion.premultiply(insOver.quat);
          } else {
            weaponRig.quaternion.premultiply(insOver.quat);
          }
        }
      }
    }

    if (reloadingSlot === slotIdx && reloadAnimT < 1) {
      const p = reloadAnimT;

      const gunHold = Math.min(
        smoothstep(p, 0.05, 0.15),
        1 - smoothstep(p, 0.68, 0.88),
      );
      weaponRig.position.x += gunHold * 0.02;
      weaponRig.position.y -= gunHold * 0.08;
      weaponRig.position.z += gunHold * 0.05;
      weaponRig.rotation.x -= gunHold * 0.55;
      weaponRig.rotation.z += gunHold * 0.35;

      const rack = Math.min(
        smoothstep(p, 0.55, 0.6),
        1 - smoothstep(p, 0.63, 0.69),
      );
      weaponRig.position.z -= rack * 0.03;
      weaponRig.rotation.x += rack * 0.3;
    }

    const inspectFollow =
      insOver && typeof insOver.handFollow === "number"
        ? insOver.handFollow
        : 1;

    applyGripBlended(handR, def.gripR, inspectFollow, baseWeaponQuat, baseWeaponPos);
    applyGripBlended(handL, def.gripL, inspectFollow, baseWeaponQuat, baseWeaponPos);

    /* ---- Inspect hand overrides ------------------------------------ */
    if (insOver) {
      const freezeHand = (hand, grip) => {
        if (!hand || !grip || !baseWeaponQuat) return;
        _vTemp
          .set(grip.p[0], grip.p[1], grip.p[2])
          .applyQuaternion(baseWeaponQuat);
        hand.position.copy(baseWeaponPos).add(_vTemp);
        _eTemp.set(grip.r[0], grip.r[1], grip.r[2]);
        _qTemp.setFromEuler(_eTemp);
        hand.quaternion.copy(baseWeaponQuat).multiply(_qTemp);
      };

      /* When a hand is frozen (freezeAtBase), its additive dPos must
         be expressed in the FROZEN frame (baseWeaponQuat), not the
         animated one.  Otherwise a tiny idle sway would orbit around
         the spin axis instead of wobbling in place. */
      const handDeltaQuat = (hh) =>
        hh && hh.freezeAtBase && baseWeaponQuat
          ? baseWeaponQuat
          : weaponRig.quaternion;

      if (insOver.handL) {
        if (insOver.handL.freezeAtBase) freezeHand(handL, def.gripL);
        if (insOver.handL.dPos) {
          _vTemp
            .set(
              insOver.handL.dPos[0],
              insOver.handL.dPos[1],
              insOver.handL.dPos[2],
            )
            .applyQuaternion(handDeltaQuat(insOver.handL));
          handL.position.add(_vTemp);
        }
        if (insOver.handL.dQuat) {
          handL.quaternion.premultiply(insOver.handL.dQuat);
        }
      }
      if (insOver.handR) {
        if (insOver.handR.freezeAtBase) freezeHand(handR, def.gripR);
        if (insOver.handR.dPos) {
          _vTemp
            .set(
              insOver.handR.dPos[0],
              insOver.handR.dPos[1],
              insOver.handR.dPos[2],
            )
            .applyQuaternion(handDeltaQuat(insOver.handR));
          handR.position.add(_vTemp);
        }
        if (insOver.handR.dQuat) {
          handR.quaternion.premultiply(insOver.handR.dQuat);
        }
      }
    }

    if (reloadingSlot === slotIdx && reloadAnimT < 1) {
      const p = reloadAnimT;

      const lhOut = Math.min(
        smoothstep(p, 0.12, 0.24),
        1 - smoothstep(p, 0.55, 0.72),
      );
      const lhPull = Math.min(
        smoothstep(p, 0.3, 0.38),
        1 - smoothstep(p, 0.44, 0.54),
      );

      _vTemp
        .set(lhOut * 0.015, -(lhOut * 0.06 + lhPull * 0.05), lhOut * 0.09)
        .applyQuaternion(weaponRig.quaternion);
      handL.position.add(_vTemp);

      _eTemp.set(lhOut * 0.35 + lhPull * 0.2, lhOut * -0.25, lhOut * 0.2);
      _qTemp.setFromEuler(_eTemp);
      handL.quaternion.multiply(_qTemp);
    }

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
    const t1 = (cx - hw - origin.x) * ix,
      t2 = (cx + hw - origin.x) * ix;
    const t3 = (cy - hh - origin.y) * iy,
      t4 = (cy + hh - origin.y) * iy;
    const t5 = (cz - hd - origin.z) * iz,
      t6 = (cz + hd - origin.z) * iz;
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

    if (mags[activeSlot] <= 0) {
      fireCooldown = 0.25;
      return;
    }
    if (!(window.ARiveSandboxFlags && window.ARiveSandboxFlags.infiniteAmmo)) {
      mags[activeSlot]--;
    }

    playWeaponSound(def, "fire");

    const pelletCount = getPelletCount(def);
    const origin = cam.position.clone();
    const spreadMul = 1 - 0.75 * scopeT;
    const sp = (def.spread || 0) * spreadMul;

    const muzzleWorld = new THREE.Vector3();
    h.muzzle.getWorldPosition(muzzleWorld);

    const baseDir = g.getLookDir().clone();
    const upV = new THREE.Vector3(0, 1, 0);
    const rightV = new THREE.Vector3().crossVectors(baseDir, upV).normalize();
    const realUpV = new THREE.Vector3()
      .crossVectors(rightV, baseDir)
      .normalize();

    let bestEndPoint = null;
    let bestDist = -1;

    for (let p = 0; p < pelletCount; p++) {
      const dir = baseDir.clone();
      if (sp > 0) {
        dir.addScaledVector(rightV, (Math.random() - 0.5) * 2 * sp);
        dir.addScaledVector(realUpV, (Math.random() - 0.5) * 2 * sp);
        dir.normalize();
      }

      const hitVoxel = g.raycastVoxel(origin, dir, MAX_RANGE);
      const enemies = g.enemies || [];
      let hitEnemy = null;
      let hitT = hitVoxel ? hitVoxel.t : MAX_RANGE;

      for (const e of enemies) {
        if (!e.alive) continue;
        /* Read the hit-box from the enemy's own model so a small
           runner is not treated as a walker-sized target and a
           brute is not under-sized.  Falls back to walker defaults
           if the model is missing the fields (older saves). */
        const m = e.model || {};
        const cy = (m.hitCenterY != null) ? m.hitCenterY : 0.85;
        const hw = (m.hitHW != null) ? m.hitHW : 0.36;
        const hh = (m.hitHH != null) ? m.hitHH : 0.85;

        const t = rayAABB(
          origin,
          dir,
          e.pos.x,
          e.pos.y + cy,
          e.pos.z,
          hw,
          hh,
          hw,
          hitT,
        );
        if (t !== null && t < hitT) {
          hitT = t;
          hitEnemy = e;
        }
      }

      /* ── Remote player ray test (PvP) ───────────────────────────────
   Only counts if the player is CLOSER than the current best hit,
   so an enemy or wall in front of them absorbs the bullet as usual. */
      let hitRemotePeer = null;
      if (window.ARiveMP && window.ARiveMP.raycastRemotePlayers) {
        const rpHit = window.ARiveMP.raycastRemotePlayers(
          origin.x, origin.y, origin.z,
          dir.x, dir.y, dir.z,
          hitT                          // stop the search at the current best
        );
        if (rpHit && rpHit.t < hitT) {
          hitT = rpHit.t;
          hitRemotePeer = rpHit.peerId;
        }
      }

      let endPoint;
      if (hitRemotePeer) {
        endPoint = origin.clone().addScaledVector(dir, hitT);
        if (window.ARiveMP.dispatchPvpHit) {
          window.ARiveMP.dispatchPvpHit(hitRemotePeer, def.damage, endPoint.x, endPoint.y, endPoint.z);
        }
        spawnImpact(endPoint, 0xff5050, true);
      } else
        
        if (hitEnemy) {
          endPoint = origin.clone().addScaledVector(dir, hitT);

          /* Route the bullet through the exact-impact entry point so the
             carved voxel is the pixel the shot actually landed on, not a
             random surface pick.  Falls back to the old hurtEnemy path
             if enemy.js didn't expose hitEnemyRay for some reason. */
          let routed = false;
          if (g.hitEnemyRay) {
            routed = g.hitEnemyRay(
              endPoint.x, endPoint.y, endPoint.z,
              def.damage,
              dir.x, dir.y, dir.z,
              def.carveRadius,          // ← 新增
            );
          }
          if (!routed && g.hurtEnemy) g.hurtEnemy(hitEnemy, def.damage, def.carveRadius);

          spawnImpact(endPoint, 0xff5050, true);
        } else if (hitVoxel) {
          endPoint = origin.clone().addScaledVector(dir, hitVoxel.t);
          const cx = hitVoxel.x + hitVoxel.nx;
          const cy = hitVoxel.y + hitVoxel.ny;
          const cz = hitVoxel.z + hitVoxel.nz;
          /* Per-weapon block-breaking power.  Falls back to the old 1.1 radius
             if the JSON doesn't set it, so old weapons keep working. */
          const carveRadius = (typeof def.carveRadius === "number" && def.carveRadius > 0)
            ? def.carveRadius : 1.1;
          const carveDebris = (typeof def.carveDebris === "number")
            ? def.carveDebris : 0.12;
          const carvePenetrate = (def.carvePenetrate === true);

          if (g.carveSphere) {
            g.carveSphere(cx, cy, cz, carveRadius, { debrisChance: carveDebris });
          }
          if (g.net && g.net.sendCarve) {
            g.net.sendCarve(cx, cy, cz, carveRadius, carvePenetrate);
          }
          spawnImpact(endPoint, def.bulletColor, false);
        } else {
          endPoint = origin.clone().addScaledVector(dir, MAX_RANGE);
        }

      const d = origin.distanceTo(endPoint);
      if (d > bestDist) {
        bestDist = d;
        bestEndPoint = endPoint;
      }
    }

    if (bestEndPoint) spawnTracer(muzzleWorld, bestEndPoint, def);
    spawnMuzzleFlash(muzzleWorld, def);

    const adsRecoilMul =
      typeof def.adsRecoilMul === "number" ? def.adsRecoilMul : 0.3;
    const recoilScale = 1 - (1 - adsRecoilMul) * scopeT;

    const kick = (def.recoilKick || 0.025) * recoilScale;

    const yawKickMag =
      (typeof def.recoilYawKick === "number"
        ? def.recoilYawKick
        : (def.recoilKick || 0.025) * 0.4) * recoilScale;

    const yawKick = (Math.random() * 2 - 1) * yawKickMag;

    const player = g.player;
    if (player) {
      player.pitch += kick;
      player.targetYaw += yawKick;
      recoilPitchRecover += kick * (1 - RECOIL_PERSIST_FRACTION);
      recoilYawRecover += yawKick * (1 - RECOIL_PERSIST_FRACTION);
    }

    const adsShakeMul =
      typeof def.adsShakeMul === "number"
        ? def.adsShakeMul
        : adsRecoilMul * 0.4;
    const shakeScale = 1 - (1 - adsShakeMul) * scopeT;
    if (g.shakeCamera) g.shakeCamera(0.055 * shakeScale);

    const travel =
      def.anim && typeof def.anim.recoilTravel === "number"
        ? def.anim.recoilTravel
        : def.anim && typeof def.anim.kick === "number"
          ? def.anim.kick
          : 0.04;
    recoilTravelVel += travel * RECOIL_IMPULSE;

    fireCooldown = def.fireRate || 0.2;
    fireAnimT = 0;

    // MP: broadcast a single visual tracer per trigger pull.  We only send
    // the *best* endpoint (longest pellet flight) — shotguns feel right
    // with one streak on the receiving side without spamming the wire.
    if (bestEndPoint && window.ARiveMP && window.ARiveMP.onLocalWeaponShot) {
      try {
        window.ARiveMP.onLocalWeaponShot({
          fx: muzzleWorld.x, fy: muzzleWorld.y, fz: muzzleWorld.z,
          tx: bestEndPoint.x, ty: bestEndPoint.y, tz: bestEndPoint.z,
          c: def.bulletColor || 0xffddaa,
          s: def.bulletSize || 0.03,
        });
      } catch (e) { }
    }

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
    bullets.push({ mesh, life: 0.055, maxLife: 0.055 });
  }

  function spawnMuzzleFlash(pos, def) {
    const scene = H().scene;
    if (!scene) return;
    const geo = new THREE.SphereGeometry(0.1, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      color: def.bulletColor || 0xffddaa,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    scene.add(mesh);
    impacts.push({ mesh, life: 0.05, maxLife: 0.05, grow: 3.8 });
  }

  function spawnImpact(pos, color, isEnemy) {
    const scene = H().scene;
    if (!scene) return;
    const c = isEnemy ? 0xff4040 : color || 0xffddaa;
    const geo = new THREE.SphereGeometry(0.075, 6, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
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
    if (getInventoryAmmo(def.ammoType) <= 0) return;

    inspecting = false;
    inspectAnimT = 1;
    inspectElapsed = 0;
    inspectCyclePhase = 0;
    inspectRestTimer = 0;

    stopFireLoop();
    playWeaponSound(def, "reload");
    reloadingSlot = activeSlot;
    reloadTimer = def.reloadTime || 1.5;
    reloadAnimT = 0;
  }

  function finishReload() {
    const def = slots[reloadingSlot];
    if (!def) {
      reloadingSlot = -1;
      return;
    }

    const need = def.magSize - mags[reloadingSlot];
    const take = consumeInventoryAmmo(def.ammoType, need);

    mags[reloadingSlot] += take;
    reloadingSlot = -1;
    reloadAnimT = 1;
    refreshSlotsUI();
  }

  /* ---------------------------------------------------------------------
       Update
       --------------------------------------------------------------------- */
  function update(dt) {
    refreshSlotsUIIfInventoryChanged();

    if (fireCooldown > 0) fireCooldown -= dt;
    if (fireAnimT < 1) fireAnimT = Math.min(1, fireAnimT + dt * 9);

    if (reloadingSlot >= 0) {
      reloadTimer -= dt;
      if (reloadTimer <= 0) {
        finishReload();
      } else {
        const def = slots[reloadingSlot];
        const total = (def && def.reloadTime) || 1.5;
        reloadAnimT = Math.max(0, Math.min(1, 1 - reloadTimer / total));
      }
    } else if (reloadAnimT < 1) {
      reloadAnimT = Math.min(1, reloadAnimT + dt * 3);
    }

    /* ---- Inspect animation tick ------------------------------------ */
    if (inspecting) {
      inspectElapsed += dt;
      if (inspectElapsed >= inspectLoopDuration) {
        inspecting = false;
        inspectElapsed = 0;
        inspectAnimT = 1;
        inspectCyclePhase = 0;
        inspectRestTimer = 0;
      } else if (inspectContinuous) {
        /* One long cycle, no rests — the spin never pauses. */
        inspectCyclePhase = inspectElapsed / inspectLoopDuration;
        inspectAnimT = inspectCyclePhase;
      } else if (inspectRestTimer > 0) {
        inspectRestTimer -= dt;
        inspectAnimT = 1;
        if (inspectRestTimer <= 0) {
          inspectCyclePhase = 0;
          const jitter = 0.85 + Math.random() * 0.30;
          inspectCycleTime = Math.max(
            0.6,
            inspectDur * INSPECT_TIME_MUL * jitter,
          );
        }
      } else {
        inspectCyclePhase += dt / inspectCycleTime;
        if (inspectCyclePhase >= 1) {
          inspectCyclePhase = 1;
          inspectAnimT = 1;
          inspectRestTimer =
            INSPECT_REST_MIN +
            Math.random() * (INSPECT_REST_MAX - INSPECT_REST_MIN);
        } else {
          inspectAnimT = inspectCyclePhase;
        }
      }
    }

    const wantScope = scoped && activeSlot >= 0 && reloadingSlot < 0;
    const targetScopeT = wantScope ? 1 : 0;
    scopeT += (targetScopeT - scopeT) * Math.min(1, dt * 12);
    if (scopeT < 0.001) scopeT = 0;

    const cam = H().camera;
    if (cam) {
      const def = activeSlot >= 0 ? slots[activeSlot] : null;
      const mode = def ? getScopeMode(def) : "none";
      const targetFov =
        def && wantScope && mode === "sniper" ? def.scopeFov || 55 : baseFov;
      const cur = cam.fov + (targetFov - cam.fov) * Math.min(1, dt * 12);
      if (Math.abs(cur - cam.fov) > 0.005) {
        cam.fov = cur;
        cam.updateProjectionMatrix();
      }
    }

    if (recoilPitchRecover !== 0) {
      const mag = Math.abs(recoilPitchRecover);
      const step = Math.min(mag, dt * RECOIL_RECOVER_RATE) *
        Math.sign(recoilPitchRecover);
      const player = H().player;
      if (player) player.pitch -= step;
      recoilPitchRecover -= step;
      if (Math.abs(recoilPitchRecover) < 1e-5) recoilPitchRecover = 0;
    }
    if (recoilYawRecover !== 0) {
      const mag = Math.abs(recoilYawRecover);
      const step = Math.min(mag, dt * RECOIL_RECOVER_RATE) *
        Math.sign(recoilYawRecover);
      const player = H().player;
      if (player) player.targetYaw -= step;
      recoilYawRecover -= step;
      if (Math.abs(recoilYawRecover) < 1e-5) recoilYawRecover = 0;
    }

    if (triggerHeld && activeSlot >= 0 && reloadingSlot < 0) {
      const def = slots[activeSlot];
      if (def && def.auto && fireCooldown <= 0 && mags[activeSlot] > 0) {
        fireOneShot();
      }
    }

    {
      const loopDef = activeSlot >= 0 ? slots[activeSlot] : null;
      const loopEntry = loopDef ? getSoundEntry(loopDef, "fire") : null;
      const wantsLoop = !!(
        loopEntry &&
        loopEntry.loop &&
        triggerHeld &&
        activeSlot >= 0 &&
        reloadingSlot < 0 &&
        mags[activeSlot] > 0
      );
      if (wantsLoop) startFireLoop();
      else stopFireLoop();
    }

    if (activeSlot >= 0) {
      const def = slots[activeSlot];
      const aimMul =
        def && def.anim && typeof def.anim.aimTravelMul === "number"
          ? def.anim.aimTravelMul
          : DEFAULT_AIM_TRAVEL_MUL;

      const travelDelta = recoilTravel - _prevRecoilTravel;
      if (travelDelta !== 0 && aimMul !== 0) {
        const player = H().player;
        if (player) player.pitch += travelDelta * aimMul;
      }
    }
    _prevRecoilTravel = recoilTravel;

    if (activeSlot >= 0) applyPose(activeSlot, dt);
    updateCrosshairForWeapon();

    const activeDef = activeSlot >= 0 ? slots[activeSlot] : null;
    if (activeDef && getScopeMode(activeDef) === "inline" && scopeT > 0.02) {
      renderInlineRT(activeDef);
    }

    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.life -= dt;
      if (b.mesh.material)
        b.mesh.material.opacity = Math.max(0, b.life / b.maxLife) * 0.95;
      if (b.life <= 0) {
        if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        bullets.splice(i, 1);
      }
    }
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
    if (i >= 0 && !slots[i]) return;

    if (activeSlot >= 0) {
      stopFireLoop();
      if (holders[activeSlot] && holders[activeSlot].weaponGroup) {
        holders[activeSlot].weaponGroup.visible = false;
      }
    }

    activeSlot = i;

    inspecting = false;
    inspectAnimT = 1;
    inspectElapsed = 0;
    inspectCyclePhase = 0;
    inspectRestTimer = 0;

    if (activeSlot >= 0 && holders[activeSlot]) {
      holders[activeSlot].weaponGroup.visible = true;
    } else {
      if (H().setWeaponDrivesHands) H().setWeaponDrivesHands(false);
    }

    scoped = false;
    refreshSlotsUI();
    if (H().updateHeldToolModel) H().updateHeldToolModel();
    _crosshairCache = "";
    updateCrosshairForWeapon();
  }

  /* ---------------------------------------------------------------------
       Input entry points
       --------------------------------------------------------------------- */
  function onTriggerDown() {
    triggerHeld = true;
    if (activeSlot < 0 || reloadingSlot >= 0) return;
    const def = slots[activeSlot];
    if (!def) return;

    if (inspecting) {
      inspecting = false;
      inspectAnimT = 1;
      inspectElapsed = 0;
      inspectCyclePhase = 0;
      inspectRestTimer = 0;

      applyPose(activeSlot, 0);
    }

    if (mags[activeSlot] <= 0) {
      const now = performance.now();
      if (now - lastEmptySoundAt > EMPTY_SOUND_THROTTLE_MS) {
        playWeaponSound(def, "empty");
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

  function onScopeDown() {
    if (inspecting) {
      inspecting = false;
      inspectAnimT = 1;
      inspectElapsed = 0;
      inspectCyclePhase = 0;
      inspectRestTimer = 0;
    }
    if (activeSlot >= 0) scoped = true;
  }
  function onScopeUp() {
    scoped = false;
  }

  function onReloadKey() {
    startReload();
  }

  function onInspectKey() {
    if (activeSlot < 0) return;
    if (reloadingSlot >= 0) return;
    if (scoped) return;

    const def = slots[activeSlot];
    if (!def) return;

    /* Pressing Y again drops the inspect early. */
    if (inspecting) {
      inspecting = false;
      inspectAnimT = 1;
      inspectElapsed = 0;
      inspectCyclePhase = 0;
      inspectRestTimer = 0;
      return;
    }

    inspecting = true;
    inspectElapsed = 0;
    inspectAnimT = 0;
    inspectCyclePhase = 0;
    inspectRestTimer = 0;
    inspectDur =
      typeof def.inspectDur === "number" && def.inspectDur > 0
        ? def.inspectDur
        : 2.4;

    /* Continuous spin weapons (the pistol by default) run one long
       cycle and ignore the inter-cycle rest entirely. */
    inspectContinuous =
      typeof def.inspectContinuous === "boolean"
        ? def.inspectContinuous
        : getWeaponType(def) === "pistol";

    if (typeof def.inspectLoopDuration === "number" && def.inspectLoopDuration > 0) {
      inspectLoopDuration = def.inspectLoopDuration;
    } else {
      inspectLoopDuration = inspectContinuous
        ? PISTOL_INSPECT_DURATION
        : INSPECT_LOOP_DURATION;
    }

    const firstJitter = 0.85 + Math.random() * 0.30;
    inspectCycleTime = Math.max(
      0.6,
      inspectDur * INSPECT_TIME_MUL * firstJitter,
    );
  }

  function isActive() {
    return activeSlot >= 0;
  }
  function getActiveSlot() {
    return activeSlot;
  }
  function getActiveWeapon() {
    return activeSlot >= 0 ? slots[activeSlot] : null;
  }

  function getSensitivityMul() {
    if (activeSlot < 0) return 1;
    const def = slots[activeSlot];
    const s = def && def.scopeSens !== undefined ? def.scopeSens : 0.5;
    return 1 - (1 - s) * scopeT;
  }

  function getScopeT() {
    return scopeT;
  }

  /* ---------------------------------------------------------------------
       Loadout
       --------------------------------------------------------------------- */
  function addAmmo(type, count) {
    if (!count || count <= 0) return;
    const inv = H().getInventory && H().getInventory();
    if (!inv || typeof inv.addItem !== "function") {
      console.warn("[Weapons] addAmmo: no inventory available");
      return;
    }

    const want = canonAmmo(type);

    if (Array.isArray(inv.items)) {
      for (const it of inv.items) {
        if (!it || (!it.isAmmo && !it.ammoType)) continue;
        if (canonAmmo(it.ammoType) !== want) continue;
        const cap =
          typeof it.maxStack === "number" && it.maxStack > 0
            ? it.maxStack
            : 200;
        const cur = typeof it.count === "number" ? it.count : 0;
        const room = Math.max(0, cap - cur);
        if (room <= 0) continue;
        const moved = Math.min(room, count);
        it.count = cur + moved;
        count -= moved;
        if (count <= 0) break;
      }
      if (count <= 0) {
        if (typeof inv.render === "function") inv.render();
        if (typeof inv._emitChange === "function") inv._emitChange();
        refreshSlotsUI();
        return;
      }
    }

    const def = resolveAmmoDef(type);
    inv.addItem({
      name: (def && def.name) || type.toUpperCase(),
      icon: (def && def.icon) || "▮",
      iconImage: def && def.iconImage,
      iconImageRotated: def && def.iconImageRotated,
      w: (def && def.w) || 1,
      h: (def && def.h) || 1,
      color: (def && def.color) || "#b09040",
      meta: def && def.meta,
      isAmmo: true,
      ammoType: canonAmmo(type),
      count: count,
      maxStack: (def && def.maxStack) || 200,
    });

    refreshSlotsUI();
  }

  let slotChangeHandler = null;

  function setSlotChangeHandler(fn) {
    slotChangeHandler = typeof fn === "function" ? fn : null;
    if (slotChangeHandler) {
      try {
        slotChangeHandler();
      } catch (e) {
        console.error(e);
      }
    }
  }

  function notifySlotChange() {
    if (!slotChangeHandler) return;
    try {
      slotChangeHandler();
    } catch (e) {
      console.error(e);
    }
  }

  function giveWeapon(slotIdx, def) {
    if (slotIdx < 0 || slotIdx >= MAX_SLOTS || !def) return;

    if (activeSlot === slotIdx) {
      deselectActiveSlot();
    }

    slots[slotIdx] = def;
    mags[slotIdx] = def.magSize;
    attachWeapon(slotIdx);
    refreshSlotsUI();
    notifySlotChange();
  }

  function unequipWeapon(slotIdx) {
    if (slotIdx < 0 || slotIdx >= MAX_SLOTS) return null;
    const def = slots[slotIdx];
    if (!def) return null;

    stopFireLoop();

    if (activeSlot === slotIdx) {
      deselectActiveSlot();
    }

    detachWeapon(slotIdx);
    slots[slotIdx] = null;
    mags[slotIdx] = 0;

    refreshSlotsUI();
    notifySlotChange();
    return def;
  }

  function getWeaponAt(slotIdx) {
    if (slotIdx < 0 || slotIdx >= MAX_SLOTS) return null;
    return slots[slotIdx] || null;
  }

  /* =====================================================================
   SKIN API
   ===================================================================== */
  function setSkin(slotIdx, skinId) {
    if (slotIdx < 0 || slotIdx >= MAX_SLOTS) return false;
    const currentDef = slots[slotIdx];
    if (!currentDef) return false;
    if (!window.WeaponSkins) return false;

    const skinned = window.WeaponSkins.applySkin(currentDef, skinId);
    if (skinned === currentDef) return false;

    const wasActive = activeSlot === slotIdx;
    detachWeapon(slotIdx);
    slots[slotIdx] = skinned;
    attachWeapon(slotIdx);

    if (wasActive) {
      deselectActiveSlot();
      selectSlot(slotIdx);
    }

    refreshSlotsUI();
    notifySlotChange();
    return true;
  }

  function getSkinId(slotIdx) {
    if (slotIdx < 0 || slotIdx >= MAX_SLOTS) return null;
    const def = slots[slotIdx];
    return def ? (def.skinId || "default") : null;
  }

  function cycleSkin(slotIdx) {
    if (slotIdx < 0 || slotIdx >= MAX_SLOTS) return false;
    const def = slots[slotIdx];
    if (!def || !window.WeaponSkins) return false;
    const list = window.WeaponSkins.getSkins(def.key);
    if (list.length < 2) return false;

    const curId = def.skinId || "default";
    let idx = list.findIndex((s) => s.id === curId);
    if (idx < 0) idx = 0;
    const next = list[(idx + 1) % list.length];
    return setSkin(slotIdx, next.id);
  }

  /* =====================================================================
   CROSSHAIR — dynamic shotgun ring
   ===================================================================== */
  let crosshairCircleEl = null;
  let _crosshairCache = "";

  function ensureCrosshairCircle() {
    if (crosshairCircleEl) return crosshairCircleEl;
    const ch = document.getElementById("crosshair");
    if (!ch) return null;

    if (getComputedStyle(ch).position === "static") {
      ch.style.position = "relative";
    }

    const el = document.createElement("div");
    el.id = "crosshairCircle";
    el.style.cssText =
      "position:absolute;left:50%;top:50%;" +
      "transform:translate(-50%,-50%);" +
      "width:0;height:0;border-radius:50%;" +
      "border:2px solid rgba(232,200,106,0.85);" +
      "box-sizing:border-box;pointer-events:none;" +
      "transition:width .14s ease-out,height .14s ease-out," +
      "opacity .12s linear;";
    ch.appendChild(el);
    crosshairCircleEl = el;
    return el;
  }

  function updateCrosshairForWeapon() {
    const el = ensureCrosshairCircle();
    if (!el) return;

    const def = activeSlot >= 0 ? slots[activeSlot] : null;
    const pellets = def ? getPelletCount(def) : 0;
    const scoped = scopeT > 0.3;

    let key;
    if (!def || pellets <= 1 || scoped) {
      key = "off";
    } else {
      const radiusPx = Math.round(
        Math.min(120, 26 + (def.spread || 0) * 520),
      );
      key = "on-" + radiusPx;
    }
    if (key === _crosshairCache) return;
    _crosshairCache = key;

    if (key === "off") {
      el.style.width = "0px";
      el.style.height = "0px";
      el.style.opacity = "0";
    } else {
      const radiusPx = parseInt(key.slice(3), 10);
      el.style.width = radiusPx * 2 + "px";
      el.style.height = radiusPx * 2 + "px";
      el.style.opacity = "1";
    }
  }

  /* ---------------------------------------------------------------------
       Init / reset
       --------------------------------------------------------------------- */
  function init() {
    buildWeaponBar();

    const defs = window.WEAPON_MODEL_DATA || [];
    const pistol = defs.find((d) => d.key === "pistol");
    const smg = defs.find((d) => d.key === "smg");

    if (pistol) giveWeapon(0, pistol);
    if (smg) giveWeapon(1, smg);

    if (pistol && pistol.ammoType) addAmmo(pistol.ammoType, 48);
    if (smg && smg.ammoType) addAmmo(smg.ammoType, 90);

    if (H().camera) baseFov = H().camera.fov;
    refreshSlotsUI();

    Sfx.bindAutoUnlock();
    const table = soundTable();
    if (!table) {
      console.warn(
        "[Weapons] window.WEAPON_SOUNDS is not defined — " +
        "weapon audio disabled. Load weapon_sounds.js before weapons.js.",
      );
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
    scoped = false;
    scopeT = 0;
    triggerHeld = false;

    reloadingSlot = -1;
    reloadAnimT = 1;

    inspecting = false;
    inspectAnimT = 1;
    inspectElapsed = 0;
    inspectCyclePhase = 0;
    inspectRestTimer = 0;

    _crosshairCache = "";

    recoilPitchRecover = 0;
    recoilYawRecover = 0;
    recoilTravel = 0;
    recoilTravelVel = 0;
    _prevRecoilTravel = 0;

    if (H().setWeaponDrivesHands) H().setWeaponDrivesHands(false);
    for (const b of bullets) b.mesh.parent && b.mesh.parent.remove(b.mesh);
    bullets.length = 0;
    for (const im of impacts) im.mesh.parent && im.mesh.parent.remove(im.mesh);
    impacts.length = 0;

    if (scopeOverlayEl) scopeOverlayEl.style.opacity = "0";

    refreshSlotsUI();
    notifySlotChange();
  }

  /* ---------------------------------------------------------------------
       Expose
       --------------------------------------------------------------------- */
  window.Weapons = {
    init,
    reset,
    update,
    selectSlot,
    isActive,
    getActiveSlot,
    getActiveWeapon,
    onTriggerDown,
    onTriggerUp,
    onScopeDown,
    onScopeUp,

    onReloadKey,
    onInspectKey,
    isInspecting: () => inspecting,
    getSensitivityMul,
    getScopeT,

    getRecoilTravel: () => recoilTravel,
    addAmmo,
    giveWeapon,
    unequipWeapon,
    getWeaponAt,
    setSkin,
    getSkinId,
    cycleSkin,
    setSlotChangeHandler,
    refreshUI: refreshSlotsUI,
    getAmmo: (t) => getInventoryAmmo(t),
    getMag: (s) => mags[s] || 0,
    setSoundVolume: (v) => Sfx.setVolume(v),
  };
})();