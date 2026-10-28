/* =========================================================================
   ARive — General Sound Effects
   ------------------------------------------------------------------------
   Procedural Web Audio SFX for UI, player, and world events.  Nothing is
   fetched from disk by default — every sound is synthesized at runtime,
   so it works with zero assets.  Real files can override any entry with
   a single Sfx.load(name, url) call.

   API:
     Sfx.play(name, opts)              fire a sound
     Sfx.load(name, url)               override with a real file
     Sfx.preload({ name: url, ... })   bulk Sfx.load
     Sfx.has(name)                     true if a generator or file exists
     Sfx.setVolume(cat, v)             'master'|'ui'|'world'|'player'
     Sfx.setLoopSlice(name, dur, opts) slice a long loop into short one-shots
     Sfx.mute(bool) / Sfx.unlock() / Sfx.bindAutoUnlock()

   === 3D POSITIONAL AUDIO ===
     Sfx.updateListener(pos, forward, up)   — call once per frame with the
                                               camera/player transform
     Sfx.play(name, { position: {x,y,z} }) — any sound becomes spatialized:
                                               PannerNode + inverse distance
                                               model + HRTF (configurable)

   opts for 3D sounds:
     position | pos | x,y,z    world coords (metres)
     panningModel              'HRTF' (default) | 'equalpower'
     distanceModel             'inverse' (default) | 'linear' | 'exponential'
     refDistance               default 2.0 m   — full volume inside this
     maxDistance               default 80 m    — silent past this
     rolloffFactor             default 1.2     — inverse rolloff steepness

   If you pass `position` you normally should NOT also pass `volume` for
   distance attenuation — the panner handles it. `volume` is still applied
   as a final trim on top of the panner's output.

   Load this BEFORE anything that calls Sfx.play.
   ========================================================================= */
(function () {
    'use strict';
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    /* ------------------------------------------------------------------
       Core context + category buses
       ------------------------------------------------------------------ */
    let ctx = null;
    const categoryGain = { master: 1, ui: 1, world: 1, player: 1 };
    const buses = {};           // cat -> GainNode
    let masterBus = null;
    let muted = false;
    let autoUnlockBound = false;

    /* ---- 3D listener state ---- */
    let _listenerActive = false;
    let _pannerOverride = null; // set during generator play() for 3D routing

    function ensureCtx() {
        if (ctx) return ctx;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('[Sfx] AudioContext unavailable:', e);
            return null;
        }
        masterBus = ctx.createGain();
        masterBus.gain.value = muted ? 0 : categoryGain.master;
        masterBus.connect(ctx.destination);
        for (const cat of ['ui', 'world', 'player']) {
            const g = ctx.createGain();
            g.gain.value = categoryGain[cat];
            g.connect(masterBus);
            buses[cat] = g;
        }
        return ctx;
    }

    function bus(cat) {
        ensureCtx();
        // When a 3D generator is running, redirect its output through
        // the panner that play() built for it.
        if (_pannerOverride) return _pannerOverride;
        return buses[cat] || masterBus;
    }

    /* ------------------------------------------------------------------
       3D — listener + panner helpers
       ------------------------------------------------------------------ */
    function updateListener(pos, forward, up) {
        const c = ensureCtx();
        if (!c || !pos) return;
        const L = c.listener;

        const px = pos.x !== undefined ? pos.x : pos[0];
        const py = pos.y !== undefined ? pos.y : pos[1];
        const pz = pos.z !== undefined ? pos.z : pos[2];

        if (L.positionX) {
            // Modern (AudioParam) API
            L.positionX.value = px;
            L.positionY.value = py;
            L.positionZ.value = pz;
            if (forward) {
                L.forwardX.value = forward.x !== undefined ? forward.x : forward[0];
                L.forwardY.value = forward.y !== undefined ? forward.y : forward[1];
                L.forwardZ.value = forward.z !== undefined ? forward.z : forward[2];
            }
            if (up) {
                L.upX.value = up.x !== undefined ? up.x : up[0];
                L.upY.value = up.y !== undefined ? up.y : up[1];
                L.upZ.value = up.z !== undefined ? up.z : up[2];
            }
        } else {
            // Legacy setPosition/setOrientation
            L.setPosition(px, py, pz);
            if (forward && up) {
                L.setOrientation(
                    forward.x !== undefined ? forward.x : forward[0],
                    forward.y !== undefined ? forward.y : forward[1],
                    forward.z !== undefined ? forward.z : forward[2],
                    up.x !== undefined ? up.x : up[0],
                    up.y !== undefined ? up.y : up[1],
                    up.z !== undefined ? up.z : up[2]
                );
            }
        }
        _listenerActive = true;
    }

    function extractPos(opts) {
        if (!opts) return null;
        if (opts.position) {
            const p = opts.position;
            return {
                x: p.x !== undefined ? p.x : p[0],
                y: p.y !== undefined ? p.y : p[1],
                z: p.z !== undefined ? p.z : p[2],
            };
        }
        if (opts.pos) {
            const p = opts.pos;
            return {
                x: p.x !== undefined ? p.x : p[0],
                y: p.y !== undefined ? p.y : p[1],
                z: p.z !== undefined ? p.z : p[2],
            };
        }
        if (opts.x !== undefined && opts.y !== undefined && opts.z !== undefined) {
            return { x: opts.x, y: opts.y, z: opts.z };
        }
        return null;
    }

    function makePanner(pos, opts) {
        const c = ensureCtx();
        if (!c || !c.createPanner) return null;
        const p = c.createPanner();
        // HRTF is the "true 3D" mode; callers on weak devices can pass
        // { panningModel: 'equalpower' } for a cheaper stereo-vector pan.
        p.panningModel = (opts && opts.panningModel) || 'HRTF';
        p.distanceModel = (opts && opts.distanceModel) || 'inverse';
        p.refDistance = (opts && opts.refDistance != null) ? opts.refDistance : 2.0;
        p.maxDistance = (opts && opts.maxDistance != null) ? opts.maxDistance : 80.0;
        p.rolloffFactor = (opts && opts.rolloffFactor != null) ? opts.rolloffFactor : 1.2;
        // Point sources only — no directional cones by default.
        p.coneInnerAngle = 360;
        p.coneOuterAngle = 360;
        p.coneOuterGain = 1;

        if (p.positionX) {
            p.positionX.value = pos.x;
            p.positionY.value = pos.y;
            p.positionZ.value = pos.z;
        } else {
            p.setPosition(pos.x, pos.y, pos.z);
        }
        return p;
    }

    /* ------------------------------------------------------------------ */

    function unlock() {
        const c = ensureCtx();
        if (!c) return;
        if (c.state === 'suspended') c.resume().catch(function () { });
    }

    function bindAutoUnlock() {
        if (autoUnlockBound) return;
        autoUnlockBound = true;
        const h = function () { unlock(); };
        window.addEventListener('pointerdown', h, true);
        window.addEventListener('keydown', h, true);
    }

    function setVolume(cat, v) {
        v = Math.max(0, Math.min(1, v));
        if (cat === 'master') {
            categoryGain.master = v;
            ensureCtx();
            if (masterBus) masterBus.gain.value = muted ? 0 : v;
        } else if (cat in categoryGain) {
            categoryGain[cat] = v;
            if (buses[cat]) buses[cat].gain.value = v;
        }
    }

    function setSeVolume(v) {
        setVolume('ui', v);
        setVolume('world', v);
        setVolume('player', v);
    }

    function mute(on) {
        muted = !!on;
        ensureCtx();
        if (masterBus) masterBus.gain.value = muted ? 0 : categoryGain.master;
    }

    /* ------------------------------------------------------------------
       Tiny synth helpers
       ------------------------------------------------------------------ */
    let _noiseBuf = null;
    function noiseBuffer() {
        if (_noiseBuf) return _noiseBuf;
        const c = ensureCtx();
        if (!c) return null;
        const len = Math.floor(c.sampleRate * 1.2);
        _noiseBuf = c.createBuffer(1, len, c.sampleRate);
        const d = _noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        return _noiseBuf;
    }

    function noise() {
        const c = ensureCtx();
        const b = noiseBuffer();
        if (!c || !b) return null;
        const s = c.createBufferSource();
        s.buffer = b;
        s.loop = true;
        return s;
    }

    function osc(type, freq) {
        const c = ensureCtx();
        if (!c) return null;
        const o = c.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        return o;
    }

    function filt(type, freq, q) {
        const c = ensureCtx();
        if (!c) return null;
        const f = c.createBiquadFilter();
        f.type = type;
        f.frequency.value = freq;
        if (q != null) f.Q.value = q;
        return f;
    }

    function gnode(v) {
        const c = ensureCtx();
        if (!c) return null;
        const g = c.createGain();
        g.gain.value = v != null ? v : 1;
        return g;
    }

    function env(gainNode, t0, attack, hold, release, peak) {
        const g = gainNode.gain;
        g.cancelScheduledValues(t0);
        g.setValueAtTime(0.0001, t0);
        g.linearRampToValueAtTime(peak, t0 + attack);
        g.setValueAtTime(peak, t0 + attack + hold);
        g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    }

    /* ------------------------------------------------------------------
       Sound generators (unchanged except genEnemyFootstep below)
       ------------------------------------------------------------------ */

    function genUiHover() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('square', 1400);
        const g = gnode(0);
        env(g, t, 0.001, 0.005, 0.03, 0.06);
        o.connect(g).connect(bus('ui'));
        o.start(t); o.stop(t + 0.05);
    }

    function genUiClick() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('square', 900);
        o.frequency.setValueAtTime(900, t);
        o.frequency.exponentialRampToValueAtTime(600, t + 0.04);
        const g = gnode(0);
        env(g, t, 0.001, 0.005, 0.05, 0.11);
        o.connect(g).connect(bus('ui'));
        o.start(t); o.stop(t + 0.08);
    }

    function genUiConfirm() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        [520, 780].forEach(function (f, i) {
            const o = osc('triangle', f);
            const g = gnode(0);
            env(g, t + i * 0.045, 0.003, 0.02, 0.10, 0.13);
            o.connect(g).connect(bus('ui'));
            o.start(t + i * 0.045);
            o.stop(t + i * 0.045 + 0.16);
        });
    }

    function genUiBack() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        [520, 340].forEach(function (f, i) {
            const o = osc('triangle', f);
            const g = gnode(0);
            env(g, t + i * 0.05, 0.003, 0.02, 0.09, 0.11);
            o.connect(g).connect(bus('ui'));
            o.start(t + i * 0.05);
            o.stop(t + i * 0.05 + 0.14);
        });
    }

    function genUiError() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('sawtooth', 220);
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(150, t + 0.16);
        const f = filt('lowpass', 900, 4);
        const g = gnode(0);
        env(g, t, 0.004, 0.04, 0.14, 0.14);
        o.connect(f).connect(g).connect(bus('ui'));
        o.start(t); o.stop(t + 0.22);
    }

    const FOOTSTEP_VARIANTS = {
        grass: { thump: 0.10, bodyHz: 140, noiseAmt: 0.18, noiseFreq: 900, q: 0.9, noiseDur: 0.09 },
        stone: { thump: 0.14, bodyHz: 110, noiseAmt: 0.20, noiseFreq: 2200, q: 1.6, noiseDur: 0.06 },
        wood: { thump: 0.13, bodyHz: 130, noiseAmt: 0.16, noiseFreq: 1400, q: 1.2, noiseDur: 0.07 },
        water: { thump: 0.07, bodyHz: 160, noiseAmt: 0.22, noiseFreq: 600, q: 0.6, noiseDur: 0.14 }
    };

    function genFootstep(opts) {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const v = (opts && opts.variant) || 'grass';
        const cfg = FOOTSTEP_VARIANTS[v] || FOOTSTEP_VARIANTS.grass;
        const jitter = 0.9 + Math.random() * 0.2;

        const o = osc('sine', cfg.bodyHz * jitter);
        o.frequency.exponentialRampToValueAtTime(cfg.bodyHz * 0.5, t + 0.09);
        const og = gnode(0);
        env(og, t, 0.003, 0.01, 0.10, cfg.thump);
        o.connect(og).connect(bus('player'));
        o.start(t); o.stop(t + 0.14);

        const n = noise();
        if (n) {
            const nf = filt('bandpass', cfg.noiseFreq * jitter, cfg.q);
            const ng = gnode(0);
            env(ng, t, 0.002, 0.008, cfg.noiseDur, cfg.noiseAmt);
            n.connect(nf).connect(ng).connect(bus('player'));
            n.start(t); n.stop(t + cfg.noiseDur + 0.05);
        }
    }

    function genEnemyFootstep(opts) {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;

        const vol = clamp(opts && opts.volume != null ? opts.volume : 1, 0, 1);
        if (vol < 0.02) return;

        const size = clamp(opts && opts.size != null ? opts.size : 1, 0.5, 2.0);
        const pitchMul = 1 / Math.sqrt(size);
        const jitter = 0.92 + Math.random() * 0.16;

        const gainMul = 1.50 + size * 0.30;

        let dest = bus('world');

        // ONLY apply the manual stereo panner when we're in 2D mode.
        // In 3D mode the PannerNode built by play() handles left/right.
        if (!_pannerOverride && c.createStereoPanner) {
            const panner = c.createStereoPanner();
            panner.pan.value = clamp((opts && opts.pan) || 0, -1, 1);
            panner.connect(dest);
            dest = panner;
        }

        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1000 + vol * 7500;
        lp.Q.value = 0.6;
        lp.connect(dest);
        dest = lp;

        const buf = FILES.get('footstep');
        if (buf) {
            const src = c.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = 0.70 * pitchMul * jitter;
            src.loop = false;

            const g = c.createGain();
            const sliceDur = Math.min(buf.duration, 0.35);
            const wallDur = Math.min(0.35, sliceDur / src.playbackRate.value);
            const peak = Math.min(0.95, vol * gainMul);

            const offset = buf.duration > 0.5
                ? Math.random() * Math.max(0, buf.duration - sliceDur)
                : 0;

            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(peak, t + 0.008);
            g.gain.setValueAtTime(peak, t + 0.068);
            g.gain.exponentialRampToValueAtTime(0.0001, t + wallDur);

            src.connect(g).connect(dest);
            try { src.start(t, offset, sliceDur); } catch (e) { return; }

            _trackVoice('enemy_footstep', src, g);
            return;
        }

        const bodyHz = 90 * pitchMul * jitter;
        const o = osc('sine', bodyHz);
        o.frequency.exponentialRampToValueAtTime(bodyHz * 0.5, t + 0.16);
        const og = gnode(0);
        env(og, t, 0.004, 0.02, 0.18, Math.min(0.85, 0.55 * vol * gainMul));
        o.connect(og).connect(dest);
        o.start(t); o.stop(t + 0.26);

        const n = noise();
        if (n) {
            const bp = filt('bandpass', 300 * pitchMul, 0.8);
            const ng = gnode(0);
            env(ng, t, 0.003, 0.012, 0.09, Math.min(0.35, 0.22 * vol * gainMul));
            n.connect(bp).connect(ng).connect(dest);
            n.start(t); n.stop(t + 0.12);
        }
    }

    function genJump() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('sine', 220);
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(560, t + 0.11);
        const g = gnode(0);
        env(g, t, 0.005, 0.02, 0.10, 0.14);
        o.connect(g).connect(bus('player'));
        o.start(t); o.stop(t + 0.16);
    }

    function genLand() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('sine', 180);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.10);
        const g = gnode(0);
        env(g, t, 0.003, 0.01, 0.14, 0.22);
        o.connect(g).connect(bus('player'));
        o.start(t); o.stop(t + 0.18);

        const n = noise();
        if (n) {
            const f = filt('lowpass', 800, 0.7);
            const ng = gnode(0);
            env(ng, t, 0.002, 0.005, 0.07, 0.12);
            n.connect(f).connect(ng).connect(bus('player'));
            n.start(t); n.stop(t + 0.10);
        }
    }

    function genHurt() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('sawtooth', 320);
        o.frequency.setValueAtTime(320, t);
        o.frequency.exponentialRampToValueAtTime(140, t + 0.18);
        const f = filt('lowpass', 1500, 3);
        const g = gnode(0);
        env(g, t, 0.004, 0.02, 0.16, 0.18);
        o.connect(f).connect(g).connect(bus('player'));
        o.start(t); o.stop(t + 0.24);
    }

    function genDeath() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const o = osc('sawtooth', 260);
        o.frequency.setValueAtTime(260, t);
        o.frequency.exponentialRampToValueAtTime(60, t + 0.55);
        const f = filt('lowpass', 1200, 2);
        const g = gnode(0);
        env(g, t, 0.006, 0.04, 0.55, 0.20);
        o.connect(f).connect(g).connect(bus('player'));
        o.start(t); o.stop(t + 0.68);
    }

    function genVoxelBreak() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const pitch = 0.9 + Math.random() * 0.25;

        const n = noise();
        if (n) {
            const lp = filt('lowpass', 3200 * pitch, 1);
            lp.frequency.setValueAtTime(3200 * pitch, t);
            lp.frequency.exponentialRampToValueAtTime(500, t + 0.16);
            const ng = gnode(0);
            env(ng, t, 0.003, 0.01, 0.18, 0.42);
            n.connect(lp).connect(ng).connect(bus('world'));
            n.start(t); n.stop(t + 0.22);
        }

        const o = osc('sine', 190 * pitch);
        o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
        const og = gnode(0);
        env(og, t, 0.002, 0.01, 0.13, 0.34);
        o.connect(og).connect(bus('world'));
        o.start(t); o.stop(t + 0.18);

        for (let i = 0; i < 3; i++) {
            const tt = t + 0.03 + i * 0.03 + Math.random() * 0.02;
            const co = osc('triangle', 1800 + Math.random() * 800);
            const cg = gnode(0);
            env(cg, tt, 0.001, 0.002, 0.03, 0.05);
            co.connect(cg).connect(bus('world'));
            co.start(tt); co.stop(tt + 0.05);
        }
    }

    function genVoxelPlace() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const pitch = 0.9 + Math.random() * 0.2;

        const o = osc('sine', 220 * pitch);
        o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
        const g = gnode(0);
        env(g, t, 0.002, 0.008, 0.09, 0.26);
        o.connect(g).connect(bus('world'));
        o.start(t); o.stop(t + 0.13);

        const n = noise();
        if (n) {
            const f = filt('bandpass', 1200, 1.4);
            const ng = gnode(0);
            env(ng, t, 0.002, 0.005, 0.05, 0.14);
            n.connect(f).connect(ng).connect(bus('world'));
            n.start(t); n.stop(t + 0.08);
        }
    }

    function genExplosion() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;

        const n = noise();
        if (n) {
            const lp = filt('lowpass', 2500, 0.7);
            lp.frequency.setValueAtTime(2500, t);
            lp.frequency.exponentialRampToValueAtTime(120, t + 0.9);
            const ng = gnode(0);
            env(ng, t, 0.005, 0.05, 0.85, 0.55);
            n.connect(lp).connect(ng).connect(bus('world'));
            n.start(t); n.stop(t + 1.0);
        }

        const o = osc('sine', 90);
        o.frequency.exponentialRampToValueAtTime(35, t + 0.5);
        const og = gnode(0);
        env(og, t, 0.005, 0.06, 0.55, 0.42);
        o.connect(og).connect(bus('world'));
        o.start(t); o.stop(t + 0.7);
    }

    function genSplash() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const n = noise();
        if (n) {
            const bp = filt('bandpass', 1400, 0.8);
            bp.frequency.setValueAtTime(1400, t);
            bp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
            const ng = gnode(0);
            env(ng, t, 0.004, 0.01, 0.28, 0.30);
            n.connect(bp).connect(ng).connect(bus('world'));
            n.start(t); n.stop(t + 0.34);
        }
    }

    /* ------------------------------------------------------------------
       Loop-slice config
       ------------------------------------------------------------------ */
    const LOOP_CONFIG = new Map();

    function setLoopSlice(name, duration, options) {
        if (!name) return;
        if (typeof duration !== 'number' || duration <= 0) {
            LOOP_CONFIG.delete(name);
            return;
        }
        const opts = options || {};
        LOOP_CONFIG.set(name, {
            duration,
            randomStart: opts.randomStart !== false,
            start: typeof opts.start === 'number' ? opts.start : 0,
        });
    }

    /* ------------------------------------------------------------------
       Voice limiting
       ------------------------------------------------------------------ */
    const VOICE_LIMIT = {
        footstep: 1,
        enemy_footstep: 4,
        jump: 2,
        land: 2,
        hurt: 2,
        death: 1,
        voxel_break: 3,
        voxel_place: 2,
        explosion: 3,
        splash: 2,
        zombie_1: 3,
        zombie_2: 3,
        zombie_scream_1: 2,
        zombie_scream_2: 2,
        miniBoss_roar: 1,
        player_hurt: 2,
    };

    const FALLBACKS = {
        player_hurt: 'hurt',
    };

    const ACTIVE = new Map();

    function _trackVoice(name, src, gain) {
        const lim = VOICE_LIMIT[name];
        if (!lim || lim <= 0) return;

        let list = ACTIVE.get(name);
        if (!list) { list = []; ACTIVE.set(name, list); }

        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].ended) list.splice(i, 1);
        }

        while (list.length >= lim) {
            const old = list.shift();
            try {
                const c = ensureCtx();
                if (c) {
                    const t = c.currentTime;
                    old.gain.gain.cancelScheduledValues(t);
                    old.gain.gain.setTargetAtTime(0.0001, t, 0.008);
                    old.src.stop(t + 0.03);
                }
            } catch (e) { }
            old.ended = true;
        }

        const entry = { src, gain, ended: false };
        list.push(entry);
        src.addEventListener('ended', function () { entry.ended = true; });
    }

    /* ------------------------------------------------------------------
       Registry + playback
       ------------------------------------------------------------------ */
    const PROC = {
        ui_hover: genUiHover,
        ui_click: genUiClick,
        ui_confirm: genUiConfirm,
        ui_back: genUiBack,
        ui_error: genUiError,

        footstep: genFootstep,
        enemy_footstep: genEnemyFootstep,
        jump: genJump,
        land: genLand,
        hurt: genHurt,
        death: genDeath,

        voxel_break: genVoxelBreak,
        voxel_place: genVoxelPlace,
        explosion: genExplosion,
        splash: genSplash
    };

    const FILES = new Map();
    const PENDING = new Map();
    const URL_BY_NAME = new Map();

    function resolveSlice(name, buf, opts) {
        if (opts && (typeof opts.duration === 'number' || typeof opts.start === 'number')) {
            const wantDur = typeof opts.duration === 'number' ? opts.duration : buf.duration;
            const wantStart = typeof opts.start === 'number' ? opts.start : 0;
            const maxStart = Math.max(0, buf.duration - wantDur);
            const start = clamp(wantStart, 0, maxStart);
            const duration = Math.min(wantDur, buf.duration - start);
            return { start, duration };
        }

        const cfg = LOOP_CONFIG.get(name);
        if (!cfg) return null;

        const dur = Math.min(cfg.duration, buf.duration);
        const maxStart = Math.max(0, buf.duration - dur);
        const start = cfg.randomStart
            ? Math.random() * maxStart
            : clamp(cfg.start || 0, 0, maxStart);
        return { start, duration: dur };
    }

    function play(name, opts) {
        const c = ensureCtx();
        if (!c) return null;
        if (c.state === 'suspended') unlock();

        const pos = extractPos(opts);
        const usePanner = !!(pos && _listenerActive);
        const cat = (opts && opts.category) || guessCategory(name);

        /* ---------- File-backed path ---------- */
        const buf = FILES.get(name);
        if (buf) {
            const vol = (opts && typeof opts.volume === 'number') ? opts.volume : 1;
            const rate = (opts && typeof opts.rate === 'number') ? opts.rate : 1;
            const src = c.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = rate;
            src.loop = false;
            src.loopStart = 0;
            src.loopEnd = 0;

            const g = c.createGain();

            // Build the output chain: g -> [panner] -> categoryBus
            let tail = bus(cat);
            if (usePanner) {
                const panner = makePanner(pos, opts);
                if (panner) {
                    panner.connect(tail);
                    tail = panner;
                }
            }
            src.connect(g).connect(tail);

            const slice = resolveSlice(name, buf, opts);

            if (slice) {
                const t0 = c.currentTime;
                const srcDur = Math.min(slice.duration, buf.duration - slice.start);
                const wallDur = srcDur / rate;
                const fadeIn = Math.min(0.004, wallDur * 0.10);
                const fadeOut = Math.min(0.015, wallDur * 0.20);
                const sustainEnd = Math.max(
                    t0 + fadeIn + 0.001,
                    t0 + wallDur - fadeOut,
                );

                g.gain.setValueAtTime(0, t0);
                g.gain.linearRampToValueAtTime(vol, t0 + fadeIn);
                g.gain.setValueAtTime(vol, sustainEnd);
                g.gain.linearRampToValueAtTime(0, t0 + wallDur);

                try {
                    src.start(t0, slice.start, srcDur);
                } catch (e) {
                    return null;
                }
            } else {
                g.gain.value = vol;
                try { src.start(0); } catch (e) { return null; }
            }

            _trackVoice(name, src, g);
            return { src: src, gain: g };
        }

        /* ---------- Procedural generator path ---------- */
        const gen = PROC[name];
        if (gen) {
            if (usePanner) {
                const panner = makePanner(pos, opts);
                if (panner) {
                    _pannerOverride = panner;
                    try { gen(opts || {}); }
                    catch (e) { console.warn('[Sfx] generator failed for', name, e); }
                    finally { _pannerOverride = null; }
                    return null;
                }
            }
            try { gen(opts || {}); } catch (e) {
                console.warn('[Sfx] generator failed for', name, e);
            }
            return null;
        }

        if (FALLBACKS[name]) {
            return play(FALLBACKS[name], opts);
        }

        if (PENDING.has(name)) return null;

        console.warn('[Sfx] no such sound:', name);
        return null;
    }

    function playRandom(names, opts) {
        if (!names || !names.length) return null;
        const available = names.filter(n => FILES.has(n) || PROC[n]);
        const pool = available.length > 0 ? available : names;
        const name = pool[(Math.random() * pool.length) | 0];
        return play(name, opts);
    }

    function guessCategory(name) {
        if (name.indexOf('ui_') === 0) return 'ui';
        if (name === 'player_hurt') return 'player';
        if (name.indexOf('voxel_') === 0 ||
            name === 'explosion' ||
            name === 'splash' ||
            name === 'enemy_footstep' ||
            name === 'zombie_1' ||
            name === 'zombie_2' ||
            name === 'zombie_scream_1' ||
            name === 'zombie_scream_2' ||
            name === 'miniBoss_roar') return 'world';
        return 'player';
    }

    function load(name, url) {
        if (!name || !url) return;
        if (FILES.has(name) || PENDING.has(name)) return;
        const c = ensureCtx();
        if (!c) return;
        const p = fetch(url, { cache: 'no-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (b) { return c.decodeAudioData(b); })
            .then(function (dec) {
                FILES.set(name, dec);
                PENDING.delete(name);
                URL_BY_NAME.set(name, url);
            })
            .catch(function (e) {
                PENDING.delete(name);
                console.warn('[Sfx] \u2717 failed', name, url, e.message || e);
            });
        PENDING.set(name, p);
    }

    function preload(map) {
        if (!map) return;
        for (const k in map) load(k, map[k]);
    }

    function has(name) {
        return FILES.has(name) || (name in PROC);
    }

    /* ------------------------------------------------------------------
       Expose
       ------------------------------------------------------------------ */
    window.Sfx = {
        play: play,
        playRandom: playRandom,
        load: load,
        preload: preload,
        has: has,
        setVolume: setVolume,
        setSeVolume: setSeVolume,
        setLoopSlice: setLoopSlice,
        mute: mute,
        unlock: unlock,
        bindAutoUnlock: bindAutoUnlock,

        /* ---- new ---- */
        updateListener: updateListener,

        _catalog: Object.keys(PROC)
    };

    /* ------------------------------------------------------------------
       Real-file overrides
       ------------------------------------------------------------------ */
    if (typeof window !== 'undefined') {
        window.addEventListener('load', function () {
            Sfx.load('footstep', 'assets/sounds/step.mp3');
            Sfx.load('jump', 'assets/sounds/jump.mp3');

            Sfx.load('zombie_1', 'assets/sounds/zombie_1.mp3');
            Sfx.load('zombie_2', 'assets/sounds/zombie_2.mp3');
            Sfx.load('zombie_scream_1', 'assets/sounds/zombie_scream_1.mp3');
            Sfx.load('zombie_scream_2', 'assets/sounds/zombie_scream_2.mp3');
            Sfx.load('miniBoss_roar', 'assets/sounds/miniBoss_roar.mp3');
            Sfx.load('player_hurt', 'assets/sounds/player_hurt.mp3');
        });
    }

    if (typeof window !== 'undefined') bindAutoUnlock();
})();