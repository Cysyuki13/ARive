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
     Sfx.mute(bool) / Sfx.unlock() / Sfx.bindAutoUnlock()

   Catalog (procedural):
     UI      ui_hover, ui_click, ui_confirm, ui_back, ui_error
     Player  footstep (opts.variant 'grass'|'stone'|'wood'|'water'),
             jump, land, hurt, death
     World   voxel_break, voxel_place, explosion, splash

   Load this BEFORE anything that calls Sfx.play.
   ========================================================================= */
(function () {
    'use strict';

    /* ------------------------------------------------------------------
       Core context + category buses
       ------------------------------------------------------------------ */
    let ctx = null;
    const categoryGain = { master: 1, ui: 1, world: 1, player: 1 };
    const buses = {};           // cat -> GainNode
    let masterBus = null;
    let muted = false;
    let autoUnlockBound = false;

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
        return buses[cat] || masterBus;
    }

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

    /* Convenience: set ui + world + player buses with one call.
   Master is intentionally separate so an SE slider can ride on
   top of an overall master. */
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

    /* Noise source — a looping buffer source; caller stops it. */
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

    /* ADSR-ish envelope.  Times are seconds, values linear/exponential. */
    function env(gainNode, t0, attack, hold, release, peak) {
        const g = gainNode.gain;
        g.cancelScheduledValues(t0);
        g.setValueAtTime(0.0001, t0);
        g.linearRampToValueAtTime(peak, t0 + attack);
        g.setValueAtTime(peak, t0 + attack + hold);
        g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    }

    /* ------------------------------------------------------------------
       Sound generators.  Each takes an opts object and returns nothing.
       Everything routes through a category bus.
       ------------------------------------------------------------------ */

    /* ---------- UI ---------- */
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

    /* ---------- Player ---------- */
    /* Footstep variants — each tweaks pitch, noise timbre and length. */
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
        /* Slight random pitch so repeated steps don't sound robotic. */
        const jitter = 0.9 + Math.random() * 0.2;

        /* Low body thump */
        const o = osc('sine', cfg.bodyHz * jitter);
        o.frequency.exponentialRampToValueAtTime(cfg.bodyHz * 0.5, t + 0.09);
        const og = gnode(0);
        env(og, t, 0.003, 0.01, 0.10, cfg.thump);
        o.connect(og).connect(bus('player'));
        o.start(t); o.stop(t + 0.14);

        /* High noise scrape */
        const n = noise();
        if (n) {
            const nf = filt('bandpass', cfg.noiseFreq * jitter, cfg.q);
            const ng = gnode(0);
            env(ng, t, 0.002, 0.008, cfg.noiseDur, cfg.noiseAmt);
            n.connect(nf).connect(ng).connect(bus('player'));
            n.start(t); n.stop(t + cfg.noiseDur + 0.05);
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

    /* ---------- World ---------- */
    function genVoxelBreak() {
        const c = ensureCtx(); if (!c) return;
        const t = c.currentTime;
        const pitch = 0.9 + Math.random() * 0.25;

        /* Crunch — filtered noise with a downward sweep */
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

        /* Impact thump */
        const o = osc('sine', 190 * pitch);
        o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
        const og = gnode(0);
        env(og, t, 0.002, 0.01, 0.13, 0.34);
        o.connect(og).connect(bus('world'));
        o.start(t); o.stop(t + 0.18);

        /* Little chip after the impact — 3 tiny high blips */
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

        /* Long decaying noise bed */
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

        /* Sub boom */
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
       Registry + playback
       ------------------------------------------------------------------ */
    const PROC = {
        ui_hover: genUiHover,
        ui_click: genUiClick,
        ui_confirm: genUiConfirm,
        ui_back: genUiBack,
        ui_error: genUiError,

        footstep: genFootstep,
        jump: genJump,
        land: genLand,
        hurt: genHurt,
        death: genDeath,

        voxel_break: genVoxelBreak,
        voxel_place: genVoxelPlace,
        explosion: genExplosion,
        splash: genSplash
    };

    const FILES = new Map();      // name -> AudioBuffer
    const PENDING = new Map();    // name -> Promise
    const URL_BY_NAME = new Map();// name -> url (for dedupe of identical files)

    function play(name, opts) {
        const c = ensureCtx();
        if (!c) return null;
        if (c.state === 'suspended') unlock();

        const buf = FILES.get(name);
        if (buf) {
            const vol = (opts && typeof opts.volume === 'number') ? opts.volume : 1;
            const rate = (opts && typeof opts.rate === 'number') ? opts.rate : 1;
            const cat = (opts && opts.category) || guessCategory(name);
            const src = c.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = rate;
            const g = c.createGain();
            g.gain.value = vol;
            src.connect(g).connect(bus(cat));
            try { src.start(0); } catch (e) { return null; }
            return { src: src, gain: g };
        }

        const gen = PROC[name];
        if (gen) {
            try { gen(opts || {}); } catch (e) {
                console.warn('[Sfx] generator failed for', name, e);
            }
            return null;
        }
        console.warn('[Sfx] no such sound:', name);
        return null;
    }

    function guessCategory(name) {
        if (name.indexOf('ui_') === 0) return 'ui';
        if (name.indexOf('voxel_') === 0 ||
            name === 'explosion' || name === 'splash') return 'world';
        return 'player';
    }

    function load(name, url) {
        if (!name || !url) return;
        if (FILES.has(name) || PENDING.has(name)) return;
        const c = ensureCtx();
        if (!c) return;
        const p = fetch(url, { cache: 'force-cache' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (b) { return c.decodeAudioData(b); })
            .then(function (dec) {
                FILES.set(name, dec);
                PENDING.delete(name);
                URL_BY_NAME.set(name, url);
                console.log('[Sfx] \u2713 loaded', name, url);
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
        load: load,
        preload: preload,
        has: has,
        setVolume: setVolume,
        setSeVolume: setSeVolume,
        mute: mute,
        unlock: unlock,
        bindAutoUnlock: bindAutoUnlock,
        _catalog: Object.keys(PROC)
    };

    /* Wire auto-unlock immediately so the very first click anywhere in
       the page resumes the AudioContext. */
    if (typeof window !== 'undefined') bindAutoUnlock();
})();