/* =========================================================================
   ARive — Enemies (voxel-bodied, block-breaking, sight-driven AI)
   v3 — Natural/rounded silhouettes.  Superellipsoid heads & torsos,
        tapered rounded limbs.  Same rig contract & performance class.
   ========================================================================= */
(function () {
    "use strict";

    const Hooks = window.ARiveHooks;
    if (!Hooks) {
        console.error(
            "[Enemies] ARiveHooks not available — enemy.js MUST load AFTER game.js",
        );
        return;
    }

    const THREE = Hooks.THREE;
    const scene = Hooks.scene;
    const player = Hooks.player;
    const getV = Hooks.getV;
    const raycastVoxel = Hooks.raycastVoxel;
    const VOXEL = Hooks.VOXEL;
    const WORLD_W = Hooks.WORLD_W;
    const WORLD_D = Hooks.WORLD_D;
    const SY = Hooks.SY;
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    let _mpEnemyCounter = 0;
    function genEnemyId() {
        return 'E' + (++_mpEnemyCounter).toString(36) + '-' +
            Math.random().toString(36).slice(2, 5);
    }

    const GRAVITY = 22;

    /* ---- Hit-stagger tuning ---- */
    const HIT_SLOW_DURATION = 1.0;     // cap on total stacking (1 hit ≈ 0.5 s)
    const HIT_SLOW_MULTIPLIER = 0.35;  // speed × this while staggered
    const HIT_SLOW_MIN_ADD = 0.4;      // ≈ 0.5 s added per hit
    const HIT_SLOW_MAX_ADD = 0.6;

    const ENEMY_VOXEL = 0.035;

    /* ==== BEHAVIOR ARCHETYPES ==== */
    const BEHAVIORS = {
        rusher: {
            speedMul: 1.2, weave: 0.15, pauseChance: 0, lungeChance: 0,
            orbitRadius: 0, preferredRange: 0, strafeChance: 0,
        },
        circler: {
            speedMul: 1.0, weave: 0.30, pauseChance: 0, lungeChance: 0,
            orbitRadius: 3.5, preferredRange: 3.5, strafeChance: 0.75,
        },
        ambusher: {
            speedMul: 1.15, weave: 0.55, pauseChance: 0, lungeChance: 0,
            orbitRadius: 4.5, preferredRange: 4.0, strafeChance: 0.55,
        },
        shuffler: {
            speedMul: 0.75, weave: 0.75, pauseChance: 0.45, lungeChance: 0,
            orbitRadius: 0, preferredRange: 0, strafeChance: 0,
        },
        leaper: {
            speedMul: 0.9, weave: 0.25, pauseChance: 0, lungeChance: 0.85,
            orbitRadius: 2.0, preferredRange: 2.0, strafeChance: 0.35,
        },
        pack: {
            speedMul: 1.05, weave: 0.2, pauseChance: 0, lungeChance: 0,
            orbitRadius: 0, preferredRange: 1.6, strafeChance: 0.2,
        },
    };

    const BEHAVIOR_BY_KIND = {
        walker: 'shuffler', runner: 'rusher', crawler: 'ambusher',
        brute: 'rusher', rotter: 'shuffler', hatty: 'circler',
        blondie: 'leaper', beanie: 'circler', hooded: 'ambusher',
        oldblood: 'shuffler', skull: 'rusher', capboy: 'pack',
        formal: 'circler', vested: 'rusher', stripey: 'leaper',
        demon: 'rusher',
        /* aliens */
        greyscout: 'leaper', blobtron: 'circler', trilens: 'rusher',
        imp: 'rusher', wisp: 'circler', serpent: 'ambusher',
        voidtwin: 'circler', bloom: 'leaper',
        /* bosses (drafts) — they self-declare below */
        __mini_boss__: 'rusher', __final_boss__: 'rusher',
    };

    function createBehavior(archetype) {
        const profile = BEHAVIORS[archetype] || BEHAVIORS.shuffler;
        return {
            archetype, profile,
            seed: Math.random() * 6.28,
            weaveT: Math.random() * 6.28,
            orbitDir: Math.random() < 0.5 ? -1 : 1,
            pauseTimer: 0,
            lungeTimer: 1 + Math.random() * 2.5,
            lungeActive: 0,
        };
    }

    function computeBehaviorMove(e, dx, dz, dist, dt) {
        const B = e.behavior;
        if (!B) return { x: dx / (dist || 1), z: dz / (dist || 1), speedMul: 1 };
        const P = B.profile;

        B.weaveT += dt;
        B.lungeTimer -= dt;
        B.lungeActive = Math.max(0, B.lungeActive - dt);
        B.pauseTimer = Math.max(0, B.pauseTimer - dt);

        let mx = dx / (dist || 1);
        let mz = dz / (dist || 1);
        let speedMul = P.speedMul;

        /* 1. Orbit / strafe */
        if (P.orbitRadius > 0 && dist < P.preferredRange + P.orbitRadius + 1) {
            const prox = Math.max(0, Math.min(1,
                (P.preferredRange + P.orbitRadius - dist) / P.orbitRadius));
            const tx = -mz * B.orbitDir;
            const tz = mx * B.orbitDir;
            const k = prox * P.strafeChance;
            mx = mx * (1 - k * 0.5) + tx * k;
            mz = mz * (1 - k * 0.5) + tz * k;
        }

        /* 2. Weave */
        const wv = Math.sin(B.weaveT * 1.7 + B.seed) * P.weave;
        const cw = Math.cos(wv), sw = Math.sin(wv);
        const wx = mx * cw - mz * sw;
        const wz = mx * sw + mz * cw;

        /* 3. Pause (shufflers) */
        if (P.pauseChance > 0 && B.pauseTimer <= 0 && Math.random() < P.pauseChance * dt) {
            B.pauseTimer = 0.35 + Math.random() * 0.65;
        }
        if (B.pauseTimer > 0) speedMul *= 0.15;

        /* 4. Lunge (leapers) */
        if (P.lungeChance > 0 && B.lungeTimer <= 0) {
            B.lungeActive = 0.4;
            B.lungeTimer = 2.0 + Math.random() * 1.3;
        }
        if (B.lungeActive > 0) speedMul *= 1.85;

        const len = Math.hypot(wx, wz) || 1;
        return { x: wx / len, z: wz / len, speedMul };
    }

    function boxVoxels(x0, y0, z0, w, h, d, color) {
        const out = [];
        for (let x = 0; x < w; x++)
            for (let y = 0; y < h; y++)
                for (let z = 0; z < d; z++)
                    out.push([x0 + x, y0 + y, z0 + z, color]);
        return out;
    }

    /* =========================================================================
       ORGANIC SHAPE PRIMITIVES
       -------------------------------------------------------------------------
       Three primitives give us natural silhouettes:

         · blob()  — superellipsoid centred at (0, cy, 0).  e=2 sphere,
                     e=3 chunky-rounded, e=8 near-cube.  Heads & torsos.
         · limb()  — tapered rounded cylinder along Y.  Arms & legs.
         · _rrSlice() — helper: fills one horizontal slice as a rounded
                     rectangle.  Used by limb() and by tapered torsos.

       All three call back into a colour function that receives the
       integer voxel coordinate AND, where useful, normalized offsets.
       Returning null/undefined skips the voxel (creating holes/shapes).
       ========================================================================= */

    function _rrSlice(y, w, d, r, fn) {
        const out = [];
        const hw = w / 2, hd = d / 2;
        const ex = Math.max(0, hw - r), ez = Math.max(0, hd - r);
        const x0 = Math.floor(-hw - 0.5), x1 = Math.ceil(hw - 0.5);
        const z0 = Math.floor(-hd - 0.5), z1 = Math.ceil(hd - 0.5);
        for (let x = x0; x <= x1; x++) {
            for (let z = z0; z <= z1; z++) {
                const px = x + 0.5, pz = z + 0.5;
                const dx = Math.max(Math.abs(px) - ex, 0);
                const dz = Math.max(Math.abs(pz) - ez, 0);
                if (dx * dx + dz * dz > r * r) continue;
                const c = fn(x, y, z);
                if (c != null) out.push([x, y, z, c]);
            }
        }
        return out;
    }

    /**
     * Superellipsoid centred at (0, cy, 0).
     *   rx/ry/rz  — radii (voxels)
     *   e         — 2 sphere, 3 chunky, 5 boxy-rounded, 8 near cube
     *   fn(x, y, z, dx, dy, dz) → colour|null
     */
    function blob(cy, rx, ry, rz, e, fn) {
        const out = [];
        const invE = 1 / e;
        for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
            const dy = (y + 0.5 - cy) / ry;
            const t2 = 1 - Math.pow(Math.abs(dy), e);
            if (t2 <= 0) continue;
            const s = Math.pow(t2, invE);
            const hw = rx * s, hd = rz * s;
            for (let x = Math.floor(-hw - 0.5); x <= Math.ceil(hw - 0.5); x++) {
                for (let z = Math.floor(-hd - 0.5); z <= Math.ceil(hd - 0.5); z++) {
                    const dx = (x + 0.5) / rx;
                    const dz = (z + 0.5) / rz;
                    const d3 = Math.pow(Math.abs(dx), e)
                        + Math.pow(Math.abs(dy), e)
                        + Math.pow(Math.abs(dz), e);
                    if (d3 > 1.02) continue;
                    const c = fn(x, y, z, dx, dy, dz);
                    if (c != null) out.push([x, y, z, c]);
                }
            }
        }
        return out;
    }

    /**
     * Tapered rounded cylinder along Y, centred at x=0, z=0.
     *   y0            — bottom voxel y
     *   h             — height in voxels
     *   wBot,dBot     — widths at the bottom
     *   wTop,dTop     — widths at the top
     *   r             — corner radius per slice (auto-clamped)
     *   fn(x, y, z, t) → colour|null   (t = 0 at bottom → 1 at top)
     */
    function limb(y0, h, wBot, dBot, wTop, dTop, r, fn) {
        const out = [];
        for (let yi = 0; yi < h; yi++) {
            const t = h > 1 ? yi / (h - 1) : 0;
            const w = wBot + (wTop - wBot) * t;
            const d = dBot + (dTop - dBot) * t;
            const endT = Math.min(yi, h - 1 - yi);
            const endScale = endT < 2 ? Math.sqrt((endT + 0.5) / 2) : 1;
            const wS = w * endScale, dS = d * endScale;
            const rr = Math.min(r, wS / 2, dS / 2);
            out.push(..._rrSlice(y0 + yi, wS, dS, rr, (x, y, z) => fn(x, y, z, t)));
        }
        return out;
    }

    /* =========================================================================
       ZOMBIE BUILDER
       ========================================================================= */

    const BASE_PALETTE = {
        /* Tan human skin like the reference sprite */
        skin: 0xc8a880, skinDark: 0x9a7c58, skinShade: 0xb09870,
        /* Near-black hair with a subtle warm tint */
        hair: 0x1a1010, hairDark: 0x0a0505,
        /* Green shirt, brighter than before */
        cloth: 0x4a7a30, clothLight: 0x6a9a48, clothDark: 0x2a5018,
        belt: 0x1a1a16, buckle: 0x8a7a30,
        /* Denim-blue pants */
        pants: 0x3a5a7a, pantsDark: 0x203a58,
        boot: 0x141414, bootSole: 0x0a0a0a,
        /* Yellow eyes, dark "pupil" filled by C.pupil */
        eye: 0xf0c020, eyeWhite: 0xf0c020, pupil: 0x101010,
        /* Big open purple mouth cavity + white teeth */
        mouth: 0x8a2050, teeth: 0xf0f0e0,
        wound: 0x8a1818,
        flesh: 0xa22222, fleshDark: 0x6e1414,

        /* Cloth damage layers */
        clothStain: 0x2a2010,   /* dark dirt / blood stain */
        clothPatches: 0x8a7040, /* lighter faded patch */
        clothFlesh: 0xa08868,   /* exposed skin under a tear */

        /* Reference-inspired zombie face */
        brain: 0xff90a8,        /* exposed brain pink */
        brainDark: 0xd06080,    /* brain shadows */
        brainLight: 0xffc0d0,   /* brain highlights */
        stitch: 0xf0f0e8,       /* white surgical stitches */
        tongue: 0xc05070,       /* tongue pink */
        drool: 0xb0d0e0,        /* light blue drool */

        /* Dead skin decay */
        necrosis: 0x5a5040,      /* dark necrotic blotches */
        eyelid: 0x3a2818,        /* heavy shadow of the eyelid */
        socket: 0x100808,        /* empty socket interior */

        /* Bloodshot eyeball palette (blobtron) */
        eyeSclera: 0xe8eef4,   /* off-white sclera */
        eyeScleraBlue: 0xb8d4ec,   /* pale blue sclera shade */
        eyeVein: 0xd04040,   /* bright bloodshot red */
        eyeVeinDark: 0x902020,   /* dark bloodshot red */
        eyeIris: 0x2060d0,   /* main iris blue */
        eyeIrisLight: 0x50a8e8,   /* iris highlight blue */
        eyeIrisDark: 0x1038a0,   /* iris dark inner */
        eyePupil: 0x080820,   /* deep navy pupil */
        eyeRim: 0x08080c,   /* near-black rim around iris */
        eyeBack: 0xb87878,   /* pink back / socket flesh */
    };

    function darkenColor(hex, mul) {
        mul = mul == null ? 0.55 : mul;
        const r = Math.floor(((hex >> 16) & 255) * mul);
        const g = Math.floor(((hex >> 8) & 255) * mul);
        const b = Math.floor((hex & 255) * mul);
        return (r << 16) | (g << 8) | b;
    }
    function lightenColor(hex, mul) {
        mul = mul == null ? 1.35 : mul;
        const r = Math.min(255, Math.floor(((hex >> 16) & 255) * mul));
        const g = Math.min(255, Math.floor(((hex >> 8) & 255) * mul));
        const b = Math.min(255, Math.floor((hex & 255) * mul));
        return (r << 16) | (g << 8) | b;
    }

    /* Deterministic 3-D hash → [0, 1).  Used to scatter cloth damage. */
    function hash3(x, y, z) {
        let n = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
        n = (n ^ (n >>> 13)) * 1274126177;
        n = (n ^ (n >>> 16)) >>> 0;
        return n / 4294967296;
    }

    function mirrorX(voxels) {
        return voxels.map(v => [-(v[0] + 1), v[1], v[2], v[3]]);
    }

    /* Paint a face: colour the front-most voxel at each (x, y) column.
       Only overrides if faceColour returns a non-null value. */
    function paintFrontFace(voxels, faceColour) {
        const key = (x, y) => x + "," + y;
        const front = new Map();
        for (const v of voxels) {
            const k = key(v[0], v[1]);
            const cur = front.get(k);
            if (!cur || v[2] < cur[2]) front.set(k, v);
        }
        for (const v of voxels) {
            if (front.get(key(v[0], v[1])) !== v) continue;
            const c = faceColour(v[0], v[1], v[2]);
            if (c != null) v[3] = c;
        }
        return voxels;
    }

    /* Replace procedural voxels with preset-supplied overrides (one array per
   part key).  Overridden parts skip the flesh-interior pass — the arrays
   are treated as final. */
    function applyVoxelOverrides(parts, preset) {
        const ov = preset && preset.voxelOverrides;
        if (!ov || typeof ov !== "object") return;
        for (const key in ov) {
            const p = parts[key];
            const arr = ov[key];
            if (!p || !Array.isArray(arr)) continue;
            p.voxels = arr.map(v => [v[0] | 0, v[1] | 0, v[2] | 0, v[3] >>> 0]);
        }
    }

    function buildZombie(preset) {
        preset = preset || {};
        const C = Object.assign({}, BASE_PALETTE, preset.palette || {});
        const vs = preset.voxelSize || ENEMY_VOXEL;

        const hat = preset.hat || null;
        const hair = preset.hair || "short";
        const hatCol = preset.hatColor != null ? preset.hatColor : C.hair;
        const hatDark = darkenColor(hatCol, 0.55);
        const hatLight = lightenColor(hatCol, 1.25);

        const outfit = preset.outfit || "shirt";

        const armLen = preset.armLen || 16;
        const legLen = preset.legLen || 16;
        const torsoH = preset.torsoH || 18;

        function makeFlesh(voxels) {
            const k = (x, y, z) => x + "," + y + "," + z;
            const solid = new Set();
            for (const v of voxels) solid.add(k(v[0], v[1], v[2]));
            for (const v of voxels) {
                const x = v[0], y = v[1], z = v[2];
                if (
                    solid.has(k(x + 1, y, z)) && solid.has(k(x - 1, y, z)) &&
                    solid.has(k(x, y + 1, z)) && solid.has(k(x, y - 1, z)) &&
                    solid.has(k(x, y, z + 1)) && solid.has(k(x, y, z - 1))
                ) v[3] = ((x + y + z) & 1) ? C.flesh : C.fleshDark;
            }
            return voxels;
        }

        /* ========================================================
           HEAD — 3D pixel-art zombie (DEAD look).
             · Necrotic skin blotches
             · Milky, glazed, droopy dead eyes (never bright white)
             · Slack, hanging jaw — mouth always drooped open
             · Broken teeth, dripping drool, exposed brain
           ======================================================== */
        function makeHead() {
            const rx = 6, ry = 7, rz = 6;
            const map = new Map();
            const k3 = (x, y, z) => x + "," + y + "," + z;
            const setV = (x, y, z, c) => map.set(k3(x, y, z), [x, y, z, c]);
            const delV = (x, y, z) => map.delete(k3(x, y, z));

            /* ---------- 1. Base skull ---------- */
            for (const v of blob(ry, rx, ry, rz, 5, (x, y, z) => {
                const ax = Math.abs(x), az = Math.abs(z);
                if (y === 13 && (ax >= 5 || az >= 5)) return null;
                if (y === 12 && ax >= 6 && az >= 6) return null;

                if (hat === "cap") {
                    if (y >= 12) return hatLight;
                    if (y >= 9) return hatCol;
                    if (y === 8 && Math.abs(z) < 4 && Math.abs(x) < 4) return hatDark;
                } else if (hat === "beanie") {
                    if (y >= 12) return hatLight;
                    if (y >= 8) return hatCol;
                } else if (hat === "hood") {
                    if (y >= 11) return hatCol;
                    if (Math.abs(z) > 4 && y >= 4) return hatCol;
                    if (Math.abs(x) > 4 && y >= 4) return hatCol;
                    if (z > 4 && y >= 2 && y <= 6) return hatCol;
                } else if (hat === "bandana") {
                    if (y === 11) return hatCol;
                    if (y === 10 && Math.abs(z) < 3) return hatCol;
                    if (y >= 12) return C.hair;
                } else if (hat === "turban") {
                    if (y >= 11) return hatLight;
                    if (y >= 8) return hatCol;
                } else if (hat === "horns") {
                    /* bare scalp */
                } else if (hat == null) {
                    if (hair === "short") {
                        if (y === 13) return C.hair;
                        if (y === 12) return C.hair;
                        if (y === 11 && ((x + 7) % 3 !== 0)) return C.hair;
                    } else if (hair === "long") {
                        if (y >= 11) return C.hair;
                        if (y >= 3 && y <= 10 && z >= 4) return C.hair;
                        if (y >= 6 && y <= 10 && Math.abs(x) >= 5) return C.hair;
                    } else if (hair === "mohawk") {
                        if (y >= 11 && Math.abs(x) <= 1) return C.hair;
                    }
                }
                if (y <= 0) return C.skinDark;
                if (y >= 1 && y <= 4 && ax >= 5) return C.skinDark;
                return C.skin;
            })) map.set(k3(v[0], v[1], v[2]), v);

            const F = preset.face || "default";

            /* Extra: cracked-bone patches + a slow drool on a random cheek */
            for (let x = -6; x <= 5; x++) {
                for (let y = 3; y <= 8; y++) {
                    const h = hash3(x * 5 + 3, y * 9 + 5, 17);
                    if (h > 0.965) {
                        const v = map.get(k3(x, y, -6));
                        if (v && v[3] === C.skin) v[3] = C.skinDark;
                    }
                }
            }
            /* Two thin drool strands under the mouth for extra dead-ness */
            if (F !== "skull") {
                setV(-2, 0, -6, C.drool);
                setV(1, 0, -6, C.drool);
            }

            /* ---------- 3. Exposed brain + stitches ---------- */
            const brainVisible = !hat && F !== "skull" && F !== "shadow";
            if (brainVisible) {
                for (let x = -5; x <= -1; x++) {
                    for (let y = 10; y <= 12; y++) {
                        delV(x, y, -6);
                        const pink = ((x + y) & 1) ? C.brain : C.brainDark;
                        setV(x, y, -5, pink);
                        setV(x, y, -4, C.brainDark);
                    }
                }
                setV(-3, 11, -5, C.brainLight);
                setV(-4, 12, -5, C.brainLight);
                setV(-2, 10, -5, C.brainLight);
                setV(-1, 11, -5, C.brainLight);

                for (let y = 10; y <= 12; y++) setV(0, y, -6, C.stitch);
                setV(0, 9, -6, C.stitch);
                setV(-1, 13, -6, C.stitch);
                setV(1, 11, -6, C.stitch);
                setV(1, 10, -7, C.stitch);
                setV(1, 12, -7, C.stitch);
            }

            /* ---------- 4. DEAD EYES ---------- */
            /*  droop:  top rows covered by the dead eyelid (0..2)
                pupil:  [lx, ly] position of the tiny pupil,
                        null → eye is fully glazed over (no pupil)
                torn:   right eye is an empty dark hole
                hollow: skull style — both sockets empty black
                drift:  shift pupil laterally to make the gaze wander  */
            const EYES = {
                default: { droop: 1, pupil: [2, 1], drift: 0 },
                shock: { droop: 1, pupil: [2, 1], drift: 0 },
                drool: { droop: 2, pupil: null, drift: 0 },
                roar: { droop: 1, pupil: [2, 1], drift: 0 },
                ghoul: { droop: 2, pupil: null, drift: 0 },
                grin: { droop: 1, pupil: [2, 1], drift: 0 },
                shadow: { droop: 1, pupil: [2, 1], drift: 0, torn: true },
                squint: { droop: 2, pupil: null, drift: 0 },
                blank: { droop: 1, pupil: null, drift: 0 },
                sneer: { droop: 1, pupil: [2, 1], drift: 0 },
                surprise: { droop: 1, pupil: [1, 1], drift: 0 },
                snarl: { droop: 1, pupil: [2, 1], drift: 0 },
                skull: { droop: 0, pupil: null, drift: 0, hollow: true },
                monocle: { droop: 1, pupil: [2, 1], drift: 0 },
                grit: { droop: 1, pupil: [2, 1], drift: 0 },
                goofy: { droop: 1, pupil: [3, 1], drift: 0 },
            };
            const E = EYES[F] || EYES.default;

            const EYE_PALE = 0xd0c8a0;   /* sickly pale yellow-white */
            const EYE_GLAZE = 0xb0ac88;   /* glazed-over dead eye */
            const EYE_PUPIL = 0x1a1810;   /* tiny black pupil */
            const EYE_HOLE = 0x100808;   /* empty socket (torn / skull) */
            const EYE_LID = C.eyelid;

            /* Carve the sockets, 2 voxels deep */
            for (const [ex0, ex1] of [[-5, -2], [1, 4]]) {
                for (let x = ex0; x <= ex1; x++)
                    for (let y = 6; y <= 9; y++) { delV(x, y, -6); delV(x, y, -5); }
            }

            const fillEye = (x0, x1, side) => {
                const torn = E.torn && side === "R";
                const visible = 4 - E.droop;
                for (let x = x0; x <= x1; x++) {
                    for (let y = 6; y <= 9; y++) {
                        const lx = x - x0, ly = y - 6;
                        if (ly >= visible) { setV(x, y, -4, EYE_LID); continue; }
                        if (torn || E.hollow) { setV(x, y, -4, EYE_HOLE); continue; }
                        if (!E.pupil) { setV(x, y, -4, EYE_GLAZE); continue; }
                        const px = Math.max(0, Math.min(3, E.pupil[0] + E.drift));
                        if (lx === px && ly === E.pupil[1]) {
                            setV(x, y, -4, EYE_PUPIL);
                        } else {
                            setV(x, y, -4, EYE_PALE);
                        }
                    }
                }
            };
            fillEye(-5, -2, "L");
            fillEye(1, 4, "R");

            /* Dark rim around each socket — sunken dead look */
            for (const [ex0, ex1] of [[-5, -2], [1, 4]]) {
                for (let x = ex0; x <= ex1; x++) {
                    setV(x, 5, -5, EYE_LID);
                    setV(x, 10, -5, EYE_LID);
                }
                setV(ex0 - 1, 7, -5, EYE_LID);
                setV(ex1 + 1, 7, -5, EYE_LID);
            }

            /* Eyepatch for shadow type */
            if (F === "shadow") {
                for (let x = -5; x <= -2; x++)
                    for (let y = 5; y <= 10; y++) setV(x, y, -5, 0x0a0a0a);
            }

            /* ---------- 5. Heavy dead brow — shadow only, no expression --- */
            if (F !== "skull") {
                for (let x = -5; x <= 4; x++) {
                    if (x === -1 || x === 0) continue;
                    setV(x, 10, -6, C.skinDark);
                }
            }

            /* ---------- 6. Sunken nose ---------- */
            if (F !== "skull") {
                setV(0, 5, -6, C.skinDark);
                setV(0, 5, -7, C.skinShade);
                setV(-1, 5, -6, C.skinDark);
                setV(1, 5, -6, C.skinDark);
                setV(-1, 4, -6, C.skinDark);
                setV(1, 4, -6, C.skinDark);
            }

            /* ---------- 7. HANGING MOUTH (slack jaw, no emotion) ---------- */
            /*  open:  0 = lip slit; 1..4 = jaw hang (rows of opening)
                droop: 0 = mouth top at y=4; 1 = shifted down one row
                teeth: 'none' | 'stubs' | 'broken' | 'fangs' | 'grit' | 'skull'
                tongue: pale pink tongue at the bottom
                drool:  drip below the lower lip                          */
            const MOUTHS = {
                default: { open: 3, droop: 0, teeth: "stubs", tongue: true },
                shock: { open: 4, droop: 0, teeth: "none", tongue: false },
                drool: { open: 3, droop: 1, teeth: "stubs", tongue: true, drool: true },
                roar: { open: 4, droop: 0, teeth: "broken", tongue: true },
                ghoul: { open: 3, droop: 1, teeth: "stubs", tongue: false },
                grin: { open: 2, droop: 0, teeth: "broken", tongue: false },
                shadow: { open: 2, droop: 1, teeth: "stubs", tongue: false },
                squint: { open: 1, droop: 0, teeth: "none", tongue: false },
                blank: { open: 1, droop: 1, teeth: "none", tongue: false },
                sneer: { open: 2, droop: 0, teeth: "stubs", tongue: false },
                surprise: { open: 4, droop: 0, teeth: "none", tongue: false },
                snarl: { open: 4, droop: 0, teeth: "fangs", tongue: true },
                skull: { open: 3, droop: 0, teeth: "skull", tongue: false },
                monocle: { open: 2, droop: 0, teeth: "stubs", tongue: false },
                grit: { open: 2, droop: 0, teeth: "grit", tongue: false },
                goofy: { open: 3, droop: 1, teeth: "broken", tongue: true },
            };
            const M = MOUTHS[F] || MOUTHS.default;

            const mouthTop = 4 - M.droop;
            const mouthBot = mouthTop - M.open + 1;

            if (M.open > 0) {
                for (let x = -3; x <= 2; x++) {
                    for (let y = mouthBot; y <= mouthTop; y++) {
                        if (y < 1) continue;   /* keep the chin intact */
                        delV(x, y, -6); delV(x, y, -5);
                        setV(x, y, -4, C.fleshDark);
                    }
                }

                /* Teeth — mostly broken / uneven */
                const tRow = mouthTop;
                const bRow = mouthBot;
                if (M.teeth === "stubs") {
                    setV(-2, tRow, -6, C.teeth);
                    setV(1, tRow, -6, C.teeth);
                } else if (M.teeth === "broken") {
                    setV(-3, tRow, -6, C.teeth);
                    setV(0, tRow, -6, C.teeth);
                    setV(2, tRow, -6, C.teeth);
                    setV(-2, bRow, -6, C.teeth);
                } else if (M.teeth === "fangs") {
                    setV(-3, tRow, -6, C.teeth);
                    setV(2, tRow, -6, C.teeth);
                    setV(-3, tRow + 1, -6, C.teeth);
                    setV(2, tRow + 1, -6, C.teeth);
                } else if (M.teeth === "grit") {
                    for (let x = -3; x <= 2; x++) setV(x, tRow, -6, C.teeth);
                } else if (M.teeth === "skull") {
                    for (let x = -3; x <= 2; x++) setV(x, tRow, -6, C.teeth);
                    for (let x = -3; x <= 2; x += 2) setV(x, bRow, -6, C.teeth);
                }

                /* Tongue */
                if (M.tongue && bRow + 1 <= mouthTop) {
                    for (let x = -1; x <= 0; x++) {
                        setV(x, bRow, -4, C.tongue);
                        setV(x, bRow + 1, -4, C.tongue);
                    }
                }

                /* Drool */
                if (M.drool) {
                    setV(-1, bRow - 1, -6, C.drool);
                    setV(0, bRow - 1, -6, C.drool);
                    setV(0, bRow - 2, -6, C.drool);
                }
            } else {
                /* No opening — just a slack lip line */
                for (let x = -2; x <= 1; x++) setV(x, 3, -6, C.skinDark);
            }

            /* ---------- 8. Monocle ring ---------- */
            if (F === "monocle") {
                for (let x = -6; x <= -1; x++) {
                    setV(x, 5, -6, 0x1a1a20);
                    setV(x, 10, -6, 0x1a1a20);
                }
                for (let y = 5; y <= 10; y++) {
                    setV(-6, y, -6, 0x1a1a20);
                    setV(-1, y, -6, 0x1a1a20);
                }
                setV(-4, 7, -6, 0xc0d8e8);
                setV(-4, 8, -6, 0xc0d8e8);
            }

            /* ---------- 9. Ears ---------- */
            for (const [ex] of [[-7], [6]]) {
                for (let y = 5; y <= 7; y++) {
                    for (let z = -1; z <= 1; z++) {
                        setV(ex, y, z, C.skinShade);
                    }
                }
            }

            /* ---------- 10. Hat extras ---------- */
            if (hat === "cap") {
                for (let x = -4; x <= 3; x++) {
                    setV(x, 8, -7, hatDark);
                    setV(x, 8, -8, hatDark);
                    setV(x, 8, -9, hatDark);
                }
            } else if (hat === "horns") {
                const hb = 0x1a0a08;
                for (const hx of [-4, 3]) {
                    for (let i = 0; i < 5; i++) setV(hx, 13 + i, 0, hb);
                    setV(hx, 17, 0, hb);
                    setV(hx + (hx < 0 ? -1 : 1), 17, 0, hb);
                }
            } else if (hat === "bandana") {
                for (let x = -2; x <= 1; x++) setV(x, 8, 5, hatDark);
            }

            /* ---------- 11. Hair spikes ---------- */
            if (!hat && (hair === "short" || hair === "mohawk")) {
                const spikes = [
                    [-5, 14], [-5, 15],
                    [-3, 14], [-3, 15], [-3, 16],
                    [-1, 14], [-1, 15],
                    [1, 14], [1, 15], [1, 16],
                    [3, 14], [3, 15],
                    [5, 14], [5, 15],
                ];
                for (const [sx, sy] of spikes) {
                    setV(sx, sy, 0, C.hair);
                    setV(sx, sy, -1, C.hair);
                }
                for (const [sx, sy] of [[-6, 8], [-6, 7], [5, 8], [5, 7]]) {
                    setV(sx, sy, 0, C.hair);
                }
            }

            return Array.from(map.values());
        }

        /* ========================================================
           TORSO — chunky superellipsoid, wider at chest than waist,
           with a small belly bulge.
           ======================================================== */
        function makeTorso() {
            const cy = torsoH * 0.5;
            const ry = torsoH * 0.5;
            /* Radii chosen so the max width ≈ 16 voxels at the chest. */
            const rx = 8, rz = 4.5;

            let voxels = blob(cy, rx, ry, rz, 3.2, (x, y, z, dx, dy) => {
                const ax = Math.abs(x);

                /* --- outfit overlays (unchanged) --- */
                if (y <= 2) {
                    if (y === 1 && x === 0 && z < 0 && z > -4) return C.buckle;
                    return C.belt;
                }
                if (outfit === "striped") {
                    return (y & 2) === 0 ? C.cloth : C.clothLight;
                }
                if (outfit === "tie") {
                    if (z < -1 && Math.abs(x) <= 1 && y >= 4 && y <= torsoH - 4)
                        return 0x1a1a20;
                }
                if (outfit === "vest") {
                    if (z < -1 && y >= 4 && y <= torsoH - 3 && ax >= 3 && ax <= 6)
                        return C.clothDark;
                }
                if (y >= torsoH - 2) return C.clothDark;
                if (y >= torsoH - 4 && ax >= 5) return C.clothDark;
                if (z < -2 && y >= 6 && y <= 9 && Math.abs(x) <= 3) {
                    return ((y + x) & 1) ? C.clothLight : C.cloth;
                }
                if (z < -1 && y === 8 && x === 4) return C.wound;
                if (z < -1 && y === 10 && x === -2) return C.wound;

                /* ---------- NEW: damage layer (only front-facing fabric) ---------- */
                if (z <= 0) {
                    const h = hash3(x * 7, y * 13, z * 3);
                    /* Big rip → hole straight through the shirt */
                    if (h > 0.965) return null;
                    /* Exposed flesh under a tear */
                    if (h > 0.935) return C.clothFlesh;
                    /* Dark blood / dirt stain */
                    if (h > 0.880) return C.clothStain;
                    /* Faded patch, different fabric sewn on */
                    if (h > 0.840) return C.clothPatches;
                    /* Loose thread — subtle dark blotch */
                    if (h > 0.810) return C.clothDark;
                }

                /* shading (unchanged) */
                if (dy < -0.7) return C.clothDark;
                if (dy > 0.7 && y >= torsoH - 2) return C.clothDark;
                if (Math.abs(dx) > 0.75) return C.clothDark;
                return C.cloth;
            });

            /* Ragged bottom hem */
            for (let x = -7; x <= 7; x++) {
                const h = hash3(x * 3 + 11, 3, 7);
                if (h > 0.7) {
                    const v = voxels.find(v => v[0] === x && v[1] === 3 && v[2] < 0);
                    if (v && v[3] === C.cloth) v[3] = C.clothDark;
                }
            }

            return voxels;
        }

        /* ========================================================
           ARM — tapered rounded cylinder from shoulder to wrist,
           with a small mitten hand at the end.
           ======================================================== */
        function makeArm(_side) {
            const shoulderW = 5.0, shoulderD = 5.0;
            const wristW = 3.4, wristD = 3.4;
            const r = 1.4;

            /* Local Y range: -armLen (bottom) .. -1 (top). */
            const voxels = limb(
                -armLen, armLen,
                wristW, wristD,      /* bottom (wrist) */
                shoulderW, shoulderD,/* top (shoulder) */
                r,
                (x, y, z, t) => {
                    const isWrist = y <= -armLen + 3;
                    const isShoulder = y >= -2;

                    if (isWrist) {
                        if (y === -armLen) return C.skinDark;
                        return C.skin;
                    }
                    if (y === -armLen + 3) return C.clothDark;
                    if (isShoulder) return C.clothDark;

                    if (outfit === "striped") {
                        return (y & 2) === 0 ? C.cloth : C.clothLight;
                    }
                    if (outfit === "vest" && y >= -5) return C.clothDark;

                    /* --- sleeve damage --- */
                    if (z <= 0) {
                        const h = hash3(x * 11, y * 5, z * 19);
                        if (h > 0.955) return null;             // hole
                        if (h > 0.905) return C.clothFlesh;     // skin showing
                        if (h > 0.875) return C.clothStain;     // stain
                        if (h > 0.840) return C.clothPatches;   // patch
                    }
                    return C.cloth;
                }
            );
            return voxels;
        }

        /* ========================================================
           LEG — tapered rounded cylinder hip → ankle, boot flare.
           ======================================================== */
        function makeLeg() {
            const hipW = 6.0, hipD = 6.0;
            const ankleW = 4.0, ankleD = 4.0;
            const r = 1.6;
            const bareTop = -Math.floor(legLen * 0.55);

            const voxels = limb(
                -legLen, legLen,
                ankleW, ankleD,
                hipW, hipD,
                r,
                (x, y, z, t) => {
                    if (y <= -legLen + 3) {
                        if (y === -legLen) return C.bootSole;
                        return C.boot;
                    }
                    if (y === -legLen + 4) return C.belt;
                    if (outfit === "shorts" && y <= bareTop) return C.skin;

                    if (y === -8 && z < -1) return C.pantsDark;
                    if (z < -1 && Math.abs(x) <= 1 && y <= -6 && y >= -10)
                        return C.pantsDark;

                    /* --- pant damage: scuffs, stains, rips --- */
                    if (z <= 0) {
                        const h = hash3(x * 3, y * 17, z * 23);
                        if (h > 0.960) return null;             // rip showing skin
                        if (h > 0.930) return C.skin;           // torn-through
                        if (h > 0.885) return C.pantsDark;      // grease/oil
                        if (h > 0.855) return C.clothStain;     // dirt
                    }
                    return C.pants;
                }
            );
            return voxels;
        }

        const parts = {
            legL: {
                pivot: [-4, legLen, 0], hp: 22, isLeg: true, parent: "root",
                voxels: makeFlesh(makeLeg())
            },
            legR: {
                pivot: [4, legLen, 0], hp: 22, isLeg: true, parent: "root",
                voxels: makeFlesh(makeLeg())
            },
            torso: {
                pivot: [0, legLen, 0], hp: 55, isLeg: false, parent: "root",
                voxels: makeFlesh(makeTorso())
            },
            head: {
                pivot: [0, torsoH, 0], hp: 28, isLeg: false, parent: "torso",
                voxels: makeFlesh(makeHead())
            },
            armL: {
                pivot: [-10, torsoH - 1, 0], hp: 18, isLeg: false, parent: "torso",
                voxels: preset.noArms ? [] : makeFlesh(makeArm(-1))
            },
            armR: {
                pivot: [10, torsoH - 1, 0], hp: 18, isLeg: false, parent: "torso",
                voxels: preset.noArms ? [] : makeFlesh(makeArm(+1))
            },
        };

        applyVoxelOverrides(parts, preset);

        return {
            voxelSize: vs,
            bodyType: "humanoid",
            hp: preset.hp != null ? preset.hp : 60,
            speedWalk: preset.speedWalk != null ? preset.speedWalk : 1.6,
            speedRun: preset.speedRun != null ? preset.speedRun : 3.4,
            attackDamage: preset.attackDamage != null ? preset.attackDamage : 10,
            attackRange: preset.attackRange != null ? preset.attackRange : 1.5,

            eyeY: (legLen + torsoH - 1) * vs,
            colHW: preset.colHW != null ? preset.colHW : 0.28,
            colH: preset.colH != null ? preset.colH : 1.45,
            hitCenterY: preset.hitCenterY != null ? preset.hitCenterY : 0.85,
            hitHW: preset.hitHW != null ? preset.hitHW : 0.36,
            hitHH: preset.hitHH != null ? preset.hitHH : 0.85,
            startsCrawling: !!preset.startsCrawling,

            parts,
        };
    }

    /* ============================================================
       ALIEN BUILDER — reference-matched, aggressive, connected rigs
       Every shape is unique: big eyes, tentacle bundles, hoods,
       mandibles, spiked crowns — one signature per species.
       ============================================================ */
    function buildAlien(preset) {
        preset = preset || {};
        const C = Object.assign({}, BASE_PALETTE, preset.palette || {});
        const vs = preset.voxelSize || ENEMY_VOXEL;
        const shape = preset.shape || "grey";

        function makeFlesh(voxels) {
            const k = (x, y, z) => x + "," + y + "," + z;
            const solid = new Set();
            for (const v of voxels) solid.add(k(v[0], v[1], v[2]));
            for (const v of voxels) {
                const x = v[0], y = v[1], z = v[2];
                if (
                    solid.has(k(x + 1, y, z)) && solid.has(k(x - 1, y, z)) &&
                    solid.has(k(x, y + 1, z)) && solid.has(k(x, y - 1, z)) &&
                    solid.has(k(x, y, z + 1)) && solid.has(k(x, y, z - 1))
                ) v[3] = ((x + y + z) & 1) ? C.flesh : C.fleshDark;
            }
            return voxels;
        }

        /* Torso helper — rounded box centred at (0, cy, 0) */
        function bodyBox(cy, hw, hh, hd, e, fn) {
            return blob(cy, hw, hh, hd, e, fn);
        }

        let R;

        /* ==========================================================
           1. GREY SCOUT — green grasshopper alien
              · Slim rounded head with two big dark oval eyes
              · Short V-shaped antennae
              · Slim thorax with segment ridges
              · Thin bent insect limbs
           ========================================================== */
        if (shape === "greenscout") {
            const legLen = 12, torsoH = 13, armLen = 10;

            /* Head: oval, rounded top, flat under-jaw */
            const head = [];
            for (let x = -3; x <= 3; x++)
                for (let y = 0; y <= 7; y++)
                    for (let z = -3; z <= 2; z++) {
                        const ax = Math.abs(x), az = Math.abs(z);
                        if (y === 7 && (ax >= 2 || az >= 2)) continue;
                        if (y === 0 && (ax >= 3 || az >= 3)) continue;
                        if (y === 6 && ax >= 3 && az >= 2) continue;
                        head.push([x, y, z, C.skin]);
                    }

            /* Two big oval dark-green compound eyes on the front */
            for (const [ex0, ex1] of [[-3, -1], [1, 3]]) {
                for (let x = ex0; x <= ex1; x++)
                    for (let y = 3; y <= 6; y++) {
                        const cx = (ex0 + ex1) / 2;
                        const dx = x - cx, dy = y - 4.5;
                        /* Oval mask */
                        if ((dx * dx) / 2.25 + (dy * dy) / 3.5 > 1) continue;
                        head.push([x, y, -4, C.eye]);   // protrude 1 voxel
                    }
            }
            /* Under-eye shading */
            for (let x = -3; x <= 3; x++) {
                if (Math.abs(x) === 3) continue;
                head.push([x, 2, -3, C.skinDark]);
            }

            /* Small mouth slit */
            for (let x = -1; x <= 1; x++) head.push([x, 1, -4, C.mouth]);

            /* Short V antennae with glowing tips */
            for (const [ax, lean] of [[-2, -1], [1, 1]]) {
                head.push([ax, 8, 0, C.skinDark]);
                head.push([ax + lean, 9, 0, C.skinDark]);
                head.push([ax + lean * 2, 10, 0, 0xffe040]);
            }

            /* Torso: narrow thorax with subtle segment ridges */
            const torso = blob(torsoH * 0.5, 3, torsoH * 0.5, 2, 3.2, (x, y, z) => {
                if (Math.abs(x) > 2) return C.skinDark;
                if (z >= 1 && (y & 2) === 0) return C.skinShade;
                return C.skin;
            });

            /* Arms: thin, with claw hands */
            const armL = limb(-armLen, armLen, 2, 2, 2.6, 2.6, 0.9,
                (x, y, z, t) => (y <= -armLen + 2 ? 0x0a2a0a : C.skin));
            const armR = mirrorX(armL);

            /* Legs: insect-bent, wider at the middle */
            const legL = limb(-legLen, legLen, 2, 2, 2.8, 2.8, 1.0,
                (x, y, z, t) => (y <= -legLen + 2 ? 0x0a2a0a : C.skin));
            const legR = mirrorX(legL);

            R = {
                bodyType: "humanoid",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 30,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 55,
                armLVoxels: armL, armRVoxels: armR,
                armLPivot: [-4, torsoH - 1, 0], armRPivot: [4, torsoH - 1, 0],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-2, legLen, 0], legRPivot: [2, legLen, 0],
                colH: (legLen + torsoH + 11) * vs, colHW: 0.30,
                eyeY: (legLen + torsoH + 5) * vs,
            };
        }

        /* ==========================================================
   2. BLOBTRON — a giant bloodshot eyeball riding on a
      bulbous cephalopod mantle, with tentacles fanning
      outward + downward around the base like an octopus.
      · Head: sclera + bloodshot veins + blue iris + glint
      · Torso: rounded red mantle, veiny, dark socket on top
      · 4 pivot groups × 2 tentacles = 8 tentacles total,
        splaying outward from the rim of the mantle
   ========================================================== */
        else if (shape === "blob") {
            const legLen = 10;   /* mantle base height above ground */
            const torsoH = 10;   /* mantle height */
            const ER = 6;        /* eyeball radius */
            const eyeCy = ER;

            const EYEC = {
                sclera: C.eyeSclera != null ? C.eyeSclera : 0xe8eef4,
                scleraB: C.eyeScleraBlue != null ? C.eyeScleraBlue : 0xb8d4ec,
                vein: C.eyeVein != null ? C.eyeVein : 0xd04040,
                veinD: C.eyeVeinDark != null ? C.eyeVeinDark : 0x902020,
                iris: C.eyeIris != null ? C.eyeIris : 0x2060d0,
                irisL: C.eyeIrisLight != null ? C.eyeIrisLight : 0x50a8e8,
                irisD: C.eyeIrisDark != null ? C.eyeIrisDark : 0x1038a0,
                pupil: C.eyePupil != null ? C.eyePupil : 0x080820,
                rim: C.eyeRim != null ? C.eyeRim : 0x08080c,
                back: C.eyeBack != null ? C.eyeBack : 0xb87878,
            };

            /* --- HEAD — the giant bloodshot eyeball --- */
            const head = blob(eyeCy, ER, ER, ER, 2.05, (x, y, z) => {
                const dy = y - eyeCy;
                const rd = Math.sqrt(x * x + dy * dy);

                if (z > 0) {
                    const h = hash3(x * 13 + 1, y * 7 + 3, z * 11 + 5);
                    if (z > ER * 0.60 && h > 0.45) return EYEC.back;
                    if (h > 0.86) return EYEC.vein;
                    if (h > 0.78) return EYEC.veinD;
                    if (h > 0.55) return EYEC.scleraB;
                    return EYEC.sclera;
                }
                if (rd > ER - 1.0) {
                    return hash3(x * 31 + 3, y * 19 + 7, z * 5 + 11) > 0.5
                        ? 0xd09898 : 0xb87878;
                }
                if (rd <= 1.4) return EYEC.pupil;
                if (rd <= 2.0) return EYEC.rim;
                if (rd <= 2.8) {
                    return hash3(x * 3 + 7, y * 5 + 1, z * 7 + 3) > 0.45
                        ? EYEC.irisL : EYEC.irisD;
                }
                if (rd <= 4.2) {
                    const h = hash3(x * 5 + 2, y * 7 + 9, z * 11 + 1);
                    if (h > 0.78) return EYEC.irisL;
                    if (h > 0.30) return EYEC.iris;
                    return EYEC.irisD;
                }
                if (rd <= 4.7) return EYEC.rim;
                const h = hash3(x * 17 + 5, y * 11 + 7, z * 23 + 3);
                if (h > 0.84) return EYEC.vein;
                if (h > 0.76) return EYEC.veinD;
                if (h > 0.55) return EYEC.scleraB;
                return EYEC.sclera;
            });

            /* white glint in the pupil (upper-left) */
            for (const v of head) {
                if (v[2] === -ER && v[1] === eyeCy - 1 &&
                    (v[0] === -2 || v[0] === -1)) {
                    v[3] = 0xf8f8ff;
                }
            }

            /* --- TORSO: bulbous red mantle --- */
            const torso = blob(torsoH * 0.5, 6, torsoH * 0.5, 6, 2.4,
                (x, y, z, dx, dy, dz) => {
                    const ax = Math.abs(x), az = Math.abs(z);
                    /* dark flesh ring where the eye is mounted */
                    if (y >= torsoH - 2 && ax <= 3 && az <= 3) return 0x5a0e0e;
                    /* radial vein ridges on the mantle */
                    const h = hash3(x * 17 + 3, y * 23 + 7, z * 29 + 11);
                    const vein = ((x + 2 * z) % 6 === 0) && h > 0.25;
                    if (vein) return 0x601010;
                    if (h > 0.86) return 0x6a1414;    /* dark blotch */
                    if (h > 0.60) return 0xc04040;    /* bright muscle */
                    if (h > 0.35) return 0xa02828;    /* mid red */
                    return 0x801818;                   /* deep red base */
                });

            /* --- TENTACLE helper: curves outward then downward --- */
            const makeTentacle = (outX, outZ, len, phase) => {
                const out = [];
                for (let i = 0; i < len; i++) {
                    const t = i / (len - 1);
                    /* splay: quadratic curve away from the pivot */
                    const splayX = outX * (t * t) * 4.0;
                    const splayZ = outZ * (t * t) * 4.0;
                    /* wiggle: grows toward the tip */
                    const wig = Math.sin(i * 0.62 + phase) * (0.30 + t * 1.4);
                    const wigZ = Math.cos(i * 0.45 + phase * 1.3) * (0.25 + t * 1.1);
                    const x = Math.round(splayX + wig);
                    const z = Math.round(splayZ + wigZ);
                    const y = -(i + 1);
                    let c;
                    const h = hash3(x * 7, y * 13, z * 11);
                    if (i >= len - 1) c = 0xffc0c0;         /* pale tip */
                    else if (i >= len - 2) c = 0xe05858;
                    else if (t < 0.15) c = 0x8a1818;        /* base */
                    else if (t < 0.40) c = 0xa02828;
                    else if (h > 0.82) c = 0xe06060;        /* highlight */
                    else c = 0xc03838;                       /* main red */
                    out.push([x, y, z, c]);
                }
                return out;
            };

            /* Each pivot holds 2 slightly-misaligned tentacles */
            const makeBundle = (outX, outZ, len, phA, phB) => {
                const a = makeTentacle(outX, outZ, len, phA);
                /* rotate the second one ~20° so the pair fans out */
                const bx = outX * 0.82 - outZ * 0.30;
                const bz = outZ * 0.82 + outX * 0.30;
                const b = makeTentacle(bx, bz, len - 1, phB);
                return a.concat(b);
            };

            /* Two bundles at the back (children of root) */
            const legL = makeBundle(-1, -1, legLen, 0.0, 2.1);
            const legR = makeBundle(1, -1, legLen, 1.3, 3.4);
            /* Two bundles at the front (children of torso → longer reach) */
            const armL = makeBundle(-1, 1, legLen + 2, 0.7, 2.8);
            const armR = makeBundle(1, 1, legLen + 2, 1.9, 4.1);

            R = {
                bodyType: "octo",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 32,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 50,
                armLVoxels: armL, armRVoxels: armR,
                /* arm pivots are torso-local: world y = legLen + 2 */
                armLPivot: [-4, 2, 4], armRPivot: [4, 2, 4],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-4, legLen, -4], legRPivot: [4, legLen, -4],
                colH: (legLen + torsoH + 2 * ER) * vs, colHW: 0.55,
                eyeY: (legLen + torsoH + eyeCy) * vs,
            };
        }

        /* ==========================================================
           3. STALKER (Trilens) — orange alien with MANY TENTACLES
              Each arm/leg is a bundle of 4 wiggling tentacles.
           ========================================================== */
        else if (shape === "stalker") {
            const legLen = 14, torsoH = 16, armLen = 12;
            const neckH = 4;

            /* Bulbous body */
            const torso = [];
            for (let y = 0; y < torsoH; y++) {
                const t = y / (torsoH - 1);
                const w = 5 - Math.round(t * 2);
                const d = 4 - Math.round(t * 1.5);
                for (let x = -w; x <= w; x++)
                    for (let z = -d; z <= d; z++) {
                        /* Skip corners for a rounded look */
                        if (Math.abs(x) === w && Math.abs(z) === d) continue;
                        let c = C.skin;
                        if (y >= torsoH - neckH) c = C.skinDark;
                        else if (z >= 0 && (y & 1) === 0) c = C.skinShade;
                        torso.push([x, y, z, c]);
                    }
            }

            /* Small head with 2 stalk-eyes */
            const head = [];
            for (let x = -1; x <= 0; x++)
                for (let y = 0; y <= 2; y++)
                    for (let z = -1; z <= 0; z++) head.push([x, y, z, C.skin]);
            for (const [sx, lean] of [[-3, -1], [2, 1]]) {
                head.push([sx, 0, 0, C.skinDark]);
                head.push([sx + lean, 1, 0, C.skinDark]);
                head.push([sx + lean, 2, -1, C.eyeWhite]);
                head.push([sx + lean, 2, 0, C.eye]);
            }

            /* *** TENTACLE BUNDLE ARMS *** — 4 tentacles per arm */
            const makeTentacleBundle = (side) => {
                const out = [];
                const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
                for (let i = 0; i < 4; i++) {
                    const [dx, dz] = dirs[i];
                    for (let y = 0; y < armLen; y++) {
                        const bend = Math.round(Math.sin(y * 0.4) * (i - 1.5) * 0.5);
                        const tx = dirs[i][0] * (1 + (i & 1)) + bend;
                        const tz = dirs[i][1] * (1 + (i >> 1));
                        const c = y === armLen - 1 ? 0xffe040 :
                            y === armLen - 2 ? 0xc0c040 : C.skin;
                        out.push([tx, -(y + 1), tz, c]);
                    }
                }
                return out;
            };
            const armL = makeTentacleBundle(-1);
            const armR = makeTentacleBundle(+1);

            /* *** TENTACLE BUNDLE LEGS *** — 3 tentacles per leg */
            const makeLegBundle = (side) => {
                const out = [];
                for (let i = 0; i < 3; i++) {
                    const dx = (i - 1) * 2;
                    for (let y = 0; y < legLen; y++) {
                        const bend = Math.round(Math.sin(y * 0.5) * (i - 1) * 0.4);
                        const c = y === legLen - 1 ? C.skinDark : C.skin;
                        out.push([dx + bend, -(y + 1), 0, c]);
                    }
                }
                return out;
            };
            const legL = makeLegBundle(-1);
            const legR = makeLegBundle(+1);

            R = {
                bodyType: "humanoid",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 25,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 70,
                armLVoxels: armL, armRVoxels: armR,
                armLPivot: [-5, torsoH - 2, 0], armRPivot: [5, torsoH - 2, 0],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-3, legLen, 0], legRPivot: [3, legLen, 0],
                colH: (legLen + torsoH + 6) * vs, colHW: 0.42,
                eyeY: (legLen + torsoH + 3) * vs,
            };
        }

        /* ==========================================================
           4. INSECT (Imp) — red mandibled alien
           ========================================================== */
        else if (shape === "insect") {
            const legLen = 14, torsoH = 16, armLen = 10, headH = 8;

            /* Head: sharp, four slit eyes, mandibles, antennae */
            const head = [];
            for (let x = -3; x <= 2; x++)
                for (let y = 0; y <= headH - 1; y++)
                    for (let z = -2; z <= 2; z++) {
                        const ax = Math.abs(x), az = Math.abs(z);
                        if (y === headH - 1 && (ax >= 2 || az >= 2)) continue;
                        head.push([x, y, z, C.skin]);
                    }
            /* Angry V-shape brow */
            for (let x = -3; x <= 2; x++) head.push([x, headH - 2, -3, C.skinDark]);
            /* Four slit eyes */
            for (const ey of [4, 5]) {
                head.push([-3, ey, -3, C.eyeWhite]);
                head.push([-2, ey, -3, C.eye]);
                head.push([1, ey, -3, C.eye]);
                head.push([2, ey, -3, C.eyeWhite]);
            }
            /* Mouth with sharp teeth */
            for (let x = -2; x <= 1; x++) {
                head.push([x, 1, -3, C.mouth]);
                head.push([x, 2, -3, C.teeth]);
            }
            /* Curved mandibles (hook inward) */
            head.push([-3, 2, -3, C.teeth]);
            head.push([-4, 1, -3, C.teeth]);
            head.push([2, 2, -3, C.teeth]);
            head.push([3, 1, -3, C.teeth]);
            /* Two antennae */
            for (const ax of [-2, 1]) {
                head.push([ax, headH, 0, C.skinDark]);
                head.push([ax, headH + 1, 0, C.skinDark]);
                head.push([ax, headH + 2, 0, 0xffe040]);
            }

            /* Segmented carapace torso */
            const torso = blob(torsoH * 0.5, 4, torsoH * 0.5, 3, 3.2, (x, y, z) => {
                /* Ridges every 2 rows */
                if (z <= -1 && (y & 1) === 0) return C.skinShade;
                if (y >= torsoH - 2) return C.skinDark;
                return C.skin;
            });

            /* Arms — thin with claw hands */
            const armL = limb(-armLen, armLen, 2, 2, 3, 3, 0.9,
                (x, y, z, t) => (y <= -armLen + 2 ? 0x2a0505 : C.skin));
            const armR = mirrorX(armL);

            /* Legs — thin */
            const legL = limb(-legLen, legLen, 2.4, 2.4, 3, 3, 1.0,
                (x, y, z, t) => (y <= -legLen + 2 ? 0x2a0505 : C.skin));
            const legR = mirrorX(legL);

            R = {
                bodyType: "insect",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 22,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 60,
                armLVoxels: armL, armRVoxels: armR,
                armLPivot: [-5, torsoH - 1, 0], armRPivot: [5, torsoH - 1, 0],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-3, legLen, 0], legRPivot: [3, legLen, 0],
                colH: (legLen + torsoH + headH) * vs, colHW: 0.36,
                eyeY: (legLen + torsoH + 5) * vs,
            };
        }

        /* ==========================================================
           5. CYCLOPS (Wisp) — teal single eye on a STALK
           ========================================================== */
        else if (shape === "cyclops") {
            const legLen = 12, torsoH = 14, armLen = 10;

            /* Torso — slim teal body */
            const torso = blob(torsoH * 0.5, 4, torsoH * 0.5, 3, 3, (x, y, z) => {
                if (Math.abs(x) > 3) return C.skinDark;
                return C.skin;
            });

            /* Head + protruding EYE STALK */
            const head = [];
            /* Base skull */
            for (let x = -3; x <= 2; x++)
                for (let y = 0; y <= 3; y++)
                    for (let z = -2; z <= 1; z++) head.push([x, y, z, C.skin]);
            /* Neck stub going up */
            head.push([-1, 4, 0, C.skinDark]);
            head.push([0, 4, 0, C.skinDark]);
            head.push([-1, 5, 0, C.skinDark]);
            head.push([0, 5, 0, C.skinDark]);
            /* *** 3D PROTRUDING EYE STALK *** — sphere on a stem */
            const eyeR = 3;
            const eyeCy = 8;
            for (let x = -eyeR; x <= eyeR; x++)
                for (let y = -eyeR; y <= eyeR; y++)
                    for (let z = -eyeR; z <= eyeR; z++) {
                        const d2 = x * x + y * y + z * z;
                        if (d2 > eyeR * eyeR) continue;
                        let col;
                        if (z <= -1 && d2 <= 4) col = C.pupil;
                        else if (d2 <= 6) col = C.eye;
                        else col = C.eyeWhite;
                        head.push([x, eyeCy + y, z, col]);
                    }
            /* Hair tendrils radiating outward */
            for (let a = 0; a < 6; a++) {
                const ang = a * Math.PI * 2 / 6;
                const dx = Math.round(Math.cos(ang) * 5);
                const dz = Math.round(Math.sin(ang) * 3);
                head.push([dx, 6, dz, C.skinDark]);
                head.push([dx + (dx > 0 ? 1 : -1), 5, dz, C.skinDark]);
            }
            /* Small mouth */
            for (let x = -1; x <= 0; x++) head.push([x, 1, -3, C.mouth]);

            const armL = limb(-armLen, armLen, 2.4, 2.4, 3, 3, 1.0, () => C.skin);
            const armR = mirrorX(armL);
            const legL = limb(-legLen, legLen, 2.4, 2.4, 3, 3, 1.0, () => C.skin);
            const legR = mirrorX(legL);

            R = {
                bodyType: "humanoid",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 26,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 55,
                armLVoxels: armL, armRVoxels: armR,
                armLPivot: [-5, torsoH - 1, 0], armRPivot: [5, torsoH - 1, 0],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-3, legLen, 0], legRPivot: [3, legLen, 0],
                colH: (legLen + torsoH + 12) * vs, colHW: 0.34,
                eyeY: (legLen + torsoH + 8) * vs,
            };
        }

        /* ==========================================================
           6. SERPENT — blue cobra with flared hood
           ========================================================== */
        else if (shape === "serpent") {
            const bodyLen = 22;
            const neckH = 16;

            /* Long snake body with back spine */
            const torso = [];
            for (let z = -Math.floor(bodyLen / 2); z <= Math.floor(bodyLen / 2); z++) {
                const t = Math.abs(z) / (bodyLen / 2);
                const w = Math.max(2, 5 - Math.round(t * 3));
                const h = Math.max(2, 5 - Math.round(t * 3));
                for (let y = 0; y < h; y++)
                    for (let x = -w; x <= w; x++) {
                        let c = C.skin;
                        if (y === h - 1 && z % 3 === 0 && t < 0.8) c = C.skinDark;
                        else if (y === 0) c = C.skinShade;
                        torso.push([x, y, z, c]);
                    }
            }
            /* Rising neck */
            const neckZ = -Math.floor(bodyLen / 2);
            for (let y = 0; y < neckH; y++) {
                const w = 2 - (y > 8 ? 1 : 0);
                for (let x = -w; x <= w; x++) torso.push([x, y, neckZ, C.skin]);
            }

            /* Head with cobra hood, fangs, forked tongue */
            const head = [];
            /* Flared hood */
            for (let x = -4; x <= 3; x++)
                for (let y = 0; y <= 1; y++)
                    for (let z = -1; z <= 0; z++) head.push([x, y, z, C.skin]);
            /* Skull */
            for (let x = -2; x <= 1; x++)
                for (let y = 2; y <= 5; y++)
                    for (let z = -2; z <= 1; z++) head.push([x, y, z, C.skin]);
            /* Protruding snout */
            for (let x = -2; x <= 1; x++)
                for (let y = 3; y <= 4; y++) {
                    head.push([x, y, -3, C.skin]);
                    head.push([x, y, -4, C.skinDark]);
                }
            /* Slit eyes */
            head.push([-3, 5, -3, C.eyeWhite]);
            head.push([-3, 5, -4, C.eye]);
            head.push([2, 5, -3, C.eyeWhite]);
            head.push([2, 5, -4, C.eye]);
            head.push([-3, 6, -3, C.eye]);
            head.push([2, 6, -3, C.eye]);
            /* Long curved fangs */
            head.push([-1, 2, -4, 0xf0f0e0]);
            head.push([-1, 1, -4, 0xf0f0e0]);
            head.push([0, 2, -4, 0xf0f0e0]);
            head.push([0, 1, -4, 0xf0f0e0]);
            /* Forked tongue */
            head.push([0, 1, -5, 0xc02040]);
            head.push([-1, 0, -5, 0xc02040]);
            head.push([1, 0, -5, 0xc02040]);

            R = {
                bodyType: "serpent",
                headVoxels: head, headPivot: [0, neckH, neckZ], headHp: 28,
                torsoVoxels: torso, torsoPivot: [0, 0, 0], torsoHp: 70,
                armLVoxels: [], armRVoxels: [],
                armLPivot: [0, 0, 0], armRPivot: [0, 0, 0],
                legLVoxels: [], legRVoxels: [],
                legLPivot: [0, 0, 0], legRPivot: [0, 0, 0],
                colH: 1.1, colHW: 0.40,
                eyeY: (neckH + 5) * vs,
                startsCrawling: true,
            };
        }

        /* ==========================================================
           7. GREY (Voidtwin) — huge head, two 3D bulging eyes
           ========================================================== */
        else if (shape === "grey") {
            const legLen = 14, torsoH = 18, armLen = 12;
            const neckH = 4;

            /* Small body + thin neck */
            const torso = [];
            for (let y = 0; y < torsoH; y++) {
                const w = 3 - Math.round(y / 8);
                for (let x = -w; x <= w; x++)
                    for (let z = -1; z <= 1; z++) torso.push([x, y, z, C.skin]);
            }

            /* Huge head */
            const head = [];
            for (let x = -5; x <= 4; x++)
                for (let y = 0; y <= 8; y++)
                    for (let z = -3; z <= 2; z++) {
                        const ax = Math.abs(x), az = Math.abs(z);
                        if (y === 8 && (ax >= 4 || az >= 2)) continue;
                        if (y === 0 && (ax >= 4 || az >= 2)) continue;
                        if (y >= 1 && y <= 2 && ax >= 4) continue;
                        head.push([x, y, z, C.skin]);
                    }
            /* *** TWO 3D ALMOND EYES BULGING OUT *** */
            for (const [ex0, ex1] of [[-4, -2], [1, 3]]) {
                for (let x = ex0; x <= ex1; x++)
                    for (let y = 4; y <= 6; y++) {
                        const dL = Math.abs(x - (ex0 + ex1) / 2);
                        const dY = Math.abs(y - 5);
                        if (dL + dY > 2.5) continue;
                        /* Bulge outward 2 voxels */
                        head.push([x, y, -4, dL + dY <= 1 ? C.pupil : C.eye]);
                        head.push([x, y, -5, C.eye]);
                    }
            }
            /* Thin mouth slit */
            for (let x = -1; x <= 0; x++) head.push([x, 2, -4, C.mouth]);
            /* Nostrils */
            head.push([-2, 3, -4, C.skinDark]);
            head.push([1, 3, -4, C.skinDark]);

            /* Long thin arms with wide fingers */
            const armL = limb(-armLen, armLen, 1.8, 1.8, 2.4, 2.4, 0.8, () => C.skin);
            const armR = mirrorX(armL);
            /* Wide-finger tips */
            for (const arm of [armL, armR]) {
                for (let i = 0; i < arm.length; i++) {
                    if (arm[i][1] === -armLen) arm[i][3] = 0x8070c0;
                }
            }

            const legL = limb(-legLen, legLen, 2, 2, 2.6, 2.6, 0.9, () => C.skin);
            const legR = mirrorX(legL);

            R = {
                bodyType: "humanoid",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 28,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 55,
                armLVoxels: armL, armRVoxels: armR,
                armLPivot: [-4, torsoH - 1, 0], armRPivot: [4, torsoH - 1, 0],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-2, legLen, 0], legRPivot: [2, legLen, 0],
                colH: (legLen + torsoH + 9) * vs, colHW: 0.30,
                eyeY: (legLen + torsoH + 5) * vs,
            };
        }

        /* ==========================================================
           8. HOPPER (Bloom) — pink big-headed long-leg alien
           ========================================================== */
        else if (shape === "hopper") {
            const legLen = 20, torsoH = 6, armLen = 6;

            /* Big round head with 4 small eyes and 2 antennae */
            const head = [];
            const headR = 5;
            for (let x = -headR; x <= headR; x++)
                for (let y = -headR; y <= headR; y++)
                    for (let z = -headR; z <= headR; z++) {
                        const d2 = x * x + y * y + z * z;
                        if (d2 > headR * headR) continue;
                        let col = C.skin;
                        if (y > headR - 2) col = C.skinShade;
                        else if (y < -headR + 2) col = C.skinDark;
                        head.push([x, y + headR, z, col]);
                    }
            /* Four small forward eyes */
            head.push([-3, headR + 2, -headR, C.eye]);
            head.push([-2, headR + 2, -headR, C.eye]);
            head.push([2, headR + 2, -headR, C.eye]);
            head.push([3, headR + 2, -headR, C.eye]);
            head.push([-3, headR + 1, -headR, C.eyeWhite]);
            head.push([3, headR + 1, -headR, C.eyeWhite]);
            /* Small mouth */
            head.push([0, headR - 2, -headR, C.mouth]);
            head.push([-1, headR - 2, -headR, C.mouth]);
            /* Two long antennae */
            for (const ax of [-4, 3]) {
                head.push([ax, headR * 2 + 1, 0, C.skinDark]);
                head.push([ax, headR * 2 + 2, 0, C.skinDark]);
                head.push([ax, headR * 2 + 3, 0, 0xff80c0]);
                head.push([ax, headR * 2 + 4, 0, 0xff80c0]);
            }

            /* Tiny torso */
            const torso = blob(torsoH * 0.5, 3, torsoH * 0.5, 2, 3, () => C.skin);

            /* Small arms */
            const armL = [];
            for (let i = 0; i < 4; i++) armL.push([-2 - i, -i, 0, C.skin]);
            const armR = mirrorX(armL);

            /* Very long thin legs */
            const legL = limb(-legLen, legLen, 1.8, 1.8, 2.4, 2.4, 0.8,
                (x, y, z, t) => (t < 0.1 ? C.skinDark : C.skin));
            const legR = mirrorX(legL);

            R = {
                bodyType: "hopper",
                headVoxels: head, headPivot: [0, torsoH, 0], headHp: 30,
                torsoVoxels: torso, torsoPivot: [0, legLen, 0], torsoHp: 45,
                armLVoxels: armL, armRVoxels: armR,
                armLPivot: [-3, torsoH - 1, 0], armRPivot: [3, torsoH - 1, 0],
                legLVoxels: legL, legRVoxels: legR,
                legLPivot: [-2, legLen, 0], legRPivot: [2, legLen, 0],
                colH: (legLen + torsoH + 16) * vs, colHW: 0.30,
                eyeY: (legLen + torsoH + 6) * vs,
            };
        }

        else {
            return buildAlien(Object.assign({}, preset, { shape: "grey" }));
        }

        const parts = {
            legL: {
                pivot: R.legLPivot, hp: 22, isLeg: true, parent: "root",
                voxels: makeFlesh(R.legLVoxels)
            },
            legR: {
                pivot: R.legRPivot, hp: 22, isLeg: true, parent: "root",
                voxels: makeFlesh(R.legRVoxels)
            },
            torso: {
                pivot: R.torsoPivot, hp: R.torsoHp, isLeg: false, parent: "root",
                voxels: makeFlesh(R.torsoVoxels)
            },
            head: {
                pivot: R.headPivot, hp: R.headHp, isLeg: false, parent: "torso",
                voxels: makeFlesh(R.headVoxels)
            },
            armL: {
                pivot: R.armLPivot, hp: 18, isLeg: false, parent: "torso",
                voxels: makeFlesh(R.armLVoxels)
            },
            armR: {
                pivot: R.armRPivot, hp: 18, isLeg: false, parent: "torso",
                voxels: makeFlesh(R.armRVoxels)
            },
        };

        applyVoxelOverrides(parts, preset);

        return {
            voxelSize: vs,
            bodyType: R.bodyType,
            hp: preset.hp != null ? preset.hp : 60,
            speedWalk: preset.speedWalk != null ? preset.speedWalk : 1.6,
            speedRun: preset.speedRun != null ? preset.speedRun : 3.4,
            attackDamage: preset.attackDamage != null ? preset.attackDamage : 10,
            attackRange: preset.attackRange != null ? preset.attackRange : 1.5,
            eyeY: R.eyeY,
            colHW: preset.colHW != null ? preset.colHW : R.colHW,
            colH: preset.colH != null ? preset.colH : R.colH,
            hitCenterY: preset.hitCenterY != null ? preset.hitCenterY : R.colH * 0.55,
            hitHW: preset.hitHW != null ? preset.hitHW : R.colHW * 1.3,
            hitHH: preset.hitHH != null ? preset.hitHH : R.colH * 0.55,
            startsCrawling: !!preset.startsCrawling || !!R.startsCrawling,
            parts,
        };
    }

    /* ============================================================
       ZOMBIE TYPES (unchanged stats — only the visual model changed)
       ============================================================ */
    const ZOMBIE_TYPES = {

        walker: buildZombie({
            face: "drool", hp: 150, speedWalk: 1.2, speedRun: 1.5, attackDamage: 10,
            attackRange: 1.5,
        }),

        runner: buildZombie({
            face: "shock", voxelSize: 0.0325,
            palette: {
                skin: 0xc0b0a0, skinDark: 0x9a8a7a, skinShade: 0xa89a8a,
                cloth: 0x9a2a2a, clothLight: 0xb84040, clothDark: 0x601818,
                pants: 0x2a2a2a, pantsDark: 0x181818,
                eye: 0xff3030, eyeWhite: 0xff3030,
                flesh: 0xb02828, fleshDark: 0x7a1616
            },
            hp: 100, speedWalk: 1.3, speedRun: 1.6, attackDamage: 12, attackRange: 1.5,
            colHW: 0.24, colH: 1.35, hitHW: 0.32, hitHH: 0.80, hitCenterY: 0.80
        }),

        rotter: buildZombie({
            face: "drool",
            palette: {
                skin: 0x5a6a40, skinDark: 0x3f4c2b, skinShade: 0x4c5a36,
                cloth: 0x4a3a20, clothLight: 0x5c4a2a, clothDark: 0x302518,
                pants: 0x3a2a18, pantsDark: 0x251810,
                wound: 0x802020, flesh: 0x7a1818, fleshDark: 0x500e0e
            },
            hp: 225, speedWalk: 1.1, speedRun: 1.3, attackDamage: 15, attackRange: 1.5,
            colHW: 0.30, colH: 1.45
        }),

        brute: buildZombie({
            face: "roar", voxelSize: 0.0475, armLen: 20, legLen: 18, torsoH: 22,
            palette: {
                skin: 0x4a3a2a, skinDark: 0x352619, skinShade: 0x403020,
                cloth: 0x201820, clothLight: 0x302830, clothDark: 0x100810,
                pants: 0x181018, pantsDark: 0x0a050a,
                eye: 0xff8020, wound: 0x801010,
                flesh: 0x901818, fleshDark: 0x5c0e0e
            },
            hp: 625, speedWalk: 1.1, speedRun: 1.4, attackDamage: 25, attackRange: 1.7,
            colHW: 0.42, colH: 1.85, hitHW: 0.50, hitHH: 1.15, hitCenterY: 1.15
        }),

        crawler: buildZombie({
            face: "ghoul", voxelSize: 0.03,
            palette: {
                skin: 0x6a5040, skinDark: 0x4a3528, skinShade: 0x5a4030,
                cloth: 0x3a3020, clothDark: 0x201810
            },
            hp: 88, speedWalk: 1.1, speedRun: 1.2, attackDamage: 8, attackRange: 1.2,
            colHW: 0.22, colH: 0.85, hitHW: 0.30, hitHH: 0.50, hitCenterY: 0.50,
            startsCrawling: true
        }),

        hatty: buildZombie({
            face: "grin", hat: "cap", hatColor: 0xd0a030, outfit: "shirt",
            palette: {
                skin: 0x7a9060, skinDark: 0x5c7048, skinShade: 0x6a8055,
                cloth: 0xe8e0d0, clothLight: 0xf2ecdc, clothDark: 0xb0a898,
                pants: 0x3a4a30, pantsDark: 0x28331f, wound: 0x9a2020,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 163, speedWalk: 1.2, speedRun: 1.5, attackDamage: 10, attackRange: 1.5
        }),

        hooded: buildZombie({
            face: "shadow", hat: "hood", hatColor: 0x2a3038,
            palette: {
                skin: 0x6a7a50, skinDark: 0x4a5a30, skinShade: 0x5a6a40,
                cloth: 0x2a3038, clothLight: 0x3a4048, clothDark: 0x181c20,
                pants: 0x2a2a2a, pantsDark: 0x181818,
                eye: 0xffaa20, flesh: 0x941818, fleshDark: 0x5c0e0e
            },
            hp: 188, speedWalk: 1.2, speedRun: 1.4, attackDamage: 12, attackRange: 1.5,
            colHW: 0.30, colH: 1.45
        }),

        oldblood: buildZombie({
            face: "squint",
            palette: {
                skin: 0xa06050, skinDark: 0x804030, skinShade: 0x905040,
                hair: 0x2a1810, hairDark: 0x18100a,
                cloth: 0x6a4830, clothLight: 0x7a5840, clothDark: 0x4a3020,
                pants: 0x3a2a18, pantsDark: 0x251810,
                eye: 0xffc060, eyeWhite: 0xf0d8b0, wound: 0x901818,
                flesh: 0x8a1818, fleshDark: 0x5c0e0e
            },
            hp: 200, speedWalk: 1.1, speedRun: 1.4, attackDamage: 14, attackRange: 1.5,
            colHW: 0.30, colH: 1.50
        }),

        capboy: buildZombie({
            face: "blank", voxelSize: 0.031, armLen: 14, legLen: 14, torsoH: 16,
            hat: "cap", hatColor: 0x2a4a9a, outfit: "shorts",
            palette: {
                skin: 0x7a9060, skinDark: 0x5c7048, skinShade: 0x6a8055,
                cloth: 0x3a6aaa, clothLight: 0x4a7abb, clothDark: 0x1e3a68,
                pants: 0x3a3a3a, pantsDark: 0x242424,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 75, speedWalk: 1.3, speedRun: 1.6, attackDamage: 8, attackRange: 1.3,
            colHW: 0.22, colH: 1.20, hitHW: 0.30, hitHH: 0.68, hitCenterY: 0.68
        }),

        beanie: buildZombie({
            face: "sneer", hat: "beanie", hatColor: 0xc02020,
            palette: {
                skin: 0xb0c0a0, skinDark: 0x8a9a78, skinShade: 0x9cac8c,
                cloth: 0x6a6a70, clothLight: 0x8a8a90, clothDark: 0x3a3a40,
                pants: 0x2a3038, pantsDark: 0x181c20,
                eye: 0xffcc30, flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 138, speedWalk: 1.2, speedRun: 1.5, attackDamage: 11, attackRange: 1.5
        }),

        blondie: buildZombie({
            face: "surprise", hair: "long", outfit: "shirt",
            palette: {
                skin: 0x7a9060, skinDark: 0x5c7048, skinShade: 0x6a8055,
                hair: 0xd8a848, hairDark: 0xa87c20,
                cloth: 0xd08030, clothLight: 0xe09a44, clothDark: 0x9a5a18,
                pants: 0x3a3040, pantsDark: 0x241e2a,
                eye: 0xffcc30, eyeWhite: 0xf0e8d0,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 150, speedWalk: 1.2, speedRun: 1.5, attackDamage: 10, attackRange: 1.5
        }),

        demon: buildZombie({
            face: "snarl", hat: "horns", hatColor: 0x2a1810,
            palette: {
                skin: 0xb03020, skinDark: 0x7a1810, skinShade: 0x9a2818,
                hair: 0x1a0a08, hairDark: 0x0a0504,
                cloth: 0x3a1818, clothLight: 0x5a2828, clothDark: 0x200808,
                pants: 0x2a1a10, pantsDark: 0x180e08,
                eye: 0xffcc30, eyeWhite: 0xffe8b0, wound: 0x601010,
                flesh: 0xc04030, fleshDark: 0x7a1810
            },
            hp: 250, speedWalk: 1.3, speedRun: 1.6, attackDamage: 18, attackRange: 1.5,
            colHW: 0.32, colH: 1.55
        }),

        skull: buildZombie({
            face: "skull", hair: "bald",
            palette: {
                skin: 0xd8d4c0, skinDark: 0xa8a494, skinShade: 0xc0bcac,
                cloth: 0x6a6a70, clothLight: 0x8a8a90, clothDark: 0x3a3a40,
                pants: 0x3a3a40, pantsDark: 0x242428,
                eye: 0x0a0a0a, eyeWhite: 0x0a0a0a, mouth: 0x0a0a0a,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 175, speedWalk: 1.2, speedRun: 1.4, attackDamage: 12, attackRange: 1.5
        }),

        formal: buildZombie({
            face: "monocle", outfit: "tie",
            palette: {
                skin: 0x7a9060, skinDark: 0x5c7048, skinShade: 0x6a8055,
                cloth: 0xe8e0d0, clothLight: 0xf2ecdc, clothDark: 0xa8a090,
                pants: 0x2a2a2a, pantsDark: 0x181818,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 150, speedWalk: 1.2, speedRun: 1.5, attackDamage: 11, attackRange: 1.5
        }),

        vested: buildZombie({
            face: "grit", voxelSize: 0.0375, armLen: 18, legLen: 18, torsoH: 20,
            outfit: "vest",
            palette: {
                skin: 0x7a9060, skinDark: 0x5c7048, skinShade: 0x6a8055,
                cloth: 0x8a5a20, clothLight: 0xa87430, clothDark: 0x3a2810,
                pants: 0x3a3030, pantsDark: 0x201818,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 188, speedWalk: 1.2, speedRun: 1.4, attackDamage: 13, attackRange: 1.5,
            colHW: 0.30, colH: 1.55
        }),

        stripey: buildZombie({
            face: "goofy", outfit: "striped",
            palette: {
                skin: 0x7a9060, skinDark: 0x5c7048, skinShade: 0x6a8055,
                cloth: 0xc03028, clothLight: 0xe8e0d0, clothDark: 0x802020,
                pants: 0x2a3038, pantsDark: 0x181c20,
                flesh: 0xa22222, fleshDark: 0x6e1414
            },
            hp: 138, speedWalk: 1.2, speedRun: 1.5, attackDamage: 10, attackRange: 1.5
        }),

        /* ============================================================
       ALIEN TYPES — non-humanoid bodies (see buildAlien)
       ============================================================ */

        greyscout: buildAlien({
            shape: "greenscout", voxelSize: 0.0325,
            palette: {
                skin: 0x60c040, skinDark: 0x3a8828, skinShade: 0x50a838,
                hair: 0x3a8828, eye: 0x101010, eyeWhite: 0xffffff,
                mouth: 0x1a3a10, flesh: 0x60a040, fleshDark: 0x3a6020,
            },
            hp: 138, speedWalk: 1.3, speedRun: 1.6,
            attackDamage: 11, attackRange: 1.5,
        }),

        blobtron: buildAlien({
            shape: "blob", voxelSize: 0.038,
            hp: 175, speedWalk: 1.1, speedRun: 1.4,
            attackDamage: 14, attackRange: 1.6,
        }),

        trilens: buildAlien({
            shape: "stalker", voxelSize: 0.033,
            palette: {
                skin: 0xf07020, skinDark: 0xa84808, skinShade: 0xd06018,
                hair: 0xa84808, eye: 0x101010, eyeWhite: 0xfff0a0,
                mouth: 0x401808, flesh: 0xd05818, fleshDark: 0x903008,
            },
            hp: 150, speedWalk: 1.2, speedRun: 1.5,
            attackDamage: 12, attackRange: 1.5,
        }),

        imp: buildAlien({
            shape: "insect", voxelSize: 0.070,
            palette: {
                skin: 0xd02020, skinDark: 0x801010, skinShade: 0xa81818,
                hair: 0x300808, eye: 0xffe040, eyeWhite: 0xfff8c0,
                mouth: 0x400808, flesh: 0xb02020, fleshDark: 0x701010,
            },
            hp: 225, speedWalk: 1.3, speedRun: 1.6,
            attackDamage: 18, attackRange: 1.6,
        }),

        wisp: buildAlien({
            shape: "cyclops", voxelSize: 0.068,
            palette: {
                skin: 0x30d0a0, skinDark: 0x1a8a6a, skinShade: 0x28b888,
                hair: 0x1a8a6a, eye: 0x101010, eyeWhite: 0xffffff,
                mouth: 0x0a3a2a, flesh: 0x40b090, fleshDark: 0x206050,
            },
            hp: 150, speedWalk: 1.2, speedRun: 1.4,
            attackDamage: 11, attackRange: 1.5,
        }),

        serpent: buildAlien({
            shape: "serpent", voxelSize: 0.065,
            palette: {
                skin: 0x4080d0, skinDark: 0x2050a0, skinShade: 0x3068b8,
                hair: 0x2050a0, eye: 0xffe040, eyeWhite: 0xfff8c0,
                mouth: 0x201030, flesh: 0x4080c0, fleshDark: 0x205080,
            },
            hp: 200, speedWalk: 1.1, speedRun: 1.2,
            attackDamage: 16, attackRange: 1.4,
        }),

        voidtwin: buildAlien({
            shape: "grey", voxelSize: 0.066,
            palette: {
                skin: 0x8060d0, skinDark: 0x5030a0, skinShade: 0x6850b8,
                hair: 0x5030a0, eye: 0x101010, eyeWhite: 0xffffff,
                mouth: 0x201030, flesh: 0x7060b0, fleshDark: 0x483880,
            },
            hp: 163, speedWalk: 1.2, speedRun: 1.5,
            attackDamage: 12, attackRange: 1.5,
        }),

        bloom: buildAlien({
            shape: "hopper", voxelSize: 0.066,
            palette: {
                skin: 0xc060c0, skinDark: 0x802080, skinShade: 0xa040a0,
                hair: 0x802080, eye: 0x101010, eyeWhite: 0xffffff,
                mouth: 0x300830, flesh: 0xa050a0, fleshDark: 0x682868,
            },
            hp: 150, speedWalk: 1.2, speedRun: 1.5,
            attackDamage: 11, attackRange: 1.5,
        }),
    };

    /* ==== BOSS DRAFTS ==== */

    function _miniBoss() {
        const m = buildZombie({
            face: "shadow", voxelSize: 0.1, armLen: 34, legLen: 16, torsoH: 24,
            palette: {
                skin: 0x9a9a92, skinDark: 0x6a6a66, skinShade: 0x808080,
                cloth: 0x2a2a2a, clothLight: 0x3a3a3a, clothDark: 0x1a1a1a,
                pants: 0x1a1a1c, pantsDark: 0x0a0a0c,
                eye: 0xff2020, eyeWhite: 0xff6020,
                wound: 0x8a1818, flesh: 0xa02020, fleshDark: 0x6a1010,
                teeth: 0xf0e0c0, mouth: 0x300808,
                brain: 0xd04060, brainDark: 0x801828, brainLight: 0xf07090,
                stitch: 0xd8d0c0,
            },
            hp: 4000, speedWalk: 0.4, speedRun: 2.0, attackDamage: 45,
            attackRange: 3.0, colHW: 1.1, colH: 2.8,
            hitHW: 1.5,        // was 1.2
            hitHH: 2.2,        // was 1.6
            hitCenterY: 2.2,   // was 1.6  → box now spans 0 m to 4.4 m
        });

        const torso = m.parts.torso.voxels;
        const armL = m.parts.armL.voxels;
        const armR = m.parts.armR.voxels;
        const head = m.parts.head.voxels;

        /* ---- 1. HULKING SHOULDERS & ARMS ---- */
        for (const arm of [armL, armR]) {
            const extraVoxels = [];
            for (let i = 0; i < arm.length; i++) {
                const v = arm[i];
                // Expand the upper arm/shoulder area
                if (v[1] > -16 && v[1] < -2) {
                    extraVoxels.push([v[0] + (v[0] > 0 ? 1 : -1), v[1], v[2], v[3]]);
                    if (Math.random() < 0.3) extraVoxels.push([v[0], v[1], v[2] + 1, v[3]]);
                }
                // Expand the forearms/fists
                if (v[1] <= -16 && v[1] > -34) {
                    extraVoxels.push([v[0] + (v[0] > 0 ? 1 : -1), v[1], v[2], v[3]]);
                }
            }
            for (let i = 0; i < extraVoxels.length; i++) {
                arm.push(extraVoxels[i]);
            }
        }

        /* ---- 2. TEAL VEINS & BLOODY HANDS ---- */
        for (const arm of [armL, armR]) {
            for (const v of arm) {
                if ((v[0] + v[1] + v[2]) % 7 === 0 && v[3] === 0x9a9a92) {
                    v[3] = 0x40b0a0;
                }
                // Bloody hands/fists at the bottom
                if (v[1] <= -28) {
                    v[3] = 0x6a1010;
                    if (Math.random() < 0.3) v[3] = 0xa02020;
                }
            }
        }

        /* ---- 3. EXPOSED RIBS ---- */
        for (let y = 6; y < 24; y += 2) {
            for (let x = -4; x <= 4; x++) {
                if (Math.abs(x) < 2) continue;
                if (y === 8 || y === 12 || y === 16 || y === 20) {
                    torso.push([x, y, -5 - Math.floor(Math.abs(x) * 0.2), 0xd8d0c0]);
                }
            }
        }

        /* ---- 4. SMALL HEAD ON BIG BODY ---- */
        for (let x = -4; x <= 3; x++) {
            head.push([x, 2, -4, 0x2a2a2a]);
            head.push([x, 1, -4, 0x1a1a1a]);
        }
        head.push([-2, 5, -5, 0xff2020]);
        head.push([1, 5, -5, 0xff2020]);

        /* ---- 5. HUNCHED POSTURE ---- */
        for (const v of torso) v[2] -= 1;
        for (const v of head) v[2] -= 1;

        return m;
    }

    function _finalBoss() {
        const m = buildZombie({
            face: 'roar',
            voxelSize: 0.12,
            armLen: 32, legLen: 28, torsoH: 34,
            palette: {
                skin: 0x4a1010, skinDark: 0x2a0808, skinShade: 0x3a0a0a,
                cloth: 0x0a0202, clothLight: 0x140404, clothDark: 0x000000,
                pants: 0x0a0402, pantsDark: 0x000000,
                eye: 0xffe020, eyeWhite: 0xffe880,
                wound: 0x400808, flesh: 0x801010, fleshDark: 0x4a0808,
                teeth: 0xfff0d0, mouth: 0x200404,
                necrosis: 0x100404,
                brain: 0x602040, brainDark: 0x401028, brainLight: 0x905060,
                stitch: 0xa09070,
            },
            hp: 12000, speedWalk: 1.5, speedRun: 2.1,
            attackDamage: 80, attackRange: 2.6,
            colHW: 1.05, colH: 3.4,
            hitHW: 1.2, hitHH: 2.0, hitCenterY: 2.0,
        });

        /* ---- Jagged back spine ---- */
        const torso = m.parts.torso.voxels;
        for (let y = 4; y < 30; y += 2) {
            const h = Math.round(2 + Math.sin(y * 0.4) * 1.5);
            for (let i = 0; i < h; i++) {
                torso.push([0, y + i, 4 + i, i === 0 ? 0x101010 : 0x201010]);
            }
        }

        /* ---- Barbed wing stubs on the shoulders ---- */
        for (const sx of [-1, 1]) {
            for (let i = 0; i < 5; i++) {
                torso.push([sx * (9 + i), 20 - i, 0, 0x2a1010]);
                torso.push([sx * (9 + i), 19 - i, 1, 0x1a0808]);
            }
        }

        /* ---- Glowing rib-cage runes ---- */
        for (let y = 10; y < 22; y += 2) {
            for (let x = -5; x <= 5; x++) {
                if (Math.abs(x) < 2) continue;
                if ((x + y) % 3 === 0) {
                    torso.push([x, y, -5 - Math.floor(Math.abs(x) * 0.2), 0xd04020]);
                }
            }
        }

        /* ---- Demon crown: gold with bone spikes ---- */
        const head = m.parts.head.voxels;
        for (let dx = -6; dx <= 6; dx++) {
            head.push([dx, 14, 0, 0xd8b040]);
            head.push([dx, 15, 0, 0xffd860]);
            if (dx % 2 === 0) head.push([dx, 16, 0, 0xffd860]);
        }
        /* Bone horns curling forward */
        for (const side of [-1, 1]) {
            const hx0 = side * 6;
            for (let i = 0; i < 8; i++) {
                head.push([hx0 + side * Math.round(i * 0.4), 14 + i, -Math.round(i * 0.3), 0x1a0a06]);
            }
            head.push([hx0 + side * 3, 22, -3, 0xf0e0c0]);
        }
        /* Glowing eyes set into the crown base */
        head.push([-3, 13, -5, 0xffe020]);
        head.push([2, 13, -5, 0xffe020]);

        return m;
    }

    /* wire into MODELS after ZOMBIE_TYPES is built */
    ZOMBIE_TYPES.__mini_boss__ = _miniBoss();
    ZOMBIE_TYPES.__final_boss__ = _finalBoss();

    const MODELS = ZOMBIE_TYPES;

    /* =========================================================================
       MESHING  (unchanged)
       ========================================================================= */

    const FACES = [
        { n: [1, 0, 0], shade: 0.86, c: [[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1]] },
        { n: [-1, 0, 0], shade: 0.86, c: [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]] },
        { n: [0, 1, 0], shade: 1.00, c: [[0, 1, 0], [0, 1, 1], [1, 1, 0], [1, 1, 1]] },
        { n: [0, -1, 0], shade: 0.55, c: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] },
        { n: [0, 0, 1], shade: 0.74, c: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] },
        { n: [0, 0, -1], shade: 0.74, c: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0]] },
    ];

    function buildVoxelGeometry(voxels, vs) {
        if (!voxels.length) return null;

        const solid = new Set();
        for (const v of voxels) solid.add(vk(v[0], v[1], v[2]));

        const positions = [], normals = [], colors = [], indices = [];
        let cursor = 0;

        for (const [x, y, z, hex] of voxels) {
            const r = ((hex >> 16) & 255) / 255;
            const g = ((hex >> 8) & 255) / 255;
            const b = (hex & 255) / 255;
            for (let f = 0; f < 6; f++) {
                const face = FACES[f];
                const nx = x + face.n[0];
                const ny = y + face.n[1];
                const nz = z + face.n[2];
                if (solid.has(vk(nx, ny, nz))) continue;
                for (let k = 0; k < 4; k++) {
                    const cnr = face.c[k];
                    positions.push((x + cnr[0]) * vs, (y + cnr[1]) * vs, (z + cnr[2]) * vs);
                    normals.push(face.n[0], face.n[1], face.n[2]);
                    colors.push(r * face.shade, g * face.shade, b * face.shade);
                }
                indices.push(cursor, cursor + 1, cursor + 2, cursor + 1, cursor + 3, cursor + 2);
                cursor += 4;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        geo.setIndex(indices);
        geo.computeBoundingSphere();
        return geo;
    }

    const ENEMY_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });

    const _singleVoxelGeoCache = new Map();
    function singleVoxelGeometry(hex, vs) {
        const key = hex + "@" + vs;
        let g = _singleVoxelGeoCache.get(key);
        if (g) return g;
        g = buildVoxelGeometry([[0, 0, 0, hex]], vs);
        _singleVoxelGeoCache.set(key, g);
        return g;
    }

    /* Each DETACHED_PARTS entry is now a WHOLE disconnected cluster
       (one geometry, one draw call) instead of one mesh per voxel.
       Lower cap → less VRAM churn, still plenty of gore on screen. */
    const MAX_DETACHED = 220;

    /* =========================================================================
       BLOOD DROPS (unchanged)
       ========================================================================= */
    const BLOOD_DROPS = [];
    const MAX_BLOOD_DROPS = 240;

    const BLOOD_MAT = new THREE.MeshLambertMaterial({ color: 0xa01818, fog: true });

    let _bloodGeo = null;
    function getBloodGeo() {
        if (!_bloodGeo) _bloodGeo = new THREE.BoxGeometry(0.025, 0.025, 0.025);
        return _bloodGeo;
    }

    function spawnBloodDrop(x, y, z) {
        if (BLOOD_DROPS.length >= MAX_BLOOD_DROPS) {
            const oldest = BLOOD_DROPS.shift();
            scene.remove(oldest.mesh);
        }
        const mesh = new THREE.Mesh(getBloodGeo(), BLOOD_MAT);
        mesh.position.set(x, y, z);
        scene.add(mesh);

        const life = 1.4 + Math.random() * 1.0;
        BLOOD_DROPS.push({
            mesh,
            vel: new THREE.Vector3(
                (Math.random() - 0.5) * 0.9,
                0.6 + Math.random() * 0.9,
                (Math.random() - 0.5) * 0.9,
            ),
            life: life, maxLife: life, grounded: false,
        });
    }

    function updateBloodDrops(dt) {
        for (let i = BLOOD_DROPS.length - 1; i >= 0; i--) {
            const d = BLOOD_DROPS[i];
            d.life -= dt;
            if (d.life <= 0) { scene.remove(d.mesh); BLOOD_DROPS.splice(i, 1); continue; }
            if (d.grounded) {
                const s = Math.max(0.05, d.life / d.maxLife);
                d.mesh.scale.setScalar(s);
                continue;
            }
            d.vel.y -= GRAVITY * dt;
            d.mesh.position.x += d.vel.x * dt;
            d.mesh.position.y += d.vel.y * dt;
            d.mesh.position.z += d.vel.z * dt;
            const gx = Math.floor(d.mesh.position.x / VOXEL);
            const gy = Math.floor(d.mesh.position.y / VOXEL);
            const gz = Math.floor(d.mesh.position.z / VOXEL);
            if (getV(gx, gy, gz) !== 0) {
                d.mesh.position.y = (gy + 1) * VOXEL + 0.02;
                d.vel.set(0, 0, 0);
                d.grounded = true;
                d.life = Math.min(d.life, 0.9);
                d.maxLife = 0.9;
            }
            if (d.mesh.position.y < -3) { scene.remove(d.mesh); BLOOD_DROPS.splice(i, 1); }
        }
    }

    const _bleedTmp = new THREE.Vector3();
    function updateBleeding(e, dt) {
        for (const key in e.parts) {
            const part = e.parts[key];
            if (!part.connected) continue;
            if (part.bleedTimer <= 0) continue;
            part.bleedTimer -= dt;
            part.bleedSpawnTimer -= dt;
            if (part.bleedSpawnTimer <= 0 && part.voxels.length > 0) {
                part.bleedSpawnTimer = 0.10 + Math.random() * 0.18;
                const idx = (Math.random() * part.voxels.length) | 0;
                voxelWorldPosition(part, part.voxels[idx], e.model.voxelSize, _bleedTmp);
                const n = 1 + (Math.random() < 0.35 ? 1 : 0);
                for (let k = 0; k < n; k++) {
                    spawnBloodDrop(
                        _bleedTmp.x + (Math.random() - 0.5) * 0.06,
                        _bleedTmp.y + (Math.random() - 0.5) * 0.06,
                        _bleedTmp.z + (Math.random() - 0.5) * 0.06,
                    );
                }
            }
        }
    }

    /* =========================================================================
       RIG CONSTRUCTION  (unchanged)
       ========================================================================= */

    function buildEnemyRig(model) {
        const root = new THREE.Group();
        const parts = {};

        for (const key in model.parts) {
            const spec = model.parts[key];
            const voxels = spec.voxels.map((v) => v.slice());
            const pivot = new THREE.Group();
            pivot.position.set(
                spec.pivot[0] * model.voxelSize,
                spec.pivot[1] * model.voxelSize,
                spec.pivot[2] * model.voxelSize,
            );
            const mesh = new THREE.Mesh(
                buildVoxelGeometry(voxels, model.voxelSize) || new THREE.BufferGeometry(),
                ENEMY_MAT,
            );
            pivot.add(mesh);

            const anchorIdx = findAnchorIndex(voxels);
            const anchorVoxel = anchorIdx >= 0 ? voxels[anchorIdx].slice() : null;

            parts[key] = {
                key, pivot, mesh, voxels,
                hp: spec.hp, maxHp: spec.hp,
                isLeg: !!spec.isLeg,
                parent: spec.parent || "root",
                basePivot: [
                    spec.pivot[0] * model.voxelSize,
                    spec.pivot[1] * model.voxelSize,
                    spec.pivot[2] * model.voxelSize,
                ],
                anchorVoxel, connected: true,
                bleedTimer: 0, bleedSpawnTimer: 0,
            };
        }

        for (const key in parts) {
            const part = parts[key];
            const parent =
                part.parent === "root" ? root :
                    parts[part.parent] ? parts[part.parent].pivot : root;
            parent.add(part.pivot);
        }

        return { root, parts };
    }

    function rebuildPartGeometry(part, vs) {
        if (part.mesh.geometry) part.mesh.geometry.dispose();
        part.mesh.geometry = buildVoxelGeometry(part.voxels, vs) || new THREE.BufferGeometry();
    }

    function partVoxelAABB(part, vs) {
        let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
        let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
        for (const v of part.voxels) {
            if (v[0] < mnX) mnX = v[0];
            if (v[0] > mxX) mxX = v[0];
            if (v[1] < mnY) mnY = v[1];
            if (v[1] > mxY) mxY = v[1];
            if (v[2] < mnZ) mnZ = v[2];
            if (v[2] > mxZ) mxZ = v[2];
        }
        if (!isFinite(mnX)) return { cx: 0, cy: 0, cz: 0, radius: 0.08 };
        const ex = (mxX - mnX + 1) * vs;
        const ey = (mxY - mnY + 1) * vs;
        const ez = (mxZ - mnZ + 1) * vs;
        return {
            cx: ((mnX + mxX + 1) * 0.5) * vs,
            cy: ((mnY + mxY + 1) * 0.5) * vs,
            cz: ((mnZ + mxZ + 1) * 0.5) * vs,
            // true bounding-sphere radius = half-diagonal
            radius: 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez),
        };
    }

    function partCentreWorld(part, vs, out) {
        refreshEnemyMatrices(part);
        const aabb = partVoxelAABB(part, vs);
        out.set(aabb.cx, aabb.cy, aabb.cz).applyMatrix4(part.mesh.matrixWorld);
        return out;
    }

    /* Compute the local Y of the lowest remaining voxel in the whole rig,
   walking the part → parent chain and adding each pivot's Y. */
    function computeLowestVoxelY(e) {
        const vs = e.model.voxelSize;
        let lowest = Infinity;

        function visit(partKey, parentY) {
            const p = e.parts[partKey];
            if (!p) return;
            const thisY = parentY + p.basePivot[1];
            if (p.connected && p.voxels.length > 0) {
                const voxels = p.voxels;
                for (let i = 0; i < voxels.length; i++) {
                    const wy = thisY + voxels[i][1] * vs;
                    if (wy < lowest) lowest = wy;
                }
            }
            for (const ck in e.parts) {
                if (e.parts[ck].parent === partKey) visit(ck, thisY);
            }
        }

        for (const key in e.parts) {
            if (e.parts[key].parent === "root") visit(key, 0);
        }
        return lowest;
    }

    /* Record a baseline at spawn (0 offset), then only shift when parts get
       carved AWAY.  This preserves existing look for crawlers (which start
       with empty legs on purpose). */
    function updateVisualGroundOffset(e) {
        if (!e || !e.model) return;
        const current = computeLowestVoxelY(e);
        if (!isFinite(current)) { e._visualYOffset = 0; return; }
        if (e._groundBaseline == null) {
            e._groundBaseline = current;
            e._visualYOffset = 0;
            return;
        }
        const delta = current - e._groundBaseline;
        e._visualYOffset = delta > 0 ? -delta : 0;
    }

    /* =========================================================================
       VOXEL CONNECTIVITY  (unchanged)
       ========================================================================= */

    const VOX_DIRS = [
        [1, 0, 0], [-1, 0, 0],
        [0, 1, 0], [0, -1, 0],
        [0, 0, 1], [0, 0, -1],
    ];

    function voxKey(x, y, z) { return x + "," + y + "," + z; }

    /* Fast numeric key for voxel coordinates.  24 bits of headroom per axis
   (offsets of ±8 000) is plenty for enemy rigs; keeps the hot loops
   allocation-free compared to string concat. */
    function vk(x, y, z) {
        return ((x + 8000) * 16000 + (y + 8000)) * 16000 + (z + 8000);
    }

    function findAnchorIndex(voxels) {
        if (!voxels.length) return -1;
        let best = 0, bestD2 = Infinity;
        for (let i = 0; i < voxels.length; i++) {
            const v = voxels[i];
            const cx = v[0] + 0.5, cy = v[1] + 0.5, cz = v[2] + 0.5;
            const d2 = cx * cx + cy * cy + cz * cz;
            if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
        return best;
    }

    function labelComponents(voxels) {
        const solid = new Map();
        for (let i = 0; i < voxels.length; i++) {
            const v = voxels[i];
            solid.set(vk(v[0], v[1], v[2]), i);
        }
        const labels = new Int32Array(voxels.length).fill(-1);
        const clusters = [];
        for (let i = 0; i < voxels.length; i++) {
            if (labels[i] >= 0) continue;
            const id = clusters.length;
            const stack = [i];
            labels[i] = id;
            const members = [];
            while (stack.length) {
                const idx = stack.pop();
                members.push(idx);
                const v = voxels[idx];
                for (let d = 0; d < VOX_DIRS.length; d++) {
                    const dd = VOX_DIRS[d];
                    const ni = solid.get(vk(v[0] + dd[0], v[1] + dd[1], v[2] + dd[2]));
                    if (ni === undefined || labels[ni] >= 0) continue;
                    labels[ni] = id;
                    stack.push(ni);
                }
            }
            clusters.push(members);
        }
        return { labels, clusters };
    }

    function collectSurfaceVoxelIndices(part) {
        const set = new Set();
        for (const v of part.voxels) set.add(vk(v[0], v[1], v[2]));
        const out = [];
        for (let i = 0; i < part.voxels.length; i++) {
            const v = part.voxels[i];
            for (let d = 0; d < VOX_DIRS.length; d++) {
                const dd = VOX_DIRS[d];
                if (!set.has(vk(v[0] + dd[0], v[1] + dd[1], v[2] + dd[2]))) {
                    out.push(i);
                    break;
                }
            }
        }
        return out;
    }

    /**
     * Transform a voxel centre from part-local → world space.
     *
     * The optional `matrixWorld` argument lets hot loops refresh the part's
     * world matrix ONCE and then reuse it for every voxel.  Passing it skips
     * the forced `updateMatrixWorld(true)` call that used to run per voxel
     * and was the #1 cause of the freeze-on-hit stutter.
     */
    function voxelWorldPosition(part, voxel, vs, out, matrixWorld) {
        let m = matrixWorld;
        if (!m) {
            let top = part.mesh;
            while (top.parent) top = top.parent;
            top.updateMatrixWorld(true);
            m = part.mesh.matrixWorld;
        }
        out.set(
            (voxel[0] + 0.5) * vs,
            (voxel[1] + 0.5) * vs,
            (voxel[2] + 0.5) * vs,
        );
        out.applyMatrix4(m);
        return out;
    }

    const _aimCamPos = new THREE.Vector3();
    const _aimCamDir = new THREE.Vector3();
    const _aimVoxWorld = new THREE.Vector3();
    const _aimToVox = new THREE.Vector3();

    function findAimedSurfaceVoxelIndex(part, vs) {
        const surface = collectSurfaceVoxelIndices(part);
        if (!surface.length) return -1;
        const cam = Hooks.camera;
        if (!cam) return surface[(Math.random() * surface.length) | 0];
        cam.updateMatrixWorld(true);
        cam.getWorldPosition(_aimCamPos);
        cam.getWorldDirection(_aimCamDir);

        /* Refresh the part's world matrix exactly ONCE, then do the whole
           nearest-surface search in part-local space. */
        let top = part.mesh;
        while (top.parent) top = top.parent;
        top.updateMatrixWorld(true);
        _aimInv.copy(part.mesh.matrixWorld).invert();
        _aimCamPosLocal.copy(_aimCamPos).applyMatrix4(_aimInv);
        _aimCamDirLocal.copy(_aimCamDir).transformDirection(_aimInv).normalize();

        let best = -1, bestScore = Infinity, bestPerp = Infinity;
        const dlx = _aimCamDirLocal.x, dly = _aimCamDirLocal.y, dlz = _aimCamDirLocal.z;
        for (let i = 0; i < surface.length; i++) {
            const idx = surface[i];
            const v = part.voxels[idx];
            const tox = (v[0] + 0.5) * vs - _aimCamPosLocal.x;
            const toy = (v[1] + 0.5) * vs - _aimCamPosLocal.y;
            const toz = (v[2] + 0.5) * vs - _aimCamPosLocal.z;
            const t = tox * dlx + toy * dly + toz * dlz;
            if (t <= 0.15) continue;
            const px = tox - dlx * t;
            const py = toy - dly * t;
            const pz = toz - dlz * t;
            const perp = Math.sqrt(px * px + py * py + pz * pz);
            const score = perp + t * 0.015;
            if (score < bestScore) { bestScore = score; bestPerp = perp; best = idx; }
        }
        if (best < 0 || bestPerp > 0.45)
            return surface[(Math.random() * surface.length) | 0];
        return best;
    }

    /* =========================================================================
       DETACHED CLUSTER SPAWNER
       -------------------------------------------------------------------------
       Builds ONE merged mesh for a whole disconnected voxel cluster instead
       of one mesh per voxel.  The geometry is translated so the mesh origin
       sits at the cluster's AABB center — that lets us use the mesh position
       as a cheap bounding-sphere collider.
    
       The cluster stores:
         · radius       — bounding-sphere radius (voxel-unit scaled to world)
         · halfExtentY  — vertical half-height for ground checks / colliders
         · voxelCount   — used to decide "small debris" vs "solid piece"
       ========================================================================= */
    function spawnVoxelCluster(voxelArray, vs, parentWorldPos, parentWorldQ) {
        if (!voxelArray || !voxelArray.length) return;

        /* --- AABB in voxel-local coordinates --- */
        let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
        let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
        for (const v of voxelArray) {
            if (v[0] < mnX) mnX = v[0];
            if (v[0] > mxX) mxX = v[0];
            if (v[1] < mnY) mnY = v[1];
            if (v[1] > mxY) mxY = v[1];
            if (v[2] < mnZ) mnZ = v[2];
            if (v[2] > mxZ) mxZ = v[2];
        }

        /* Cluster center in WORLD units (relative to the parent's local origin) */
        const localCx = (mnX + mxX + 1) * 0.5 * vs;
        const localCy = (mnY + mxY + 1) * 0.5 * vs;
        const localCz = (mnZ + mxZ + 1) * 0.5 * vs;

        /* ONE geometry for the whole cluster */
        const geo = buildVoxelGeometry(voxelArray, vs);
        if (!geo) return;

        /* Re-center geometry around its own AABB center */
        geo.translate(-localCx, -localCy, -localCz);

        /* Place in world space */
        const localCenter = new THREE.Vector3(localCx, localCy, localCz);
        const worldCenter = localCenter
            .clone()
            .applyQuaternion(parentWorldQ)
            .add(parentWorldPos);

        const mesh = new THREE.Mesh(geo, ENEMY_MAT);
        mesh.position.copy(worldCenter);
        mesh.quaternion.copy(parentWorldQ);
        scene.add(mesh);

        /* Collision metadata */
        const extentX = (mxX - mnX + 1) * vs;
        const extentY = (mxY - mnY + 1) * vs;
        const extentZ = (mxZ - mnZ + 1) * vs;
        const radius = 0.5 * Math.max(extentX, extentY, extentZ);

        /* Enforce cap — dispose oldest geometry properly */
        if (DETACHED_PARTS.length >= MAX_DETACHED) {
            const oldest = DETACHED_PARTS.shift();
            scene.remove(oldest.mesh);
            if (oldest.mesh.geometry) oldest.mesh.geometry.dispose();
        }

        DETACHED_PARTS.push({
            mesh,
            sharedGeometry: false,       // this cluster owns its geometry
            vel: new THREE.Vector3(
                (Math.random() - 0.5) * 3.5,
                1.5 + Math.random() * 2.0,
                (Math.random() - 0.5) * 3.5,
            ),
            angVel: new THREE.Vector3(
                (Math.random() - 0.5) * 3.5,
                (Math.random() - 0.5) * 2.5,
                (Math.random() - 0.5) * 3.5,
            ),
            quat: parentWorldQ.clone(),
            life: 6.0,
            rests: false,
            radius: radius,
            halfExtentY: extentY * 0.5,
            voxelCount: voxelArray.length,
        });
    }

    function detachDisconnectedClusters(part, vs) {
        if (!part.connected) return;
        if (part.voxels.length < 2) return;
        const originalVoxels = part.voxels;
        const { labels, clusters } = labelComponents(originalVoxels);
        if (clusters.length <= 1) return;
        let anchorCluster = -1;
        if (part.anchorVoxel) {
            const ai = originalVoxels.findIndex(
                v => v[0] === part.anchorVoxel[0] &&
                    v[1] === part.anchorVoxel[1] &&
                    v[2] === part.anchorVoxel[2],
            );
            if (ai >= 0) anchorCluster = labels[ai];
        }
        if (anchorCluster < 0) {
            let largest = 0, largestSize = 0;
            for (let c = 0; c < clusters.length; c++) {
                if (clusters[c].length > largestSize) { largestSize = clusters[c].length; largest = c; }
            }
            anchorCluster = largest;
        }
        const kept = clusters[anchorCluster].map(i => originalVoxels[i]);
        part.voxels = kept;
        rebuildPartGeometry(part, vs);
        refreshEnemyMatrices(part);
        const worldPos = new THREE.Vector3();
        const worldQ = new THREE.Quaternion();
        const worldScale = new THREE.Vector3();
        part.mesh.matrixWorld.decompose(worldPos, worldQ, worldScale);
        for (let c = 0; c < clusters.length; c++) {
            if (c === anchorCluster) continue;
            const idxs = clusters[c];
            /* One mesh for the WHOLE cluster (was: one mesh per voxel!) */
            const clusterVoxels = idxs.map(i => originalVoxels[i]);
            spawnVoxelCluster(clusterVoxels, vs, worldPos, worldQ);
        }
    }

    function refreshEnemyMatrices(part) {
        let top = part.mesh;
        while (top.parent) top = top.parent;
        top.updateMatrixWorld(true);
    }

    /* =========================================================================
       CARVE  (unchanged)
       ========================================================================= */
    function carvePartAt(part, hitWorld, radiusVox, vs) {
        if (!part.connected || !part.voxels.length) return 0;
        let top = part.mesh;
        while (top.parent) top = top.parent;
        top.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(part.mesh.matrixWorld).invert();
        const local = hitWorld.clone().applyMatrix4(inv);
        const cx = local.x / vs;
        const cy = local.y / vs;
        const cz = local.z / vs;
        const R = Math.max(0.6, radiusVox);
        const r2 = R * R;
        const keep = [];
        let removed = 0;
        for (const v of part.voxels) {
            const dx = (v[0] + 0.5) - cx;
            const dy = (v[1] + 0.5) - cy;
            const dz = (v[2] + 0.5) - cz;
            if (dx * dx + dy * dy + dz * dz <= r2) { removed++; continue; }
            keep.push(v);
        }
        if (removed === 0) return 0;
        part.voxels = keep;
        rebuildPartGeometry(part, vs);
        detachDisconnectedClusters(part, vs);
        if (part.connected) {
            const add = 2.5 + Math.min(removed, 6) * 0.35;
            part.bleedTimer = Math.min(10, (part.bleedTimer || 0) + add);
            if (part.bleedSpawnTimer > 0.05) part.bleedSpawnTimer = 0.02;
        }
        if (part.voxels.length === 0 && part.connected && part.owner) {
            markPartDead(part, part.owner);
        }

        if (part.owner && part.owner._mpId && !part.owner._remoteOwned &&
            window.ARiveMP && window.ARiveMP.connected && window.ARiveMP.isHost &&
            window.ARiveMP.onEnemyCarved) {
            try {
                window.ARiveMP.onEnemyCarved(
                    part.owner._mpId, part.key,
                    hitWorld.x, hitWorld.y, hitWorld.z,
                    radiusVox,
                );
            } catch (err) { }
        }

        if (part.owner) updateVisualGroundOffset(part.owner);

        return removed;
    }

    /* =========================================================================
       ENEMY LIST
       ========================================================================= */
    const enemies = Hooks.enemies || [];
    if (!Hooks.enemies) Hooks.enemies = enemies;
    const MAX_ENEMIES = 16;
    const DETACHED_PARTS = [];

    /* --- Boss Projectiles (Thrown Blocks) --- */
    const bossProjectiles = [];
    const MAX_BOSS_PROJECTILES = 5;
    const blockGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const blockMat = new THREE.MeshLambertMaterial({ color: 0x6a6a66, fog: true });

    // ─── Tunables ─────────────────────────────────────────────
    const BOSS_THROW_SPEED = 9;    // horizontal m/s — lower = slower + higher arc
    const BOSS_THROW_BLAST = 1.5;  // impact blast radius in METRES (was 0.3 m!)
    const BOSS_THROW_HIT_R = 2.0;  // trigger radius vs. player (metres, was ~1.2 m)

    /* ---- MINI-BOSS THROW: find & break a nearby world voxel CLUSTER ---- */

    /* Convert the raw voxel value from getV() into a usable hex colour.
       If it looks like a packed 0xRRGGBB we use it directly; otherwise
       (i.e. it's just a small type index) fall back to the stone colour. */
    function voxelValueToColor(val) {
        if (val === 0) return 0x6a6a66;
        if (val >= 0x10000 && val <= 0xffffff) return val;
        return 0x6a6a66;
    }

    function findNearbyVoxelClusterForThrow(e) {
        const toPlayerX = player.pos.x - e.pos.x;
        const toPlayerZ = player.pos.z - e.pos.z;
        const dist = Math.hypot(toPlayerX, toPlayerZ) || 1;
        const fx = toPlayerX / dist, fz = toPlayerZ / dist;

        const forwardOffset = Math.min(2.0, Math.max(1.0, dist * 0.35));
        const baseX = e.pos.x + fx * forwardOffset;
        const baseZ = e.pos.z + fz * forwardOffset;
        const baseY = e.pos.y;

        const bvx = Math.floor(baseX / VOXEL);
        const bvy = Math.floor(baseY / VOXEL);
        const bvz = Math.floor(baseZ / VOXEL);

        // Locate the nearest solid voxel to anchor the cluster
        let centerVX = null, centerVY = null, centerVZ = null;
        let bestDist = Infinity;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
                for (let dz = -3; dz <= 3; dz++) {
                    const vx = bvx + dx, vy = bvy + dy, vz = bvz + dz;
                    if (getV(vx, vy, vz) !== 0) {
                        const d = dx * dx + dy * dy + dz * dz;
                        if (d < bestDist) {
                            bestDist = d;
                            centerVX = vx; centerVY = vy; centerVZ = vz;
                        }
                    }
                }
            }
        }
        if (centerVX === null) return null;

        // *** Radius of the collected / carved chunk, in VOXEL units. ***
        // This single number now drives BOTH the block size AND the hole size.
        const R = 10;

        // Collect every solid voxel INSIDE the sphere of radius R.
        // Restricting to a sphere (not a cube) makes the held block exactly
        // match what carveSphere will remove from the terrain.
        const voxels = [];
        const R2 = R * R;
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                for (let dz = -R; dz <= R; dz++) {
                    if (dx * dx + dy * dy + dz * dz > R2) continue;
                    const vx = centerVX + dx;
                    const vy = centerVY + dy;
                    const vz = centerVZ + dz;
                    const val = getV(vx, vy, vz);
                    if (val !== 0) {
                        voxels.push({ vx, vy, vz, color: voxelValueToColor(val) });
                    }
                }
            }
        }
        if (voxels.length < 6) return null;

        return { voxels, centerVX, centerVY, centerVZ, R };
    }

    /* Build a single merged BufferGeometry from the cluster's world voxels,
       translated so its AABB centre is at the mesh origin. */
    function buildClusterGeometry(voxels, vs) {
        if (!voxels.length) return null;

        let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
        let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
        for (const v of voxels) {
            if (v.vx < mnX) mnX = v.vx;
            if (v.vx > mxX) mxX = v.vx;
            if (v.vy < mnY) mnY = v.vy;
            if (v.vy > mxY) mxY = v.vy;
            if (v.vz < mnZ) mnZ = v.vz;
            if (v.vz > mxZ) mxZ = v.vz;
        }

        const sizeX = mxX - mnX + 1;
        const sizeY = mxY - mnY + 1;
        const sizeZ = mxZ - mnZ + 1;

        const localVoxels = voxels.map(v => [
            v.vx - mnX,
            v.vy - mnY,
            v.vz - mnZ,
            v.color,
        ]);

        const geo = buildVoxelGeometry(localVoxels, vs);
        if (!geo) return null;

        // Center geometry on its own AABB centre
        geo.translate(
            -sizeX * 0.5 * vs,
            -sizeY * 0.5 * vs,
            -sizeZ * 0.5 * vs,
        );

        const centerWorld = new THREE.Vector3(
            (mnX + mxX + 1) * 0.5 * vs,
            (mnY + mxY + 1) * 0.5 * vs,
            (mnZ + mxZ + 1) * 0.5 * vs,
        );

        return {
            geo,
            centerWorld,
            size: Math.max(sizeX, sizeY, sizeZ) * vs,
            halfY: sizeY * 0.5 * vs,
        };
    }

    function spawnHeldBlockForThrow(e) {
        const cluster = findNearbyVoxelClusterForThrow(e);
        let startPos = null;
        let mesh = null;
        let blockSize = 0.6;
        let blockHalfY = 0.3;

        if (cluster) {
            const built = buildClusterGeometry(cluster.voxels, VOXEL);
            if (built && built.geo) {
                // Build the mesh BEFORE carving — this is the exact block
                startPos = built.centerWorld.clone();
                blockSize = built.size;
                blockHalfY = built.halfY;

                mesh = new THREE.Mesh(built.geo, ENEMY_MAT);
                mesh.position.copy(startPos);
                mesh.rotation.set(
                    (Math.random() - 0.5) * 0.25,
                    Math.random() * Math.PI * 2,
                    (Math.random() - 0.5) * 0.25,
                );

                // Now carve that same region out of the world — SAME radius
                // the cluster was collected with, so the hole matches the block.
                if (Hooks.carveSphere) {
                    Hooks.carveSphere(
                        cluster.centerVX, cluster.centerVY, cluster.centerVZ,
                        cluster.R,
                        { ignite: false, debrisChance: 0.4 },
                    );
                }
            }
        }

        // Fallback — simple stone box if no terrain was reachable
        if (!mesh) {
            const size = 0.7;
            blockSize = size;
            blockHalfY = size * 0.5;
            const geo = new THREE.BoxGeometry(size, size, size);
            const fx = Math.sin(e.yaw + Math.PI);
            const fz = Math.cos(e.yaw + Math.PI);
            startPos = new THREE.Vector3(
                e.pos.x + fx * 1.5,
                e.pos.y + 0.4,
                e.pos.z + fz * 1.5,
            );
            mesh = new THREE.Mesh(geo, blockMat);
            mesh.position.copy(startPos);
        }

        scene.add(mesh);
        e.heldBlock = {
            mesh,
            startPos: startPos.clone(),
            size: blockSize,
            halfY: blockHalfY,
        };
    }

    /* Get the "hand" (bottom-centre) of an arm part in world space. */
    const _handTmp = new THREE.Vector3();
    function getArmHandWorldPos(armPart, out) {
        if (!armPart || !armPart.connected || !armPart.mesh || !armPart.mesh.geometry) {
            out.set(0, 0, 0);
            return out;
        }
        const geom = armPart.mesh.geometry;
        if (!geom.boundingBox) geom.computeBoundingBox();
        const bb = geom.boundingBox;
        if (!bb || !isFinite(bb.min.y)) {
            armPart.pivot.getWorldPosition(out);
            return out;
        }
        out.set(
            (bb.min.x + bb.max.x) * 0.5,
            bb.min.y,
            (bb.min.z + bb.max.z) * 0.5,
        ).applyMatrix4(armPart.mesh.matrixWorld);
        return out;
    }

    /* Place the held block at the midpoint of both hands. */
    const _handL = new THREE.Vector3();
    const _handR = new THREE.Vector3();
    const _heldTarget = new THREE.Vector3();

    function updateHeldBlockPosition(e, dt) {
        const hb = e.heldBlock;
        if (!hb || !hb.mesh) return;
        const armL = e.parts.armL;
        const armR = e.parts.armR;
        if (!armL || !armR) return;

        // Refresh world matrices so we read this frame's hand transform
        e.rig.root.updateMatrixWorld(true);

        getArmHandWorldPos(armL, _handL);
        getArmHandWorldPos(armR, _handR);

        _heldTarget.set(
            (_handL.x + _handR.x) * 0.5,
            (_handL.y + _handR.y) * 0.5 + (hb.halfY || 0.3) * 0.5,
            (_handL.z + _handR.z) * 0.5,
        );

        const k = Math.min(1, dt * 15);
        hb.mesh.position.lerp(_heldTarget, k);
    }

    /* Release the held voxel chunk as a ballistic projectile.
   Called from animateMiniBoss at T = 4.0 (end of the throw phase). */
    function launchHeldBlock(e) {
        if (e._blockThrown) return;
        e._blockThrown = true;

        // Safety: if the held block is somehow gone, fall back to a plain box
        if (!e.heldBlock || !e.heldBlock.mesh) {
            spawnBossBlock(e);
            return;
        }

        const mesh = e.heldBlock.mesh;
        e.heldBlock = null;

        const startX = mesh.position.x;
        const startY = mesh.position.y;
        const startZ = mesh.position.z;

        const targetX = player.pos.x;
        const targetY = player.pos.y + 0.9;
        const targetZ = player.pos.z;

        const dx = targetX - startX;
        const dy = targetY - startY;
        const dz = targetZ - startZ;
        const distH = Math.hypot(dx, dz);

        // Ballistic aim — solve for vy so the chunk lands on the player
        // after the same flight time the old fixed-speed throw used.
        const t = Math.max(0.35, distH / BOSS_THROW_SPEED);
        const vy = (dy + 0.5 * GRAVITY * t * t) / t;
        const hx = distH > 1e-4 ? dx / distH : 0;
        const hz = distH > 1e-4 ? dz / distH : 0;

        const vel = new THREE.Vector3(
            hx * BOSS_THROW_SPEED,
            vy,
            hz * BOSS_THROW_SPEED,
        );

        // Enforce projectile cap — dispose the oldest thrown chunk properly
        if (bossProjectiles.length >= MAX_BOSS_PROJECTILES) {
            const oldest = bossProjectiles.shift();
            scene.remove(oldest.mesh);
            if (oldest.ownsGeometry && oldest.mesh.geometry) {
                oldest.mesh.geometry.dispose();
            }
        }

        // ownsGeometry: true — this chunk's BufferGeometry is unique
        // (built from buildVoxelGeometry for the carved cluster), so it
        // must be disposed when the projectile dies.
        bossProjectiles.push({ mesh, vel, life: 6.0, ownsGeometry: true });
        e.attackPhase = 0.001;
        if (window.Sfx) Sfx.play("voxel_break");
    }

    function spawnBossBlock(e) {
        if (bossProjectiles.length >= MAX_BOSS_PROJECTILES) {
            const oldest = bossProjectiles.shift();
            scene.remove(oldest.mesh);
        }

        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), blockMat);
        const startX = e.pos.x + (player.pos.x > e.pos.x ? 1.2 : -1.2);
        const startY = e.pos.y + 2.0;
        const startZ = e.pos.z;
        mesh.position.set(startX, startY, startZ);
        scene.add(mesh);

        const targetX = player.pos.x;
        const targetY = player.pos.y + 0.9;
        const targetZ = player.pos.z;

        const dx = targetX - startX;
        const dy = targetY - startY;
        const dz = targetZ - startZ;
        const distH = Math.hypot(dx, dz);

        // ── Ballistic aim ────────────────────────────────────────
        // The old code just nudged vel.y by dist*0.25, which only
        // works at speed 11.  With a slower throw it would fall
        // way short.  Solve for vy so the block still arrives at
        // the target after the longer flight time.
        const t = Math.max(0.35, distH / BOSS_THROW_SPEED);
        const vy = (dy + 0.5 * GRAVITY * t * t) / t;
        const hx = distH > 1e-4 ? dx / distH : 0;
        const hz = distH > 1e-4 ? dz / distH : 0;

        const vel = new THREE.Vector3(
            hx * BOSS_THROW_SPEED,
            vy,
            hz * BOSS_THROW_SPEED,
        );

        bossProjectiles.push({ mesh, vel, life: 6.0 });

        e.attackPhase = 0.001;
        if (window.Sfx) Sfx.play("voxel_break");
    }

    /* =========================================================================
   STONE WAVE (ground slam projectile — travels forward, NO terrain damage)
   ========================================================================= */
    const stoneWaves = [];
    const MAX_STONE_WAVES = 6;
    const STONE_WAVE_SPEED = 7.5;   // m/s forward
    const STONE_WAVE_LIFE = 1.5;   // seconds
    const STONE_WAVE_HIT_R = 1.5;   // damage radius vs player
    const STONE_WAVE_DAMAGE = 35;

    const DUST_PARTICLES = [];
    const MAX_DUST = 200;
    const DUST_MAT = new THREE.MeshLambertMaterial({ color: 0x8a7a60, fog: true });
    let _dustGeo = null;
    function getDustGeo() {
        if (!_dustGeo) _dustGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
        return _dustGeo;
    }

    function spawnDustBurst(x, y, z, count) {
        for (let i = 0; i < count; i++) {
            if (DUST_PARTICLES.length >= MAX_DUST) {
                const old = DUST_PARTICLES.shift();
                scene.remove(old.mesh);
            }
            const mesh = new THREE.Mesh(getDustGeo(), DUST_MAT);
            mesh.position.set(
                x + (Math.random() - 0.5) * 0.5,
                y + Math.random() * 0.4,
                z + (Math.random() - 0.5) * 0.5,
            );
            scene.add(mesh);
            const life = 0.6 + Math.random() * 0.6;
            DUST_PARTICLES.push({
                mesh,
                vel: new THREE.Vector3(
                    (Math.random() - 0.5) * 1.8,
                    0.7 + Math.random() * 1.4,
                    (Math.random() - 0.5) * 1.8,
                ),
                life, maxLife: life,
            });
        }
    }

    function updateDustParticles(dt) {
        for (let i = DUST_PARTICLES.length - 1; i >= 0; i--) {
            const d = DUST_PARTICLES[i];
            d.life -= dt;
            if (d.life <= 0) {
                scene.remove(d.mesh);
                DUST_PARTICLES.splice(i, 1);
                continue;
            }
            d.vel.y -= 7 * dt;
            d.mesh.position.x += d.vel.x * dt;
            d.mesh.position.y += d.vel.y * dt;
            d.mesh.position.z += d.vel.z * dt;
            const s = Math.max(0.3, d.life / d.maxLife);
            d.mesh.scale.setScalar(s * 1.3);
        }
    }

    let _stoneHillGeo = null;
    function getStoneHillGeometry() {
        if (_stoneHillGeo) return _stoneHillGeo;
        const voxels = [];
        const R = 4;
        for (let dy = 0; dy <= R; dy++) {
            const ringR2 = (R - dy + 0.5) * (R - dy + 0.5);
            for (let dx = -R; dx <= R; dx++) {
                for (let dz = -R; dz <= R; dz++) {
                    if (dx * dx + dz * dz > ringR2) continue;
                    let col;
                    const h = hash3(dx * 13, dy * 7, dz * 19);
                    if (dy === 0) col = 0x4a4a46;
                    else if (dy >= R - 1) col = 0x8a8a82;
                    else if (h > 0.7) col = 0x555550;
                    else if (h > 0.4) col = 0x6a6a66;
                    else col = 0x7a7a72;
                    voxels.push([dx, dy, dz, col]);
                }
            }
        }
        _stoneHillGeo = buildVoxelGeometry(voxels, 0.1);
        return _stoneHillGeo;
    }

    function spawnStoneWave(e) {
        if (stoneWaves.length >= MAX_STONE_WAVES) {
            const old = stoneWaves.shift();
            scene.remove(old.mesh);
        }

        // Direction is LOCKED at slam start.  Model "front" is local −z, so with
        // rotation.y = yaw the world forward direction is (−sin yaw, 0, −cos yaw).
        const dirX = -Math.sin(e.slamYaw);
        const dirZ = -Math.cos(e.slamYaw);

        const startX = e.pos.x + dirX * 1.5;
        const startZ = e.pos.z + dirZ * 1.5;

        let groundY = e.pos.y;
        const vx = Math.floor(startX / VOXEL);
        const vz = Math.floor(startZ / VOXEL);
        for (let y = SY - 1; y > 0; y--) {
            if (getV(vx, y, vz) !== 0) { groundY = (y + 1) * VOXEL; break; }
        }

        const mesh = new THREE.Mesh(getStoneHillGeometry(), ENEMY_MAT);
        mesh.position.set(startX, groundY, startZ);
        mesh.scale.setScalar(0.35);
        scene.add(mesh);

        stoneWaves.push({
            mesh, dirX, dirZ,
            life: STONE_WAVE_LIFE, maxLife: STONE_WAVE_LIFE,
            dustTimer: 0, hitPlayer: false,
        });

        spawnDustBurst(startX, groundY + 0.2, startZ, 25);
        spawnDustBurst(e.pos.x + dirX * 0.5, e.pos.y + 0.2, e.pos.z + dirZ * 0.5, 15);

        if (window.Sfx) Sfx.play("explosion");
        if (Hooks.shakeCamera) Hooks.shakeCamera(0.85);
    }

    function updateStoneWaves(dt) {
        for (let i = stoneWaves.length - 1; i >= 0; i--) {
            const w = stoneWaves[i];
            w.life -= dt;
            w.dustTimer -= dt;

            if (w.life <= 0) {
                scene.remove(w.mesh);
                stoneWaves.splice(i, 1);
                continue;
            }

            const step = STONE_WAVE_SPEED * dt;
            w.mesh.position.x += w.dirX * step;
            w.mesh.position.z += w.dirZ * step;

            const vx = Math.floor(w.mesh.position.x / VOXEL);
            const vz = Math.floor(w.mesh.position.z / VOXEL);
            for (let y = SY - 1; y > 0; y--) {
                if (getV(vx, y, vz) !== 0) { w.mesh.position.y = (y + 1) * VOXEL; break; }
            }

            const t = 1 - w.life / w.maxLife;
            const bulge = Math.sin(t * Math.PI);
            const s = 0.35 + bulge * 1.0;
            w.mesh.scale.set(s, s * 1.2, s);

            if (w.dustTimer <= 0) {
                w.dustTimer = 0.04 + Math.random() * 0.04;
                spawnDustBurst(w.mesh.position.x, w.mesh.position.y + 0.15, w.mesh.position.z, 2);
            }

            if (!w.hitPlayer && player && player.alive) {
                const dx = player.pos.x - w.mesh.position.x;
                const dy = (player.pos.y + player.height * 0.4) - (w.mesh.position.y + 0.5);
                const dz = player.pos.z - w.mesh.position.z;
                if (dx * dx + dy * dy + dz * dz < STONE_WAVE_HIT_R * STONE_WAVE_HIT_R) {
                    w.hitPlayer = true;
                    if (Hooks.damagePlayer) Hooks.damagePlayer(STONE_WAVE_DAMAGE);
                    if (Hooks.shakeCamera) Hooks.shakeCamera(0.5);
                    spawnDustBurst(player.pos.x, player.pos.y + 0.5, player.pos.z, 10);
                }
            }
        }
    }

    function updateBossProjectiles(dt) {
        for (let i = bossProjectiles.length - 1; i >= 0; i--) {
            const p = bossProjectiles[i];
            p.life -= dt;

            if (p.life <= 0) {
                scene.remove(p.mesh);
                if (p.ownsGeometry && p.mesh.geometry) p.mesh.geometry.dispose();
                bossProjectiles.splice(i, 1);
                continue;
            }

            p.vel.y -= GRAVITY * dt;
            p.mesh.position.addScaledVector(p.vel, dt);
            p.mesh.rotation.x += dt * 10;
            p.mesh.rotation.y += dt * 8;

            // 1. Close enough to the player → detonate
            const dx = p.mesh.position.x - player.pos.x;
            const dy = p.mesh.position.y - (player.pos.y + 0.9);
            const dz = p.mesh.position.z - player.pos.z;
            const hitR2 = BOSS_THROW_HIT_R * BOSS_THROW_HIT_R;
            if (dx * dx + dy * dy + dz * dz < hitR2) {
                const vx = Math.floor(p.mesh.position.x / VOXEL);
                const vy = Math.floor(p.mesh.position.y / VOXEL);
                const vz = Math.floor(p.mesh.position.z / VOXEL);
                if (Hooks.explodeAt) Hooks.explodeAt(vx, vy, vz, BOSS_THROW_BLAST);
                if (Hooks.shakeCamera) Hooks.shakeCamera(0.55);
                if (Hooks.spawnBloodBurst) {
                    Hooks.spawnBloodBurst(
                        p.mesh.position.x, p.mesh.position.y, p.mesh.position.z, 15,
                    );
                }
                scene.remove(p.mesh);
                if (p.ownsGeometry && p.mesh.geometry) p.mesh.geometry.dispose();
                bossProjectiles.splice(i, 1);
                continue;
            }

            // 2. Hit the world → detonate
            const vx = Math.floor(p.mesh.position.x / VOXEL);
            const vy = Math.floor(p.mesh.position.y / VOXEL);
            const vz = Math.floor(p.mesh.position.z / VOXEL);
            if (getV(vx, vy, vz) !== 0) {
                if (Hooks.explodeAt) {
                    Hooks.explodeAt(vx, vy, vz, BOSS_THROW_BLAST);
                } else if (Hooks.carveSphere) {
                    // Fallback for older game.js without Hooks.explodeAt
                    Hooks.carveSphere(vx, vy, vz, 35, { ignite: false, debrisChance: 0.4 });
                }
                if (Hooks.shakeCamera) Hooks.shakeCamera(0.4);
                scene.remove(p.mesh);
                if (p.ownsGeometry && p.mesh.geometry) p.mesh.geometry.dispose();
                bossProjectiles.splice(i, 1);
                continue;
            }
        }
    }

    /* ==== DEATH ANIMATION STATE ============================================= */
    const _dTmp = new THREE.Vector3();
    const _dQuat = new THREE.Quaternion();
    const _dYaw = new THREE.Quaternion();
    const _dUp = new THREE.Vector3(0, 1, 0);
    const _dDown = new THREE.Vector3(0, -1, 0);

    function spawnEnemy(type, atPos, mpId) {          // <-- new third arg
        let _aliveCount = 0;
        for (let i = 0; i < enemies.length; i++) if (enemies[i].alive) _aliveCount++;
        if (_aliveCount >= MAX_ENEMIES) return null;

        const model = MODELS[type] || MODELS.walker;
        let sx, sy, sz;
        if (atPos) {
            sx = atPos.x; sy = atPos.y; sz = atPos.z;
        } else {
            const p = player.pos;
            let placed = null;
            for (let i = 0; i < 30; i++) {
                const a = Math.random() * Math.PI * 2;
                const d = 10 + Math.random() * 12;
                const tx = p.x + Math.cos(a) * d;
                const tz = p.z + Math.sin(a) * d;
                if (tx > 2 && tx < WORLD_W - 2 && tz > 2 && tz < WORLD_D - 2) {
                    placed = { x: tx, z: tz }; break;
                }
            }
            if (!placed) placed = { x: clamp(p.x, 2, WORLD_W - 2), z: clamp(p.z, 2, WORLD_D - 2) };
            sx = placed.x; sz = placed.z;
            sy = 100;
            const vx = Math.floor(sx / VOXEL), vz = Math.floor(sz / VOXEL);
            for (let y = SY - 1; y > 0; y--) {
                if (getV(vx, y, vz) !== 0) { sy = (y + 1) * VOXEL + 0.05; break; }
            }
        }
        const rig = buildEnemyRig(model);
        rig.root.position.set(sx, sy, sz);
        scene.add(rig.root);
        const e = {
            kind: type, model, rig, mesh: rig.root,
            pos: new THREE.Vector3(sx, sy, sz),
            vel: new THREE.Vector3(),
            yaw: Math.random() * Math.PI * 2,
            hp: model.hp, maxHp: model.hp,
            onGround: false, alive: true,
            walkPhase: Math.random() * Math.PI * 2,
            attackPhase: 0, attackTimer: 0, hitFlash: 0,
            hitSlowTimer: 0,
            state: "wander", wanderTarget: null, wanderTimer: 0,
            losTimer: 0, canSeePlayer: false, stuckTimer: 0,
            lastX: sx, lastZ: sz, parts: rig.parts,
            crawlMode: false, crawlBlend: 0, _anim: null,
        };

        e.behavior = createBehavior(BEHAVIOR_BY_KIND[type] || 'shuffler');

        // NEW: MP identity
        e._mpId = mpId || genEnemyId();
        e._remoteOwned = !!mpId;
        e._targetX = e.pos.x;
        e._targetY = e.pos.y;
        e._targetZ = e.pos.z;
        e._targetYaw = e.yaw;

        const startingVoxels = enemyVoxelCount(e);
        e.deathVoxelThreshold = Math.max(30, Math.floor(startingVoxels * 0.15));
        rig.root.userData.enemyRef = e;
        for (const key in rig.parts) rig.parts[key].owner = e;
        if (model.startsCrawling) {
            e.crawlMode = true;
            e.crawlBlend = 1;
            for (const legKey of ["legL", "legR"]) {
                const leg = e.parts[legKey];
                if (!leg) continue;
                leg.connected = false;
                leg.voxels = [];
                if (leg.mesh) leg.mesh.visible = false;
            }
        }

        // Record the model's natural ground contact as the baseline.
        updateVisualGroundOffset(e);   // sets _groundBaseline, leaves _visualYOffset = 0

        e.dying = false;
        e.deathT = 0;
        e.deathDuration = 1.1;
        e.deathScatterAt = 0.75;
        e.deathFallAxis = new THREE.Vector3(1, 0, 0);
        e.deathFallAngle = 0;
        e.deathStartY = e.pos.y;
        e.deathGroundY = e.pos.y;
        e._scattered = false;

        enemies.push(e);

        // Broadcast only for locally-owned spawns
        if (!mpId && window.ARiveMP && window.ARiveMP.onEnemySpawned) {
            try { window.ARiveMP.onEnemySpawned(e); } catch (err) { }
        }

        return e;
    }

    /* Apply (or refresh) the hit-stagger debuff.  Called by every
   damage entry point — projectile, melee, splash. */
    function applyHitSlow(e) {
        if (!e || !e.alive) return;
        const add = HIT_SLOW_MIN_ADD +
            Math.random() * (HIT_SLOW_MAX_ADD - HIT_SLOW_MIN_ADD);
        e.hitSlowTimer = Math.min(
            HIT_SLOW_DURATION * 1.5,
            (e.hitSlowTimer || 0) + add,
        );
    }

    /* =========================================================================
       DAMAGE  (unchanged)
       ========================================================================= */
    const _centre = new THREE.Vector3();

    function hurtEnemy(e, dmg, carveRadiusWorld) {
        if (!e || !e.alive) return;
        const _infinite = window.ARiveSandboxFlags && window.ARiveSandboxFlags.infiniteEnemyHealth;
        applyHitSlow(e);
        const pool = [];
        for (const key in e.parts) {
            const p = e.parts[key];
            if (!p.connected || p.voxels.length === 0) continue;
            const w = key === "torso" ? 4 : key === "head" ? 1 : 2;
            for (let i = 0; i < w; i++) pool.push(key);
        }
        if (!pool.length) { e.hp -= dmg; checkEnemyDeath(e); return; }
        const key = pool[(Math.random() * pool.length) | 0];
        const part = e.parts[key];
        const vs = e.model.voxelSize;
        const pick = findAimedSurfaceVoxelIndex(part, vs);
        if (pick < 0) { e.hp -= dmg; checkEnemyDeath(e); return; }
        const sv = part.voxels[pick];
        voxelWorldPosition(part, sv, vs, _centre);
        const radiusVox = (typeof carveRadiusWorld === "number" && carveRadiusWorld > 0)
            ? carveRadiusWorld * ENEMY_CARVE_WORLD_TO_VOX
            : 1.85;
        carvePartAt(part, _centre, radiusVox, vs);

        for (let i = 0; i < 5; i++) {
            spawnBloodDrop(
                _centre.x + (Math.random() - 0.5) * 0.10,
                _centre.y + (Math.random() - 0.5) * 0.10,
                _centre.z + (Math.random() - 0.5) * 0.10,
            );
        }
        if (!_infinite) e.hp -= dmg;
        e.hitFlash = 1.0;
        if (Hooks.spawnBloodBurst) Hooks.spawnBloodBurst(_centre.x, _centre.y, _centre.z, 8);
        if (!_infinite) checkEnemyDeath(e);
    }

    function markPartDead(part, e) {
        if (!part.connected) return;
        part.connected = false;
        if (part.mesh) part.mesh.visible = false;
        part.bleedTimer = 0;
        if (part.isLeg) {
            if (!e.parts.legL.connected && !e.parts.legR.connected) e.crawlMode = true;
        }
    }

    function enemyVoxelCount(e) {
        let total = 0;
        for (const key in e.parts) {
            const p = e.parts[key];
            if (p.connected) total += p.voxels.length;
        }
        return total;
    }

    function checkEnemyDeath(e) {
        if (!e.alive) return;
        if (window.ARiveSandboxFlags && window.ARiveSandboxFlags.infiniteEnemyHealth) return;
        if (e.hp <= 0) return killEnemy(e);
        const head = e.parts.head;
        const torso = e.parts.torso;
        if (head && !head.connected && head.voxels.length === 0) return killEnemy(e);
        if (torso && !torso.connected && torso.voxels.length === 0) return killEnemy(e);
        if (enemyVoxelCount(e) < e.deathVoxelThreshold) killEnemy(e);
    }

    function killEnemy(e) {
        if (!e.alive) return;
        e.alive = false;
        if (e.heldBlock) {
            scene.remove(e.heldBlock.mesh);
            if (e.heldBlock.mesh.geometry) e.heldBlock.mesh.geometry.dispose();
            e.heldBlock = null;
        }
        if (window.SurvivalMode) {
            try { window.SurvivalMode.onEnemyKilled(e); } catch (err) { }
        }
        e.dying = true;
        e.deathT = 0;
        e.deathDuration = 1.1;
        e.deathScatterAt = 0.75;
        e._scattered = false;
        e.deathStartY = e.pos.y;

        /* Random horizontal axis to tip the body around */
        const fallAng = Math.random() * Math.PI * 2;
        const fdx = Math.cos(fallAng);
        const fdz = Math.sin(fallAng);
        e.deathFallAxis.set(fdz, 0, -fdx).normalize();
        e.deathFallAngle = Math.PI * 0.5 * (0.85 + Math.random() * 0.30);

        /* Find the actual ground directly under the corpse so the tipping
           body lands on it instead of sinking through the floor. */
        _dTmp.set(
            e.pos.x,
            e.pos.y + (e.model.colH || 1.4) + 1.5,
            e.pos.z,
        );
        const _groundHit = raycastVoxel(_dTmp, _dDown, 32);
        e.deathGroundY = _groundHit
            ? (_groundHit.y + 1) * VOXEL
            : e.pos.y;

        /* Blood burst + drips */
        if (Hooks.spawnBloodBurst)
            Hooks.spawnBloodBurst(e.pos.x, e.pos.y + 0.8, e.pos.z, 26);
        for (let i = 0; i < 16; i++) {
            spawnBloodDrop(
                e.pos.x + (Math.random() - 0.5) * 0.5,
                e.pos.y + 0.4 + Math.random() * 1.0,
                e.pos.z + (Math.random() - 0.5) * 0.5,
            );
        }

        /* Ammo drop (unchanged) */
        if (Hooks.spawnPickup && Hooks.AMMO_BY_TYPE && Math.random() < 0.55) {
            const types = ["9mm", "5.56", "shell"];
            const type = types[(Math.random() * types.length) | 0];
            const ammoDef = Hooks.AMMO_BY_TYPE[type];
            if (ammoDef) {
                const amount = 8 + ((Math.random() * 16) | 0);
                Hooks.spawnPickup(
                    {
                        name: ammoDef.name,
                        iconImage: ammoDef.iconImage,
                        iconImageRotated: ammoDef.iconImageRotated,
                        w: ammoDef.w, h: ammoDef.h,
                        color: ammoDef.color, meta: ammoDef.meta,
                        count: amount, maxStack: ammoDef.maxStack,
                        isAmmo: true, ammoType: ammoDef.ammoType,
                    },
                    new THREE.Vector3(
                        e.pos.x + (Math.random() - 0.5) * 0.4,
                        e.pos.y + 0.55,
                        e.pos.z + (Math.random() - 0.5) * 0.4,
                    ),
                );
            }
        }

        if (!e._remoteOwned && window.ARiveMP && window.ARiveMP.onEnemyKilled) {
            try { window.ARiveMP.onEnemyKilled(e); } catch (err) { }
        }
    }

    /* ------------------------------------------------------------------
       DEATH ANIMATION
       ------------------------------------------------------------------
       The rig tips over around a random horizontal axis through the feet
       while the limbs go limp, then a bit later it detaches into physics
       chunks and finally the root is removed.
       ------------------------------------------------------------------ */
    function updateDeathAnim(e, dt) {
        e.deathT += dt;

        /* Phase 1 — tip over (0.0 → 0.7 s, ease-out) */
        const tTip = Math.min(1, e.deathT / 0.7);
        const sTip = 1 - (1 - tTip) * (1 - tTip);

        const angle = e.deathFallAngle * sTip;
        _dQuat.setFromAxisAngle(e.deathFallAxis, angle);
        _dYaw.setFromAxisAngle(_dUp, e.yaw);
        e.rig.root.quaternion.copy(_dQuat).multiply(_dYaw);

        /* Keep the tipping body sitting ON the floor.
           Rotating the rig around a horizontal axis through its feet
           makes the far-side corner drop below the pivot by
           colHW * sin(angle).  Lift the whole rig by that much so the
           body never penetrates the ground.

           If the enemy was killed in mid-air, `deathGroundY` is far
           below and we fall back to `deathStartY` — the body then just
           tips over in the air instead of being yanked to the ground. */
        const _refGround = Math.max(e.deathGroundY, e.deathStartY - 0.05);
        const _colHW = e.model.colHW || 0.28;
        e.pos.y = _refGround + _colHW * Math.sin(angle);
        e.rig.root.position.copy(e.pos);

        /* Limbs go limp */
        for (const key in e.parts) {
            const p = e.parts[key];
            if (!p.connected) continue;
            const amp = (key === "head" || key === "armL" || key === "armR")
                ? 0.55
                : 0.20;
            p.pivot.rotation.x = amp * sTip;
            p.pivot.rotation.z = ((key === "armL") ? 0.30
                : (key === "armR") ? -0.30 : 0) * sTip;
        }

        /* Keep any residual bleeding alive */
        updateBleeding(e, dt);

        /* Phase 2 — at deathScatterAt, detach every part as a physics chunk */
        if (!e._scattered && e.deathT >= e.deathScatterAt) {
            e._scattered = true;
            scatterDeadEnemy(e);
        }

        /* Phase 3 — after full duration, remove the empty root */
        if (e.deathT >= e.deathDuration) {
            scene.remove(e.rig.root);

            // ✅ 新增：释放未散架的部位几何体
            if (!e._scattered) {
                for (const key in e.parts) {
                    const p = e.parts[key];
                    if (p.mesh && p.mesh.geometry) p.mesh.geometry.dispose();
                }
            }

            const idx = enemies.indexOf(e);
            if (idx >= 0) enemies.splice(idx, 1);
        }
    }

    function scatterDeadEnemy(e) {
        for (const key in e.parts) {
            const p = e.parts[key];
            if (!p.connected) continue;
            p.mesh.updateMatrixWorld(true);
            const wp = new THREE.Vector3();
            const wq = new THREE.Quaternion();
            const ws = new THREE.Vector3();
            p.mesh.matrixWorld.decompose(wp, wq, ws);
            p.pivot.remove(p.mesh);
            p.mesh.position.copy(wp);
            p.mesh.quaternion.copy(wq);
            p.mesh.scale.copy(ws);
            scene.add(p.mesh);
            DETACHED_PARTS.push({
                mesh: p.mesh,
                vel: new THREE.Vector3(
                    (Math.random() - 0.5) * 3,
                    1.5 + Math.random() * 2,
                    (Math.random() - 0.5) * 3,
                ),
                angVel: new THREE.Vector3(
                    (Math.random() - 0.5) * 4,
                    (Math.random() - 0.5) * 3,
                    (Math.random() - 0.5) * 4,
                ),
                quat: wq.clone(),
                life: 6.0, rests: false,
            });
        }
    }

    function resolveEnemyCollisions() {
        for (let i = 0; i < enemies.length; i++) {
            const a = enemies[i];
            if (!a.alive) continue;
            const aHW = a.model.colHW || 0.28;
            const aH = (a.model.colH || 1.45) * (1 - 0.6 * a.crawlBlend);
            for (let j = i + 1; j < enemies.length; j++) {
                const b = enemies[j];
                if (!b.alive) continue;
                const bHW = b.model.colHW || 0.28;
                const bH = (b.model.colH || 1.45) * (1 - 0.6 * b.crawlBlend);

                const dx = b.pos.x - a.pos.x;
                const dz = b.pos.z - a.pos.z;
                const minD = aHW + bHW;
                const d2 = dx * dx + dz * dz;
                if (d2 > minD * minD || d2 < 1e-6) continue;
                if (a.pos.y + aH < b.pos.y || b.pos.y + bH < a.pos.y) continue;

                const d = Math.sqrt(d2);
                const overlap = minD - d;
                const nx = dx / d, nz = dz / d;
                const half = overlap * 0.5;

                const aox = a.pos.x, aoz = a.pos.z;
                const box = b.pos.x, boz = b.pos.z;

                a.pos.x -= nx * half; a.pos.z -= nz * half;
                b.pos.x += nx * half; b.pos.z += nz * half;

                if (enemyCollides(a.pos, aHW, aH)) { a.pos.x = aox; a.pos.z = aoz; }
                if (enemyCollides(b.pos, bHW, bH)) { b.pos.x = box; b.pos.z = boz; }

                a.rig.root.position.copy(a.pos);
                b.rig.root.position.copy(b.pos);
            }
        }
    }

    function resolvePlayerEnemyCollisions() {
        if (!player || !player.alive) return;
        const pHW = player.halfW;
        const pH = player.height;
        for (const e of enemies) {
            if (!e.alive) continue;
            const eHW = e.model.colHW || 0.28;
            const eH = (e.model.colH || 1.45) * (1 - 0.6 * e.crawlBlend);

            const dx = player.pos.x - e.pos.x;
            const dz = player.pos.z - e.pos.z;
            const minD = pHW + eHW;
            const d2 = dx * dx + dz * dz;
            if (d2 > minD * minD || d2 < 1e-6) continue;
            if (player.pos.y + pH < e.pos.y || player.pos.y > e.pos.y + eH) continue;

            const d = Math.sqrt(d2);
            const overlap = minD - d;
            const nx = dx / d, nz = dz / d;
            player.pos.x += nx * overlap;
            player.pos.z += nz * overlap;
        }
    }

    /* =========================================================================
       BULLET HIT  (unchanged)
       ========================================================================= */
    const _pv = new THREE.Vector3();
    const _hitV = new THREE.Vector3();

    /* Local-space scratch for the hit / aim paths — we transform the
   query point ONCE into part-local space and then do pure arithmetic,
   instead of forcing a full subtree matrix update per voxel. */
    const _hitInv = new THREE.Matrix4();
    const _hitLocal = new THREE.Vector3();
    const _tmpCarve = new THREE.Vector3();
    const _aimInv = new THREE.Matrix4();
    const _aimCamPosLocal = new THREE.Vector3();
    const _aimCamDirLocal = new THREE.Vector3();

    /* carveRadiusWorld is optional and comes from the weapon JSON.
       It maps the weapon's world-space carveRadius onto the enemy's
       voxel space.  1.1 world units ≈ 1.85 enemy voxels (the old
       hard-coded value), so we scale by 1.85 / 1.1 ≈ 1.68. */
    const ENEMY_CARVE_WORLD_TO_VOX = 1.85 / 1.1;

    function hitEnemyRay(hitX, hitY, hitZ, damage, dirX, dirY, dirZ, carveRadiusWorld) {
        const _infinite =
            window.ARiveSandboxFlags && window.ARiveSandboxFlags.infiniteEnemyHealth;
        _hitV.set(hitX, hitY, hitZ);
        let bestE = null, bestPart = null, bestD2 = Infinity;
        for (const e of enemies) {
            if (!e.alive) continue;
            const dx = hitX - e.pos.x;
            const dy = hitY - e.pos.y;
            const dz = hitZ - e.pos.z;

            // ── Per-enemy pre-filter ──────────────────────────────────
            // Vertical: allow up to 1.5× colH above the feet (bosses have
            // heads way above their collision height).
            const colH = e.model.colH || 1.45;
            if (dy < -0.6 || dy > colH * 1.5 + 0.5) continue;

            // Horizontal: allow body half-width + a big margin so arms,
            // heads, and outstretched limbs are covered.
            const halfW = Math.max(e.model.colHW || 0.28, e.model.hitHW || 0.36);
            const maxR = halfW + 1.0;
            const dxz2 = dx * dx + dz * dz;
            if (dxz2 > maxR * maxR) continue;

            for (const key in e.parts) {
                const p = e.parts[key];
                if (!p.connected || p.voxels.length === 0) continue;
                partCentreWorld(p, e.model.voxelSize, _pv);
                const d2 = _pv.distanceToSquared(_hitV);
                const radius = partVoxelAABB(p, e.model.voxelSize).radius + 0.15;
                if (d2 > radius * radius) continue;
                if (d2 < bestD2) { bestD2 = d2; bestE = e; bestPart = key; }
            }
        }
        if (!bestE) return false;

        // MP client: forward the hit to the authoritative host instead of
        // carving locally so both sides stay in lockstep.
        const _mp = window.ARiveMP;
        if (_mp && _mp.connected && !_mp.isHost && bestE._mpId && _mp.sendEnemyHurt) {
            _mp.sendEnemyHurt(bestE._mpId, hitX, hitY, hitZ, damage, dirX, dirY, dirZ, carveRadiusWorld);
            return true;
        }

        applyHitSlow(bestE);

        const part = bestE.parts[bestPart];
        const vs = bestE.model.voxelSize;

        /* Refresh the world matrix ONCE, then do the nearest-voxel search
           in part-local space.  This used to call a forced matrix update
           per voxel, which is what made every bullet hit freeze the game. */
        let top = part.mesh;
        while (top.parent) top = top.parent;
        top.updateMatrixWorld(true);

        _hitInv.copy(part.mesh.matrixWorld).invert();
        _hitLocal.copy(_hitV).applyMatrix4(_hitInv);

        let nearestVoxel = null;
        let nearestD2 = Infinity;
        const hx = _hitLocal.x, hy = _hitLocal.y, hz = _hitLocal.z;
        const voxels = part.voxels;
        for (let i = 0; i < voxels.length; i++) {
            const v = voxels[i];
            const dx = (v[0] + 0.5) * vs - hx;
            const dy = (v[1] + 0.5) * vs - hy;
            const dz = (v[2] + 0.5) * vs - hz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < nearestD2) { nearestD2 = d2; nearestVoxel = v; }
        }

        const carveAt = nearestVoxel
            ? voxelWorldPosition(part, nearestVoxel, vs, _tmpCarve, part.mesh.matrixWorld)
            : _hitV;

        const radiusVox = (typeof carveRadiusWorld === "number" && carveRadiusWorld > 0)
            ? carveRadiusWorld * ENEMY_CARVE_WORLD_TO_VOX
            : 1.85;
        carvePartAt(part, carveAt, radiusVox, vs);
        for (let i = 0; i < 5; i++) {
            spawnBloodDrop(
                carveAt.x + (Math.random() - 0.5) * 0.10,
                carveAt.y + (Math.random() - 0.5) * 0.10,
                carveAt.z + (Math.random() - 0.5) * 0.10,
            );
        }
        if (!_infinite) bestE.hp -= damage;
        bestE.hitFlash = 1.0;
        if (Hooks.spawnBloodBurst)
            Hooks.spawnBloodBurst(carveAt.x, carveAt.y, carveAt.z, 8);
        if (!_infinite) checkEnemyDeath(bestE);
        return true;
    }

    /* =========================================================================
       LINE OF SIGHT  (unchanged)
       ========================================================================= */
    const _lo = new THREE.Vector3();
    const _lt = new THREE.Vector3();
    const _ld = new THREE.Vector3();

    function canSeePlayer(e) {
        _lo.set(e.pos.x, e.pos.y + e.model.eyeY, e.pos.z);
        _lt.set(player.pos.x, player.pos.y + player.eye * 0.9, player.pos.z);
        _ld.copy(_lt).sub(_lo);
        const dist = _ld.length();
        if (dist > 32) return false;
        _ld.multiplyScalar(1 / dist);
        const hit = raycastVoxel(_lo, _ld, dist);
        if (!hit) return true;
        return hit.t >= dist - 0.15;
    }

    /* =========================================================================
   ANIMATION — v3 with per-enemy variants
   -------------------------------------------------------------------------
   Every enemy rolls THREE animation profiles at spawn:
       · walkProfile   — gait (legAmp, armReach, torsoLean, …)
       · idleProfile   — standing-around posture (sway, breath, twitch)
       · attackProfile — strike style (lunge / bite / slash / pounce)

   Profiles are pure data.  The animators read them and apply the numbers,
   so a horde reads as INDIVIDUALS — one walker drags, another stumbles,
   a third sidles.  A per-type style object further specializes the base
   archetype numbers (rotters lean more, oldbloods tremble more, etc.).

   The state machine is smoothed: idle ↔ walk blends via `A.stateBlend`,
   and attack overrides legs/arms while active.
   ========================================================================= */

    function _pickRandom(arr) {
        return arr[(Math.random() * arr.length) | 0];
    }

    /* ---- Profile pools per archetype ---------------------------------------- */

    const ARCH_PROFILES = {
        /* Shuffler — slow, damaged, drooping */
        shuffler: {
            walk: [
                { name: 'limp', legAmp: 0.62, armReach: 1.05, armHang: 0.55, lean: -0.10, loll: 0.20, roll: 0.08, limpSign: -1, bob: 0.045 },
                { name: 'drag', legAmp: 0.38, armReach: 0.85, armHang: 0.65, lean: 0.18, loll: 0.35, roll: 0.04, limpSign: -1, bob: 0.060 },
                { name: 'stumble', legAmp: 0.82, armReach: 1.20, armHang: 0.70, lean: 0.06, loll: 0.15, roll: 0.12, limpSign: 1, bob: 0.035 },
                { name: 'sidle', legAmp: 0.45, armReach: 1.00, armHang: 0.50, lean: 0.02, loll: 0.25, roll: 0.18, limpSign: 1, bob: 0.055 },
            ],
            idle: [
                { name: 'sway', swayAmp: 0.10, breathAmp: 0.05, headBob: 0.15, trembleAmp: 0.05, lurchSpeed: 0.40 },
                { name: 'twitch', swayAmp: 0.04, breathAmp: 0.08, headBob: 0.25, trembleAmp: 0.15, lurchSpeed: 0.60 },
                { name: 'hunger', swayAmp: 0.08, breathAmp: 0.12, headBob: 0.35, trembleAmp: 0.10, lurchSpeed: 0.50 },
            ],
            attack: [
                { name: 'lunge', armSwing: 0.85, leanAmt: 0.35, headThrust: 0.35, step: 0.4, dur: 0.35 },
                { name: 'double', armSwing: 1.10, leanAmt: 0.28, headThrust: 0.30, step: 0.6, dur: 0.42 },
            ],
        },

        /* Rusher — fast, aggressive, forward-driving */
        rusher: {
            walk: [
                { name: 'sprint', legAmp: 0.85, armReach: 0.85, armHang: 0.85, lean: 0.42, loll: 0.05, roll: 0.05, limpSign: 1, bob: 0.050 },
                { name: 'lunging', legAmp: 1.00, armReach: 1.10, armHang: 0.75, lean: 0.50, loll: 0.10, roll: 0.04, limpSign: 1, bob: 0.055 },
                { name: 'charge', legAmp: 0.92, armReach: 0.70, armHang: 0.90, lean: 0.55, loll: 0.02, roll: 0.03, limpSign: 1, bob: 0.040 },
            ],
            idle: [
                { name: 'pant', swayAmp: 0.06, breathAmp: 0.15, headBob: 0.20, trembleAmp: 0.12, lurchSpeed: 0.70 },
                { name: 'coil', swayAmp: 0.08, breathAmp: 0.10, headBob: 0.10, trembleAmp: 0.08, lurchSpeed: 0.55 },
            ],
            attack: [
                { name: 'swipe', armSwing: 1.20, leanAmt: 0.50, headThrust: 0.30, step: 0.7, dur: 0.32 },
                { name: 'bite', armSwing: 0.60, leanAmt: 0.65, headThrust: 0.60, step: 0.5, dur: 0.40 },
            ],
        },

        /* Circler — controlled, stalking, watchful */
        circler: {
            walk: [
                { name: 'stalk', legAmp: 0.55, armReach: 0.75, armHang: 0.55, lean: 0.10, loll: 0.10, roll: 0.06, limpSign: 1, bob: 0.030 },
                { name: 'menace', legAmp: 0.62, armReach: 0.95, armHang: 0.60, lean: 0.15, loll: 0.08, roll: 0.08, limpSign: 1, bob: 0.040 },
            ],
            idle: [
                { name: 'stare', swayAmp: 0.05, breathAmp: 0.06, headBob: 0.10, trembleAmp: 0.04, lurchSpeed: 0.35 },
                { name: 'menace', swayAmp: 0.10, breathAmp: 0.08, headBob: 0.15, trembleAmp: 0.10, lurchSpeed: 0.50 },
            ],
            attack: [
                { name: 'slash', armSwing: 1.00, leanAmt: 0.30, headThrust: 0.25, step: 0.5, dur: 0.38 },
            ],
        },

        /* Ambusher — crouching, coiling, ready to leap */
        ambusher: {
            walk: [
                { name: 'creep', legAmp: 0.70, armReach: 0.90, armHang: 0.65, lean: 0.25, loll: 0.15, roll: 0.10, limpSign: 1, bob: 0.045 },
                { name: 'prowl', legAmp: 0.65, armReach: 0.80, armHang: 0.55, lean: 0.20, loll: 0.12, roll: 0.14, limpSign: 1, bob: 0.055 },
            ],
            idle: [
                { name: 'breath', swayAmp: 0.04, breathAmp: 0.10, headBob: 0.08, trembleAmp: 0.06, lurchSpeed: 0.30 },
            ],
            attack: [
                { name: 'claw', armSwing: 1.15, leanAmt: 0.40, headThrust: 0.30, step: 0.6, dur: 0.35 },
            ],
        },

        /* Leaper — bouncy, coiled, pouncy */
        leaper: {
            walk: [
                { name: 'hop', legAmp: 0.75, armReach: 1.05, armHang: 0.60, lean: 0.10, loll: 0.05, roll: 0.05, limpSign: 1, bob: 0.080 },
                { name: 'coil', legAmp: 0.88, armReach: 1.15, armHang: 0.70, lean: 0.18, loll: 0.08, roll: 0.04, limpSign: 1, bob: 0.065 },
            ],
            idle: [
                { name: 'ready', swayAmp: 0.06, breathAmp: 0.15, headBob: 0.12, trembleAmp: 0.15, lurchSpeed: 0.65 },
            ],
            attack: [
                { name: 'pounce', armSwing: 1.30, leanAmt: 0.55, headThrust: 0.45, step: 0.9, dur: 0.30 },
            ],
        },

        /* Pack — team hunters */
        pack: {
            walk: [
                { name: 'jog', legAmp: 0.72, armReach: 0.90, armHang: 0.65, lean: 0.15, loll: 0.10, roll: 0.06, limpSign: 1, bob: 0.045 },
            ],
            idle: [
                { name: 'wait', swayAmp: 0.08, breathAmp: 0.07, headBob: 0.12, trembleAmp: 0.06, lurchSpeed: 0.40 },
            ],
            attack: [
                { name: 'grab', armSwing: 1.00, leanAmt: 0.35, headThrust: 0.30, step: 0.5, dur: 0.36 },
            ],
        },
    };

    /* Per-type style modifiers — multiplies base archetype numbers so each
       enemy kind gets a recognizable personality without a bespoke animator. */
    const TYPE_STYLE = {
        walker: { armReachMul: 1.00, armHangMul: 1.00, leanMul: 0.75, lollMul: 1.00, bobMul: 1.00, tremorMul: 1.0 },
        rotter: { armReachMul: 0.85, armHangMul: 1.10, leanMul: 1.30, lollMul: 1.25, bobMul: 1.30, tremorMul: 1.5 },
        oldblood: { armReachMul: 0.95, armHangMul: 1.00, leanMul: 1.00, lollMul: 1.00, bobMul: 0.80, tremorMul: 2.2 },
        crawler: { armReachMul: 1.00, armHangMul: 1.00, leanMul: 1.00, lollMul: 1.00, bobMul: 0.60, tremorMul: 1.0 },
        runner: { armReachMul: 0.90, armHangMul: 0.95, leanMul: 1.15, lollMul: 0.70, bobMul: 1.10, tremorMul: 0.8 },
        capboy: { armReachMul: 0.95, armHangMul: 1.00, leanMul: 1.10, lollMul: 0.90, bobMul: 1.20, tremorMul: 0.7 },
        brute: { armReachMul: 0.70, armHangMul: 1.40, leanMul: 0.85, lollMul: 0.75, bobMul: 1.60, tremorMul: 1.2 },
        demon: { armReachMul: 1.10, armHangMul: 0.90, leanMul: 1.20, lollMul: 0.85, bobMul: 1.00, tremorMul: 0.9 },
        skull: { armReachMul: 1.40, armHangMul: 0.50, leanMul: 0.40, lollMul: 0.50, bobMul: 0.50, tremorMul: 1.4 },
        hatty: { armReachMul: 1.05, armHangMul: 1.00, leanMul: 0.90, lollMul: 1.10, bobMul: 1.00, tremorMul: 0.8 },
        beanie: { armReachMul: 1.00, armHangMul: 1.10, leanMul: 1.00, lollMul: 1.20, bobMul: 1.10, tremorMul: 0.9 },
        formal: { armReachMul: 0.75, armHangMul: 0.95, leanMul: 0.60, lollMul: 0.75, bobMul: 0.60, tremorMul: 0.6 },
        vested: { armReachMul: 1.05, armHangMul: 1.05, leanMul: 1.25, lollMul: 0.95, bobMul: 1.30, tremorMul: 0.8 },
        stripey: { armReachMul: 1.25, armHangMul: 0.90, leanMul: 0.80, lollMul: 1.15, bobMul: 1.60, tremorMul: 0.7 },
        blondie: { armReachMul: 1.20, armHangMul: 0.95, leanMul: 0.85, lollMul: 1.30, bobMul: 1.30, tremorMul: 1.0 },
        hooded: { armReachMul: 0.90, armHangMul: 1.10, leanMul: 1.40, lollMul: 0.90, bobMul: 0.90, tremorMul: 1.1 },
        greyscout: { armReachMul: 1.10, armHangMul: 0.95, leanMul: 0.80, lollMul: 1.00, bobMul: 1.30, tremorMul: 1.2 },
        wisp: { armReachMul: 1.05, armHangMul: 1.00, leanMul: 0.70, lollMul: 1.00, bobMul: 1.00, tremorMul: 1.0 },
        trilens: { armReachMul: 1.00, armHangMul: 1.00, leanMul: 1.00, lollMul: 1.00, bobMul: 1.00, tremorMul: 1.0 },
        blobtron: { armReachMul: 1.00, armHangMul: 1.00, leanMul: 1.00, lollMul: 1.00, bobMul: 1.00, tremorMul: 1.0 },
        voidtwin: { armReachMul: 1.05, armHangMul: 1.00, leanMul: 0.50, lollMul: 0.90, bobMul: 1.00, tremorMul: 0.8 },
        bloom: { armReachMul: 1.00, armHangMul: 1.00, leanMul: 1.00, lollMul: 1.00, bobMul: 1.00, tremorMul: 1.0 },
        serpent: { armReachMul: 1.00, armHangMul: 1.00, leanMul: 1.00, lollMul: 1.00, bobMul: 1.00, tremorMul: 1.0 },
        imp: { armReachMul: 1.20, armHangMul: 0.90, leanMul: 1.15, lollMul: 0.85, bobMul: 1.40, tremorMul: 0.9 },
        __mini_boss__: { armReachMul: 0.80, armHangMul: 1.40, leanMul: 0.90, lollMul: 0.70, bobMul: 1.50, tremorMul: 1.0 },
        __final_boss__: { armReachMul: 0.75, armHangMul: 1.55, leanMul: 0.85, lollMul: 0.65, bobMul: 1.70, tremorMul: 1.0 },
    };

    const DEFAULT_STYLE = { armReachMul: 1, armHangMul: 1, leanMul: 1, lollMul: 1, bobMul: 1, tremorMul: 1 };

    /* ---- Shared helpers ----------------------------------------------------- */

    function _pulse(t) {
        if (t <= 0 || t >= 1) return 0;
        return Math.sin(t * Math.PI);
    }
    function _attackCurve(t) {
        if (t <= 0 || t >= 1) return 0;
        return t < 0.25 ? t * 4 : 1 - (t - 0.25) / 0.75;
    }
    function _ease(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2);
    }
    function _easeOut(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return 1 - Math.pow(1 - t, 3);
    }
    function _tremor(A, k) {
        const p = A.tremblePhase;
        return Math.sin(p * 7.3 + k) * 0.5
            + Math.sin(p * 13.7 + k * 2.1) * 0.3
            + Math.sin(p * 23.1 + k * 3.7) * 0.2;
    }

    /* ---- Anim state --------------------------------------------------------- */

    function ensureAnimState(e) {
        if (e._anim) return e._anim;

        const seed = Math.random() * 100;
        const arche = (e.behavior && e.behavior.archetype) || 'shuffler';
        const pool = ARCH_PROFILES[arche] || ARCH_PROFILES.shuffler;

        /* Roll variants — this is what makes every individual unique. */
        const walkProfile = _pickRandom(pool.walk);
        const idleProfile = _pickRandom(pool.idle);
        const attackProfile = _pickRandom(pool.attack);

        const style = TYPE_STYLE[e.kind] || DEFAULT_STYLE;

        e._anim = {
            walkProfile, idleProfile, attackProfile, style,

            walkPhase: e.walkPhase || Math.random() * Math.PI * 2,
            idlePhase: Math.random() * Math.PI * 2,
            breathPhase: Math.random() * Math.PI * 2,
            bouncePhase: Math.random() * Math.PI * 2,
            swayPhase: Math.random() * Math.PI * 2,
            antennaeT: Math.random() * 6.28,
            headTurn: 0, headPitch: 0,
            lookTimer: 0, lookDir: 0,
            blinkPhase: Math.random() * 6.28, blinkT: 0,
            flinch: 0, flinchRoll: 0,
            limpSide: ((seed | 0) & 1) ? 1 : -1,
            limpPhase: 0, dragAccum: 0,
            sprintPhase: Math.random() * 6.28,
            sprintLean: 0,
            tremblePhase: Math.random() * 6.28,
            trembleAmp: 0,
            ticTimer: 1.0 + Math.random() * 2.0,
            ticDir: 0,
            coilPhase: Math.random() * 6.28,
            stompT: Math.random() * 0.5,
            hopCharge: 0, hopAirborne: 0, hopCrouch: 0,
            tentaclePhase: new Array(8).fill(0).map(() => Math.random() * 6.28),
            hoodFlare: 0, coilWave: Math.random() * 6.28,
            floatPhase: Math.random() * 6.28,
            hairPhase: Math.random() * 6.28,
            eyeStalkBounce: Math.random() * 6.28,
            breatheRate: 0.9 + Math.random() * 0.4,
            lungeWind: 0,
            stateBlend: 0,           // 0 = idle, 1 = walk
            attackBlend: 0,          // 0 = none, 1 = full attack
            _seed: seed,
        };
        return e._anim;
    }

    /* ---- Shared per-frame state -------------------------------------------- */

    function applySharedAnimationLogic(e, dt, A, moving, attackReach) {
        A.idlePhase += dt * 1.4;
        A.breathPhase += dt * A.breatheRate;
        A.antennaeT += dt * 2.2;
        A.blinkPhase += dt * 3.2;
        A.tremblePhase += dt;

        /* Smooth idle ↔ walk blending. */
        const walkTarget = moving ? 1 : 0;
        A.stateBlend += (walkTarget - A.stateBlend) * Math.min(1, dt * 5);

        /* Look-at-player head tracking */
        A.lookTimer -= dt;
        if (A.lookTimer <= 0) {
            A.lookTimer = 1.6 + Math.random() * 3.0;
            A.lookDir = Math.random() * 2 - 1;
            const dx = player.pos.x - e.pos.x;
            const dz = player.pos.z - e.pos.z;
            if (dx * dx + dz * dz < 25) {
                const worldYaw = Math.atan2(dx, dz);
                let rel = worldYaw - e.yaw;
                while (rel > Math.PI) rel -= Math.PI * 2;
                while (rel < -Math.PI) rel += Math.PI * 2;
                A.lookDir = clamp(rel / 1.2, -1, 1);
            }
        }
        const turnK = Math.min(1, dt * 3.5);
        A.headTurn += (A.lookDir - A.headTurn) * turnK;
        A.headPitch += (Math.sin(A.idlePhase * 0.4) * 0.35 - A.headPitch)
            * Math.min(1, dt * 2.5);

        if (A.blinkT > 0) A.blinkT = Math.max(0, A.blinkT - dt * 9);
        else if (A.blinkPhase > 5.7) { A.blinkT = 1; A.blinkPhase = 0; }

        if (e.hitFlash > 0) {
            A.flinch = Math.max(A.flinch, e.hitFlash * 0.9);
            A.flinchRoll = (Math.random() - 0.5) * 0.4;
        }
        A.flinch = Math.max(0, A.flinch - dt * 2.4);
        A.flinchRoll *= Math.max(0, 1 - dt * 5);

        if (e.attackPhase > 0) {
            e.attackPhase += dt / 0.35;
            if (e.attackPhase >= 1) e.attackPhase = 0;
            else attackReach = _attackCurve(e.attackPhase);
        }
        if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt * 4);

        /* Attack blend for smooth override. */
        const attackTarget = attackReach > 0.05 ? 1 : 0;
        A.attackBlend += (attackTarget - A.attackBlend) * Math.min(1, dt * 10);

        const crawlTarget = e.crawlMode ? 1 : 0;
        e.crawlBlend += (crawlTarget - e.crawlBlend) * Math.min(1, dt * 6);

        return attackReach;
    }

    /* ---- Dispatcher --------------------------------------------------------- */

    function animateEnemy(e, dt) {
        const A = ensureAnimState(e);
        let attackReach = 0;
        const spd = Math.hypot(e.vel.x, e.vel.z);
        const moving = spd > 0.4 && e.onGround;
        attackReach = applySharedAnimationLogic(e, dt, A, moving, attackReach);

        const bt = e.model.bodyType || "humanoid";
        const k = e.kind || "";

        if (bt === "octo") return animateOcto(e, dt, A, moving, attackReach);
        if (bt === "serpent") return animateSerpent(e, dt, A, moving, attackReach);
        if (bt === "insect") return animateImpInsect(e, dt, A, moving, attackReach);
        if (bt === "hopper") return animateBloomHopper(e, dt, A, moving, attackReach);

        switch (k) {
            case "__mini_boss__": return animateMiniBoss(e, dt, A, moving, attackReach);
            case "brute": return animateBrute(e, dt, A, moving, attackReach);
            case "runner":
            case "capboy": return animateRunner(e, dt, A, moving, attackReach);
            case "demon": return animateDemon(e, dt, A, moving, attackReach);
            case "oldblood": return animateOldblood(e, dt, A, moving, attackReach);
            case "skull": return animateSkull(e, dt, A, moving, attackReach);
            case "rotter": return animateRotter(e, dt, A, moving, attackReach);
            case "beanie": return animateBeanie(e, dt, A, moving, attackReach);
            case "hooded": return animateHooded(e, dt, A, moving, attackReach);
            case "crawler": return animateCrawler(e, dt, A, moving, attackReach);
            case "greyscout": return animateGreyscout(e, dt, A, moving, attackReach);
            case "voidtwin": return animateVoidtwin(e, dt, A, moving, attackReach);
            case "wisp": return animateWisp(e, dt, A, moving, attackReach);
            case "trilens": return animateTrilens(e, dt, A, moving, attackReach);
            case "hatty": return animateHatty(e, dt, A, moving, attackReach);
            case "blondie": return animateBlondie(e, dt, A, moving, attackReach);
            case "formal": return animateFormal(e, dt, A, moving, attackReach);
            case "vested": return animateVested(e, dt, A, moving, attackReach);
            case "stripey": return animateStripey(e, dt, A, moving, attackReach);
            case "walker":
            default: return animateWalkerZombie(e, dt, A, moving, attackReach);
        }
    }

    /* =========================================================================
       ZOMBIE ANIMATORS (profile-driven)
       ========================================================================= */

    /* Shared humanoid walk+idle primitive.  Every zombie animator below is a
       thin layer over this that adds a small per-type personality flourish. */
    function applyHumanoidGait(e, dt, A, moving, attackReach, opts) {
        opts = opts || {};
        const parts = e.parts;
        const W = A.walkProfile;
        const I = A.idleProfile;
        const P = A.attackProfile;
        const S = A.style;
        const spd = Math.hypot(e.vel.x, e.vel.z);

        const walkK = A.stateBlend;
        const idleK = 1 - walkK;

        /* Advance gait phase faster when moving, slow when idling. */
        if (moving) A.walkPhase += dt * (1.5 + spd * 0.6);
        else A.walkPhase += dt * 0.55;

        const swing = Math.sin(A.walkPhase);
        const swing2 = Math.sin(A.walkPhase * 2);
        const breath = Math.sin(A.breathPhase);
        const idleSway = Math.sin(A.idlePhase * 0.7) * idleK;

        const legAmp = W.legAmp * walkK;
        const limp = A.limpSide * W.limpSign;

        /* --- Legs --- */
        const dragL = limp < 0 ? Math.max(0, -swing) : 0;
        const dragR = limp > 0 ? Math.max(0, swing) : 0;
        if (parts.legL && parts.legL.connected) {
            parts.legL.pivot.rotation.x = (swing - dragL) * legAmp
                + idleSway * 0.02 * I.swayAmp * 10;
            parts.legL.pivot.rotation.z = -Math.abs(swing) * 0.05 * walkK;
        }
        if (parts.legR && parts.legR.connected) {
            parts.legR.pivot.rotation.x = (-swing + dragR) * legAmp
                - idleSway * 0.02 * I.swayAmp * 10;
            parts.legR.pivot.rotation.z = Math.abs(swing) * 0.05 * walkK;
        }

        /* --- Arms --- */
        const reachKey = limp < 0 ? "armR" : "armL";
        const hangKey = limp < 0 ? "armL" : "armR";

        const reachBase = (W.armReach * walkK + 0.20 * idleK) * S.armReachMul;
        const hangBase = (W.armHang * walkK + 0.25 * idleK) * S.armHangMul;

        const swayAmp = (0.14 * walkK + 0.05 * idleK);
        const swayReach = Math.sin(A.walkPhase + (limp < 0 ? 0 : Math.PI)) * swayAmp;
        const swayHang = Math.sin(A.walkPhase * 0.7 + 1.5) * swayAmp * 0.6;
        const atk = attackReach * P.armSwing;

        if (parts[reachKey] && parts[reachKey].connected) {
            parts[reachKey].pivot.rotation.x = reachBase + swayReach + atk;
            parts[reachKey].pivot.rotation.z =
                (reachKey === "armL" ? -0.06 : 0.06) + Math.sin(A.walkPhase * 0.5 + 1.3) * 0.04;
            parts[reachKey].pivot.rotation.y = idleSway * 0.10;
        }
        if (parts[hangKey] && parts[hangKey].connected) {
            parts[hangKey].pivot.rotation.x = hangBase + swayHang + atk * 0.35;
            parts[hangKey].pivot.rotation.z =
                (hangKey === "armL" ? -0.22 : 0.22) + Math.sin(A.walkPhase * 0.3) * 0.04;
            parts[hangKey].pivot.rotation.y = -idleSway * 0.08;
        }

        /* --- Torso --- */
        if (parts.torso.connected) {
            const walkLean = W.lean * walkK * S.leanMul;
            const idleLean = breath * I.breathAmp * 0.4 * idleK;
            const crawlLean = 1.15 * e.crawlBlend;
            const atkLean = attackReach * P.leanAmt;
            parts.torso.pivot.rotation.x = walkLean + idleLean + crawlLean + atkLean;
            parts.torso.pivot.rotation.z =
                limp * W.roll * walkK * S.leanMul
                + idleSway * I.swayAmp * 2
                + A.flinchRoll;
            parts.torso.pivot.rotation.y = swing2 * 0.03 * walkK;
            const bob = Math.abs(swing) * W.bob * (1 - e.crawlBlend);
            parts.torso.pivot.position.y = parts.torso.basePivot[1] - bob;
        }

        /* --- Head --- */
        if (parts.head && parts.head.connected) {
            const lagSwing = Math.sin(A.walkPhase - 0.8);
            const idleBob = Math.sin(A.idlePhase * 0.9) * I.headBob * idleK;
            parts.head.pivot.rotation.x =
                W.loll * walkK * S.lollMul
                + lagSwing * 0.05 * walkK
                + idleBob
                + attackReach * P.headThrust
                - A.headPitch * 0.06
                - A.flinch * 0.35;
            parts.head.pivot.rotation.y =
                A.headTurn * 0.3 + Math.sin(A.walkPhase * 0.4) * 0.08 * walkK;
            parts.head.pivot.rotation.z =
                limp * (0.10 * walkK + 0.04 * idleK) + idleSway * I.swayAmp * 0.5;
        }
    }

    /* ---- Walker ---- */
    function animateWalkerZombie(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
    }

    /* ---- Rotter (mooshy wander) ---- */
    function animateRotter(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        A.limpPhase += dt * 0.45;
        const wander = Math.sin(A.limpPhase);
        /* Extra joint wobble on the torso and head. */
        if (parts.torso.connected) {
            parts.torso.pivot.rotation.z += wander * 0.03;
            parts.torso.pivot.rotation.y += Math.sin(A.walkPhase * 0.5) * 0.03;
        }
        if (parts.head && parts.head.connected) {
            parts.head.pivot.rotation.z += wander * 0.05;
        }
    }

    /* ---- Oldblood (heavy tremor) ---- */
    function animateOldblood(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const tgt = moving ? 0.55 : 0.25;
        A.trembleAmp += (tgt - A.trembleAmp) * Math.min(1, dt * 3);
        A.ticTimer -= dt;
        if (A.ticTimer <= 0) {
            A.ticTimer = 1.5 + Math.random() * 2.5;
            A.ticDir = Math.random() < 0.5 ? -1 : 1;
        }
        const tAmp = A.trembleAmp * A.style.tremorMul;
        if (parts.armL.connected) {
            parts.armL.pivot.rotation.x += _tremor(A, 2.1) * tAmp * 0.12;
            parts.armL.pivot.rotation.z += _tremor(A, 5.0) * tAmp * 0.05;
        }
        if (parts.armR.connected) {
            parts.armR.pivot.rotation.x += _tremor(A, 2.9) * tAmp * 0.12;
            parts.armR.pivot.rotation.z -= _tremor(A, 6.1) * tAmp * 0.05;
        }
        if (parts.head.connected) {
            parts.head.pivot.rotation.x += _tremor(A, 7.2) * tAmp * 0.08;
            parts.head.pivot.rotation.y += _tremor(A, 8.1) * tAmp * 0.06;
            parts.head.pivot.rotation.z += _tremor(A, 9.3) * tAmp * 0.05;
        }
        if (parts.torso.connected) {
            parts.torso.pivot.rotation.z += A.ticDir * 0.04 * tAmp;
        }
    }

    /* ---- Runner ---- */
    function animateRunner(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const tgt = moving ? 0.42 : 0.18;
        A.sprintLean += (tgt - A.sprintLean) * Math.min(1, dt * 4);
        if (parts.torso.connected) {
            parts.torso.pivot.rotation.x += A.sprintLean * 0.4;
        }
        if (parts.head.connected) {
            parts.head.pivot.rotation.x -= A.sprintLean * 0.55;
        }
    }

    /* ---- Brute ---- */
    function animateBrute(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const spd = Math.hypot(e.vel.x, e.vel.z);
        if (moving) A.stompT += dt * (0.75 + spd * 0.12);
        else A.stompT += dt * 0.32;
        const beat = A.stompT % 1.0;

        let liftL = 0, liftR = 0, slam = 0;
        if (beat < 0.40) liftL = _ease(beat / 0.40);
        else if (beat < 0.50) {
            const t = (beat - 0.40) / 0.10;
            liftL = 1 - t;
            slam = Math.max(slam, _pulse(t));
        }
        if (beat > 0.50 && beat < 0.90) liftR = _ease((beat - 0.50) / 0.40);
        else if (beat >= 0.90) {
            const t = (beat - 0.90) / 0.10;
            liftR = 1 - t;
            slam = Math.max(slam, _pulse(t));
        }

        /* Attack: windup → overhead lift → slam forward */
        const atk = attackReach;
        let wind = 0, crash = 0;
        if (atk > 0 && atk < 0.30) wind = _easeOut(atk / 0.30);
        else if (atk >= 0.30) crash = (atk - 0.30) / 0.70;

        if (parts.legL.connected) parts.legL.pivot.rotation.x = liftL * 0.70 + slam * 0.12;
        if (parts.legR.connected) parts.legR.pivot.rotation.x = liftR * 0.70 + slam * 0.12;

        const armIdle = 0.35, armWind = 2.60, armCrash = 0.30;
        const armX = armIdle + wind * (armWind - armIdle) + crash * (armCrash - armWind);
        if (parts.armL.connected) {
            parts.armL.pivot.rotation.x = armX + Math.sin(A.walkPhase * 0.6) * 0.25 * (moving ? 1 : 0.3);
        }
        if (parts.armR.connected) {
            parts.armR.pivot.rotation.x = armX - Math.sin(A.walkPhase * 0.6) * 0.25 * (moving ? 1 : 0.3);
        }
        if (parts.torso.connected) {
            const heave = slam * 0.2 + Math.sin(A.breathPhase * 0.7) * 0.03;
            parts.torso.pivot.rotation.x += heave - wind * 0.30 + crash * 0.65;
            parts.torso.pivot.position.y += heave * 0.06 - wind * 0.05;
        }
        if (parts.head.connected) {
            parts.head.pivot.rotation.x += slam * 0.15 - wind * 0.25 + crash * 0.55;
        }
    }

    /* ---- Skull (mummy pose) ---- */
    function animateSkull(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const mummy = 1.50;
        const jitter = _tremor(A, 0.0) * 0.04 * A.style.tremorMul;
        if (parts.armL.connected) {
            parts.armL.pivot.rotation.x = mummy + attackReach * 0.30 + jitter;
            parts.armL.pivot.rotation.z = -0.08 + jitter;
        }
        if (parts.armR.connected) {
            parts.armR.pivot.rotation.x = mummy + attackReach * 0.30 + jitter;
            parts.armR.pivot.rotation.z = 0.08 - jitter;
        }
        if (parts.head.connected) {
            const snap = Math.round(A.headTurn * 5) / 5;
            parts.head.pivot.rotation.y = snap * 0.55 + jitter;
        }
    }

    /* ---- Crawler (belly-drag) ---- */
    function animateCrawler(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        if (parts.torso.connected) {
            parts.torso.pivot.rotation.x = 1.25 + Math.sin(A.walkPhase * 2) * 0.08;
            parts.torso.pivot.position.y = parts.torso.basePivot[1] - 0.28;
        }
        if (parts.head.connected) {
            parts.head.pivot.rotation.x = -0.35 - Math.sin(A.walkPhase * 2) * 0.15 - attackReach * 0.55;
        }
    }

    /* ---- Hooded ---- */
    function animateHooded(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        if (parts.torso.connected) {
            parts.torso.pivot.position.y -= 0.05;
        }
        if (parts.head.connected) {
            parts.head.pivot.rotation.x += 0.15 * (moving ? 1 : 0.3);
        }
    }

    /* ---- Hatty (swagger) ---- */
    function animateHatty(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const swagger = Math.sin(A.walkPhase * 0.5) * 0.12 * A.stateBlend;
        if (parts.torso.connected) parts.torso.pivot.rotation.y += swagger * 1.4;
        if (parts.head.connected) parts.head.pivot.rotation.z += 0.22 + swagger * 0.4;
    }

    /* ---- Blondie (frantic hair-whip) ---- */
    function animateBlondie(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        A.hairPhase += dt * (moving ? 4.2 : 2.4);
        const hair = Math.sin(A.hairPhase);
        const hair2 = Math.sin(A.hairPhase * 1.7);
        if (parts.head.connected) {
            parts.head.pivot.rotation.x += hair * 0.18;
            parts.head.pivot.rotation.y += hair2 * 0.22;
            parts.head.pivot.rotation.z += hair * 0.16;
        }
        if (parts.torso.connected) parts.torso.pivot.rotation.z += hair2 * 0.04;
    }

    /* ---- Formal (stiff) ---- */
    function animateFormal(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        if (parts.head.connected) parts.head.pivot.rotation.x -= 0.08;
    }

    /* ---- Vested ---- */
    function animateVested(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        if (parts.torso.connected) parts.torso.pivot.rotation.x += 0.18 * A.stateBlend;
    }

    /* ---- Stripey (goofy bounce) ---- */
    function animateStripey(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        A.bouncePhase += dt * (moving ? 3.0 : 1.5);
        const bounce = Math.abs(Math.sin(A.bouncePhase));
        if (parts.torso.connected) {
            parts.torso.pivot.position.y -= bounce * 0.06 * A.stateBlend;
        }
        if (parts.head.connected) {
            parts.head.pivot.rotation.x -= bounce * 0.12 * A.stateBlend;
        }
    }

    /* ---- Beanie ---- */
    function animateBeanie(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const cock = A.limpSide;
        if (parts.torso.connected) parts.torso.pivot.rotation.z += cock * 0.12;
        if (parts.head.connected) {
            parts.head.pivot.rotation.z += cock * 0.18;
            parts.head.pivot.rotation.y += cock * 0.08;
        }
    }

    /* ---- Demon (coiled predator) ---- */
    function animateDemon(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        A.coilPhase += dt * (moving ? 2.4 : 1.2);
        const coil = Math.sin(A.coilPhase);
        const lungeWindTgt = attackReach > 0.05 && attackReach < 0.4 ? 1 : 0;
        A.lungeWind += (lungeWindTgt - A.lungeWind) * Math.min(1, dt * 8);
        const lungeDrive = attackReach > 0.4 ? (attackReach - 0.4) / 0.6 : 0;
        const bend = 0.30 + A.lungeWind * 0.30;

        if (parts.legL.connected) {
            parts.legL.pivot.rotation.x = bend + coil * 0.25 * A.stateBlend;
        }
        if (parts.legR.connected) {
            parts.legR.pivot.rotation.x = bend - coil * 0.25 * A.stateBlend;
        }
        if (parts.armL.connected) {
            parts.armL.pivot.rotation.x += A.lungeWind * 0.35 + lungeDrive * 0.90;
        }
        if (parts.armR.connected) {
            parts.armR.pivot.rotation.x += A.lungeWind * 0.35 + lungeDrive * 0.90;
        }
        if (parts.torso.connected) {
            parts.torso.pivot.rotation.x += -A.lungeWind * 0.10 + lungeDrive * 0.60;
            parts.torso.pivot.position.y -= 0.08;
        }
        if (parts.head.connected) {
            const jaw = Math.sin(A.idlePhase * 10) * A.lungeWind * 0.10;
            parts.head.pivot.rotation.x += lungeDrive * 0.55;
            parts.head.pivot.rotation.y += jaw;
        }
    }

    /* =========================================================================
       ALIEN ANIMATORS
       ========================================================================= */

    function animateOcto(e, dt, A, moving, attackReach) {
        const parts = e.parts;
        const spd = Math.hypot(e.vel.x, e.vel.z);
        A.swayPhase += dt * (moving ? 2.6 + spd * 0.5 : 1.4);

        const phases = [0.00, 0.55, 1.10, 1.65];
        const bundles = [parts.legL, parts.legR, parts.armL, parts.armR];
        for (let i = 0; i < bundles.length; i++) {
            const p = bundles[i];
            if (!p || !p.connected) continue;
            const t = (A.swayPhase + phases[i] * Math.PI) % (Math.PI * 2);
            const reach = _pulse(t / (Math.PI * 2));
            const sideSign = (i === 0 || i === 2) ? -1 : 1;
            p.pivot.rotation.x = -reach * 0.35 * (moving ? 1 : 0.35)
                + Math.sin(t) * 0.08 + attackReach * 0.40;
            p.pivot.rotation.z = sideSign * (0.10 + reach * 0.18)
                + Math.cos(t * 0.7) * 0.06;
            p.pivot.rotation.y = Math.sin(t * 0.8 + i) * 0.15;
        }
        if (parts.torso.connected) {
            const ripple = Math.sin(A.swayPhase - 0.9) * 0.06;
            const pulse = 1 + ripple + Math.sin(A.breathPhase * 1.7) * 0.03;
            parts.torso.pivot.scale.set(pulse, 1 / pulse, pulse);
            parts.torso.pivot.rotation.x = 0.12 * attackReach + ripple * 0.4;
            parts.torso.pivot.rotation.y = Math.sin(A.swayPhase * 0.5) * 0.05;
            parts.torso.pivot.position.y = (parts.torso.basePivot[1] || 0) + ripple * 0.04;
        }
        if (parts.head && parts.head.connected) {
            parts.head.pivot.rotation.x = Math.sin(A.idlePhase * 0.4) * 0.08
                + 0.30 * attackReach + A.headPitch * 0.05;
            parts.head.pivot.rotation.y = Math.sin(A.idlePhase * 0.55) * 0.18
                + A.headTurn * 0.40;
            parts.head.pivot.rotation.z = Math.sin(A.idlePhase * 0.31 + 1.2) * 0.05;
        }
    }

    function animateSerpent(e, dt, A, moving, attackReach) {
        const parts = e.parts;
        const spd = Math.hypot(e.vel.x, e.vel.z);
        A.coilWave += dt * (moving ? 2.0 + spd * 0.4 : 1.2);
        const sway = Math.sin(A.coilWave);
        const sway2 = Math.sin(A.coilWave * 0.5);

        const dx = player.pos.x - e.pos.x;
        const dz = player.pos.z - e.pos.z;
        const close = Math.hypot(dx, dz) < 8;
        const hoodTgt = (close || attackReach > 0.1) ? 1 : 0;
        A.hoodFlare += (hoodTgt - A.hoodFlare) * Math.min(1, dt * 3.5);

        if (parts.torso.connected) {
            parts.torso.pivot.rotation.y = sway * (moving ? 0.28 : 0.12);
            parts.torso.pivot.rotation.x = 0.35 * attackReach + sway2 * 0.05;
            parts.torso.pivot.rotation.z = sway2 * 0.10;
            parts.torso.pivot.position.y = (parts.torso.basePivot[1] || 0)
                + Math.abs(sway) * 0.03;
        }
        if (parts.head && parts.head.connected) {
            const weave = Math.sin(A.coilWave * 1.15 + 0.6) * 0.22;
            parts.head.pivot.rotation.x = Math.sin(A.coilWave * 0.7) * 0.06
                + attackReach * 0.65 + A.headPitch * 0.05 - A.flinch * 0.35;
            parts.head.pivot.rotation.y = -sway * 0.20 + weave + A.headTurn * 0.35;
            parts.head.pivot.rotation.z = sway2 * 0.10;
            const hs = 1 + A.hoodFlare * 0.22;
            parts.head.pivot.scale.set(1 + A.hoodFlare * 0.06, hs, hs);
        }
    }

    function animateGreyscout(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        const flit = Math.sin(A.idlePhase * 5 + A._seed) * 0.06;
        if (parts.armL.connected) parts.armL.pivot.rotation.x += flit;
        if (parts.armR.connected) parts.armR.pivot.rotation.x -= flit;
        if (parts.head.connected) {
            parts.head.pivot.rotation.y += Math.sin(A.antennaeT * 3 + 0.4) * 0.10;
        }
    }

    function animateVoidtwin(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        A.floatPhase += dt * (moving ? 1.8 : 1.0);
        const bob = Math.sin(A.floatPhase);
        const bob2 = Math.sin(A.floatPhase * 0.5);
        if (parts.torso.connected) {
            parts.torso.pivot.position.y += bob * 0.03;
            parts.torso.pivot.rotation.x += bob * 0.04;
        }
        if (parts.head && parts.head.connected) {
            parts.head.pivot.rotation.y += bob2 * 0.25;
        }
    }

    function animateWisp(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        A.eyeStalkBounce += dt * 1.6;
        const eyeSway = Math.sin(A.eyeStalkBounce) * 0.10;
        if (parts.head && parts.head.connected) {
            parts.head.pivot.rotation.x += eyeSway * 0.6;
            parts.head.pivot.rotation.y += eyeSway;
        }
    }

    function animateTrilens(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        if (parts.armL.connected) parts.armL.pivot.rotation.y += Math.sin(A.walkPhase * 0.8) * 0.12;
        if (parts.armR.connected) parts.armR.pivot.rotation.y += Math.sin(A.walkPhase * 0.8 + 1.7) * 0.12;
    }

    function animateImpInsect(e, dt, A, moving, attackReach) {
        applyHumanoidGait(e, dt, A, moving, attackReach, {});
        const parts = e.parts;
        if (parts.head && parts.head.connected) {
            const chatter = Math.sin(A.idlePhase * 15) * 0.06;
            parts.head.pivot.rotation.y += chatter;
        }
    }

    function animateBloomHopper(e, dt, A, moving, attackReach) {
        const parts = e.parts;
        const spd = Math.hypot(e.vel.x, e.vel.z);
        A.bouncePhase += dt * (moving ? 3.6 + spd * 0.6 : 1.6);
        const b = A.bouncePhase % (Math.PI * 2);
        const hop = Math.sin(b);
        const airborne = Math.max(0, hop);
        const land = Math.max(0, -hop);
        const crouch = hop > -0.2 && hop < 0.2 && Math.cos(b) < 0
            ? Math.abs(Math.cos(b)) : 0;

        if (parts.torso.connected) {
            const sy = 1 + airborne * 0.25 - land * 0.20 - crouch * 0.18;
            const sxz = 1 / Math.sqrt(Math.max(0.5, sy));
            parts.torso.pivot.scale.set(sxz, sy, sxz);
            parts.torso.pivot.position.y = (parts.torso.basePivot[1] || 0) + airborne * 0.16;
            parts.torso.pivot.rotation.x = 0.30 * attackReach + crouch * 0.08;
            parts.torso.pivot.rotation.z = Math.sin(A.idlePhase * 0.7 + A._seed) * 0.03;
        }

        const legFold = -crouch * 1.1 + land * 0.15;
        if (parts.legL.connected) {
            parts.legL.pivot.rotation.x = legFold + airborne * 0.20
                + Math.sin(A.bouncePhase * 0.5) * 0.05;
        }
        if (parts.legR.connected) {
            parts.legR.pivot.rotation.x = legFold + airborne * 0.20
                + Math.sin(A.bouncePhase * 0.5 + 1.5) * 0.05;
        }

        const armBounce = -hop * 0.20;
        if (parts.armL.connected) {
            parts.armL.pivot.rotation.x = 0.55 + armBounce + attackReach * 0.45;
        }
        if (parts.armR.connected) {
            parts.armR.pivot.rotation.x = 0.55 + armBounce + attackReach * 0.45;
        }
        if (parts.head && parts.head.connected) {
            const bob = Math.sin(A.bouncePhase + 0.6) * 0.10;
            parts.head.pivot.rotation.x = bob + attackReach * 0.30
                + A.headPitch * 0.05 - A.flinch * 0.35;
            parts.head.pivot.rotation.y = A.headTurn * 0.40;
        }
    }

    function animateMiniBoss(e, dt, A, moving, attackReach) {
        const parts = e.parts;
        const spd = Math.hypot(e.vel.x, e.vel.z);

        if (moving) A.walkPhase += dt * (1.2 + spd * 0.3);
        else A.walkPhase += dt * 0.15;

        const swing = Math.sin(A.walkPhase);

        // ─── BASE POSE — one constant per part × axis (all editable) ──
        const torsoBaseX = -7;
        const torsoBaseY = 0;
        const torsoBaseZ = 0;
        const torsoDrop = 0.19;

        const headBaseX = 0.56;
        const headBaseY = 0;
        const headBaseZ = 0;

        const armLBaseX = 1;
        const armLBaseY = 0;
        const armLBaseZ = -0.13;

        const armRBaseX = 1;
        const armRBaseY = 0;
        const armRBaseZ = 0.11;

        const legLBaseX = 0;
        const legLBaseY = 0;
        const legLBaseZ = -0.16;

        const legRBaseX = 0;
        const legRBaseY = 0;
        const legRBaseZ = 0.15;

        // ─── SWING AMPLITUDES ─────────────────────────────────────────
        const legSwingX = 0.55;
        const armSwingX = 0.28;
        const headSwingY = 0.25;
        const torsoSwingZ = 0.06;

        const legSwing = moving ? swing * legSwingX : 0;
        const armSwing = moving ? swing * armSwingX : 0;

        // ─── throw timeline (BOTH arms driven symmetrically) ─────────
        let throwOverride = false;
        let armLX = armLBaseX + armSwing;
        let armRX = armRBaseX + armSwing;
        let armLZ = armLBaseZ;
        let armRZ = armRBaseZ;
        let torsoDeltaX = 0;

        if (e.isThrowing) {
            throwOverride = true;
            e.throwTimer += dt;
            const T = e.throwTimer;

            const ARM_REACH = -0.40;
            const ARM_ABOVE = 2.80;
            const ARM_WINDUP = 3.30;
            const ARM_RELEASE = 1.50;
            const ARM_FOLLOW = 0.30;

            let armX;

            if (T < 1.0) {
                // Phase 1 — both arms reach down toward the cluster
                const t = T / 1.0;
                const et = _ease(t);
                armX = armLBaseX + (ARM_REACH - armLBaseX) * et;
                armLZ = armLBaseZ - et * 0.18;
                armRZ = armRBaseZ + et * 0.18;
                torsoDeltaX = t * 0.25;
            } else if (T < 2.5) {
                // Phase 2 — both arms lift the block up
                const t = (T - 1.0) / 1.5;
                const et = _ease(t);
                armX = ARM_REACH + (ARM_ABOVE - ARM_REACH) * et;
                armLZ = armLBaseZ - 0.18 + et * 0.13;
                armRZ = armRBaseZ + 0.18 - et * 0.13;
                torsoDeltaX = 0.25 - t * 0.35;
            } else if (T < 3.5) {
                // Phase 3 — hold above head, spread hands for the windup
                const t = (T - 2.5) / 1.0;
                const et = _ease(t);
                armX = ARM_ABOVE + (ARM_WINDUP - ARM_ABOVE) * et;
                armLZ = armLBaseZ - 0.05 - et * 0.22;
                armRZ = armRBaseZ + 0.05 + et * 0.22;
                torsoDeltaX = -0.10 - t * 0.15;
            } else if (T < 4.0) {
                // Phase 4 — throw (both arms swing down together)
                const t = (T - 3.5) / 0.5;
                const et = _easeOut(t);
                armX = ARM_WINDUP + (ARM_RELEASE - ARM_WINDUP) * et;
                armLZ = armLBaseZ - 0.27;
                armRZ = armRBaseZ + 0.27;
                torsoDeltaX = -0.25 + et * 0.5;
            } else if (T < 4.5) {
                // Phase 5 — follow-through
                const t = (T - 4.0) / 0.5;
                const et = _ease(t);
                armX = ARM_RELEASE + (ARM_FOLLOW - ARM_RELEASE) * et;
                armLZ = armLBaseZ - 0.27 + et * 0.17;
                armRZ = armRBaseZ + 0.27 - et * 0.17;
                torsoDeltaX = 0.25 + t * 0.05;
            } else {
                // Phase 6 — recover to base pose
                const t = Math.min(1, (T - 4.5) / 0.5);
                const et = _ease(t);
                armX = ARM_FOLLOW + (armRBaseX - ARM_FOLLOW) * et;
                armLZ = armLBaseZ - 0.10 + et * 0.10;
                armRZ = armRBaseZ + 0.10 - et * 0.10;
                torsoDeltaX = 0.30 - t * 0.30;
                if (T >= 5.0) e.isThrowing = false;
            }

            armLX = armX;
            armRX = armX;

            // Break the voxel cluster the moment the hands reach the ground
            if (T >= 1.0 && !e._blockBroken) {
                e._blockBroken = true;
                if (!e._remoteOwned) spawnHeldBlockForThrow(e);
            }

            // Release the block as a projectile
            if (T >= 4.0 && !e._blockThrown) {
                e._blockThrown = true;
                if (!e._remoteOwned) launchHeldBlock(e);
            }

            // Keep the chunk glued between the two hands
            if (e.heldBlock && !e._blockThrown) {
                updateHeldBlockPosition(e, dt);
            }
        }

        if (e.isSlamming && !e.isThrowing) {
            throwOverride = true;
            e.slamTimer += dt;
            const T = e.slamTimer;

            const ARM_UP = 3.60;   // both arms raised overhead
            const ARM_DOWN = 0.50;   // both arms slam forward-down

            let armX = armLBaseX;
            let torsoD = 0;

            if (T < 0.7) {
                // Phase 1 — windup: both arms swing up high, body leans back
                const t = T / 0.7;
                const et = _ease(t);
                armX = armLBaseX + (ARM_UP - armLBaseX) * et;
                torsoD = -0.40 * et;
            } else if (T < 1.0) {
                // Phase 2 — slam down hard
                const t = (T - 0.7) / 0.3;
                const et = _easeOut(t);
                armX = ARM_UP + (ARM_DOWN - ARM_UP) * et;
                torsoD = -0.40 + et * 1.15;
            } else if (T < 1.4) {
                // Phase 3 — impact hold (spawn the wave exactly once)
                armX = ARM_DOWN;
                torsoD = 0.75;
                if (T >= 1.0 && !e._waveSpawned) {
                    e._waveSpawned = true;
                    if (!e._remoteOwned) spawnStoneWave(e);
                }
            } else {
                // Phase 4 — recover to neutral
                const t = Math.min(1, (T - 1.4) / 0.4);
                const et = _ease(t);
                armX = ARM_DOWN + (armLBaseX - ARM_DOWN) * et;
                torsoD = 0.75 - et * 0.75;
                if (T >= 1.8) e.isSlamming = false;
            }

            armLX = armX;
            armRX = armX;
            armLZ = armLBaseZ;
            armRZ = armRBaseZ;
            torsoDeltaX = torsoD;
        }

        // ─── legs ────────────────────────────────────────────────────
        if (parts.legL.connected) {
            parts.legL.pivot.rotation.x = legLBaseX + legSwing;
            parts.legL.pivot.rotation.y = legLBaseY;
            parts.legL.pivot.rotation.z = legLBaseZ;
        }
        if (parts.legR.connected) {
            parts.legR.pivot.rotation.x = legRBaseX - legSwing;
            parts.legR.pivot.rotation.y = legRBaseY;
            parts.legR.pivot.rotation.z = legRBaseZ;
        }

        // ─── arms ────────────────────────────────────────────────────
        if (parts.armL.connected) {
            parts.armL.pivot.rotation.x = throwOverride ? armLX : (armLBaseX - armSwing);
            parts.armL.pivot.rotation.y = armLBaseY;
            parts.armL.pivot.rotation.z = armLZ;
        }
        if (parts.armR.connected) {
            parts.armR.pivot.rotation.x = throwOverride ? armRX : (armRBaseX + armSwing);
            parts.armR.pivot.rotation.y = armRBaseY;
            parts.armR.pivot.rotation.z = armRZ;
        }

        // ─── torso ───────────────────────────────────────────────────
        if (parts.torso.connected) {
            parts.torso.pivot.rotation.x =
                torsoBaseX + (throwOverride ? torsoDeltaX : 0);
            parts.torso.pivot.rotation.y = torsoBaseY;
            parts.torso.pivot.rotation.z = torsoBaseZ + swing * torsoSwingZ;
            parts.torso.pivot.position.y = parts.torso.basePivot[1] - torsoDrop;
        }

        // ─── head ────────────────────────────────────────────────────
        if (parts.head && parts.head.connected) {
            parts.head.pivot.rotation.x = headBaseX + attackReach * 0.25;
            parts.head.pivot.rotation.y = headBaseY + A.headTurn * headSwingY;
            parts.head.pivot.rotation.z = headBaseZ;
        }
    }

    /* =========================================================================
       PHYSICS + AI  (unchanged)
       ========================================================================= */
    function enemyCollides(pos, hw, h) {
        const x0 = Math.floor((pos.x - hw) / VOXEL + 1e-4);
        const x1 = Math.floor((pos.x + hw) / VOXEL - 1e-4);
        const y0 = Math.floor(pos.y / VOXEL + 1e-4);
        const y1 = Math.floor((pos.y + h) / VOXEL - 1e-4);
        const z0 = Math.floor((pos.z - hw) / VOXEL + 1e-4);
        const z1 = Math.floor((pos.z + hw) / VOXEL - 1e-4);
        for (let y = y0; y <= y1; y++)
            for (let z = z0; z <= z1; z++)
                for (let x = x0; x <= x1; x++)
                    if (getV(x, y, z) !== 0) return true;

        /* --- player --- */
        if (player && player.alive) {
            const pHW = player.halfW;
            const pH = player.height;
            const dx = pos.x - player.pos.x;
            const dz = pos.z - player.pos.z;
            const minD = hw + pHW;
            if (dx * dx + dz * dz < minD * minD) {
                if (!(pos.y + h < player.pos.y || pos.y > player.pos.y + pH))
                    return true;
            }
        }
        return false;
    }

    function updateEnemies(dt) {
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];

            // NEW: remote-owned branch
            if (e._remoteOwned) {
                if (!e.alive && e.dying) updateDeathAnim(e, dt);
                else if (e.alive) updateRemoteEnemy(e, dt);
                continue;
            }

            if (!e.alive) {
                if (e.dying) updateDeathAnim(e, dt);
                continue;
            }

            if (e.hitSlowTimer > 0) e.hitSlowTimer -= dt;

            const dx = player.pos.x - e.pos.x;
            const dz = player.pos.z - e.pos.z;
            const distToPlayer = Math.hypot(dx, dz);
            if (distToPlayer > 60) continue;
            e.losTimer -= dt;
            if (e.losTimer <= 0) {
                e.losTimer = 0.25 + Math.random() * 0.15;
                e.canSeePlayer = distToPlayer < 30 && canSeePlayer(e);
            }
            const reach = e.crawlMode ? 1.0 : e.model.attackRange;
            if (!e.isSlamming) {
                if (e.canSeePlayer) {
                    e.state = distToPlayer <= reach ? "attack" : "chase";
                } else if (e.state !== "wander") {
                    e.state = "wander";
                    e.wanderTarget = null;
                }
            }

            const slowMul = e.hitSlowTimer > 0 ? HIT_SLOW_MULTIPLIER : 1;

            let moveSpeed = 0, dirX = 0, dirZ = 0;

            // --- MINI BOSS SPECIAL LOGIC ---
            if (e.kind === '__mini_boss__') {
                e.skillTimer = (e.skillTimer || 3.0) - dt;

                // Trigger a new skill if not already doing one
                if (e.skillTimer <= 0 && e.canSeePlayer && !e.isThrowing && !e.isSlamming) {
                    if (distToPlayer < 7.0) {
                        // GROUND SLAM — 1.8 s animation, then a forward stone wave.
                        // No terrain carve and no immediate damage; the wave does that.
                        e.skillTimer = 6.0;
                        e.isSlamming = true;
                        e.slamTimer = 0;
                        e.slamYaw = e.yaw;      // lock the facing direction
                        e._waveSpawned = false;
                        e.state = "chase";       // suppress attack-state damage during slam
                    } else if (distToPlayer > 12.0) {
                        // THROW BLOCK — unchanged
                        if (e.heldBlock) {
                            scene.remove(e.heldBlock.mesh);
                            if (e.heldBlock.mesh.geometry) e.heldBlock.mesh.geometry.dispose();
                            e.heldBlock = null;
                        }
                        e.skillTimer = 7.0;
                        e.isThrowing = true;
                        e.throwTimer = 0;
                        e._blockBroken = false;
                        e._blockThrown = false;
                    }
                }
            }
            // -------------------------------

            if (e.state === "chase") {
                const bm = computeBehaviorMove(e, dx, dz, distToPlayer, dt);
                dirX = bm.x;
                dirZ = bm.z;
                let baseSpeed = e.crawlMode ? e.model.speedWalk * 0.35 : e.model.speedRun;

                if (e.kind === '__mini_boss__') {
                    dirX = dx / distToPlayer;
                    dirZ = dz / distToPlayer;
                    baseSpeed = e.model.speedRun;
                }

                moveSpeed = baseSpeed * bm.speedMul * slowMul;   // ← added * slowMul
                e.yaw = Math.atan2(dx, dz) + Math.PI;
            } else if (e.state === "attack") {
                e.yaw = Math.atan2(dx, dz) + Math.PI;
                e.vel.x = 0; e.vel.z = 0;
                if (e.attackTimer <= 0) {
                    if (Hooks.damagePlayer) Hooks.damagePlayer(e.model.attackDamage);
                    e.attackTimer = 1.2;
                    e.attackPhase = 0.001;
                }
            } else {
                e.wanderTimer -= dt;
                if (!e.wanderTarget || e.wanderTimer <= 0 ||
                    Math.hypot(e.wanderTarget.x - e.pos.x, e.wanderTarget.z - e.pos.z) < 0.6) {
                    const a = Math.random() * Math.PI * 2;
                    const d = 3 + Math.random() * 6;
                    e.wanderTarget = {
                        x: clamp(e.pos.x + Math.cos(a) * d, 1, WORLD_W - 1),
                        z: clamp(e.pos.z + Math.sin(a) * d, 1, WORLD_D - 1),
                    };
                    e.wanderTimer = 4 + Math.random() * 4;
                }
                const wx = e.wanderTarget.x - e.pos.x;
                const wz = e.wanderTarget.z - e.pos.z;
                const wd = Math.hypot(wx, wz);
                if (wd > 0.3) {
                    dirX = wx / wd; dirZ = wz / wd;
                    moveSpeed = (e.crawlMode ? e.model.speedWalk * 0.25 : e.model.speedWalk) * slowMul;  // ← added * slowMul
                    e.yaw = Math.atan2(wx, wz) + Math.PI;
                }
            }

            // === Slam override: freeze facing + zero movement ===
            if (e.isSlamming) {
                moveSpeed = 0;
                dirX = 0;
                dirZ = 0;
                e.yaw = e.slamYaw;   // rigid facing, no rotation
            }

            if (moveSpeed > 0 && (dirX !== 0 || dirZ !== 0)) {
                e._steerT = (e._steerT || Math.random() * 100) + dt;
                const weaveAmt = e.model.weaveAmt != null ? e.model.weaveAmt : 0.30;
                const weaveFreq = e.model.weaveFreq != null ? e.model.weaveFreq : 1.70;
                const weave = Math.sin(e._steerT * weaveFreq) * weaveAmt;
                const cw = Math.cos(weave);
                const sw = Math.sin(weave);
                let sx = dirX * cw - dirZ * sw;
                let sz = dirX * sw + dirZ * cw;
                let sepX = 0, sepZ = 0;
                for (let k = 0; k < enemies.length; k++) {
                    const other = enemies[k];
                    if (other === e || !other.alive) continue;
                    const ox = e.pos.x - other.pos.x;
                    const oz = e.pos.z - other.pos.z;
                    const d2 = ox * ox + oz * oz;
                    if (d2 > 2.25 || d2 < 1e-6) continue;
                    const d = Math.sqrt(d2);
                    const push = (1.5 - d) / 1.5;
                    sepX += (ox / d) * push;
                    sepZ += (oz / d) * push;
                }
                sx += sepX * 1.4;
                sz += sepZ * 1.4;
                const mx = e.pos.x - (e._stuckRefX != null ? e._stuckRefX : e.pos.x);
                const mz = e.pos.z - (e._stuckRefZ != null ? e._stuckRefZ : e.pos.z);
                e._stuckAccum = (e._stuckAccum || 0) + Math.hypot(mx, mz);
                e._stuckTimer = (e._stuckTimer || 0) + dt;
                e._stuckRefX = e.pos.x;
                e._stuckRefZ = e.pos.z;
                if (e._stuckTimer > 0.9) {
                    if (e._stuckAccum < 0.4) {
                        e._unstickDir = Math.random() < 0.5 ? -1 : 1;
                        e._unstickT = 0.7 + Math.random() * 0.5;
                    }
                    e._stuckAccum = 0;
                    e._stuckTimer = 0;
                }
                if (e._unstickT > 0) {
                    e._unstickT -= dt;
                    const px = -dirZ * e._unstickDir;
                    const pz = dirX * e._unstickDir;
                    sx = dirX * 0.3 + px * 0.9 + sepX * 0.6;
                    sz = dirZ * 0.3 + pz * 0.9 + sepZ * 0.6;
                }
                const len = Math.hypot(sx, sz);
                if (len > 1e-4) { dirX = sx / len; dirZ = sz / len; }
            }
            if (moveSpeed > 0) {
                e.vel.x = dirX * moveSpeed;
                e.vel.z = dirZ * moveSpeed;
            }
            e.attackTimer -= dt;
            e.vel.y -= GRAVITY * dt;
            const baseColH = e.model.colH || 1.45;
            const colH = baseColH * (1 - 0.6 * e.crawlBlend);
            const colHW = e.model.colHW || 0.28;
            const dy = e.vel.y * dt;
            e.pos.y += dy;
            if (enemyCollides(e.pos, colHW, colH)) {
                e.pos.y -= dy;
                if (dy < 0) e.onGround = true;
                e.vel.y = 0;
            } else e.onGround = false;
            function tryStep(axis, delta) {
                const old = e.pos[axis];
                e.pos[axis] += delta;
                if (!enemyCollides(e.pos, colHW, colH)) return;
                e.pos[axis] = old;
                const savedY = e.pos.y;
                let stepped = false;
                for (let s = 1; s <= 5; s++) {
                    e.pos.y = savedY + s * VOXEL;
                    if (!enemyCollides(e.pos, colHW, colH)) { stepped = true; break; }
                }
                if (!stepped) {
                    e.pos.y = savedY;
                    if (axis === "x") e.vel.x = 0; else e.vel.z = 0;
                    if (e.onGround) e.vel.y = 5.5;
                }
            }
            if (e.vel.x !== 0) tryStep("x", e.vel.x * dt);
            if (e.vel.z !== 0) tryStep("z", e.vel.z * dt);
            e.pos.x = clamp(e.pos.x, 0.4, WORLD_W - 0.4);
            e.pos.z = clamp(e.pos.z, 0.4, WORLD_D - 0.4);
            if (e.pos.y < -4) e.pos.y = 30;
            animateEnemy(e, dt);
            e.rig.root.position.set(
                e.pos.x,
                e.pos.y + (e._visualYOffset || 0),
                e.pos.z,
            );
            e.rig.root.rotation.y = e.yaw;
            updateBleeding(e, dt);
            resolveEnemyDetachedCollisions(e, colHW, colH);
        }
        resolveEnemyCollisions();
        resolvePlayerEnemyCollisions();
        updateDetachedParts(dt);
        updateBloodDrops(dt);
        updateBossProjectiles(dt);
        updateStoneWaves(dt);        // ← new
        updateDustParticles(dt);     // ← new
    }

    /* =========================================================================
       DETACHED PART PHYSICS  (unchanged)
       ========================================================================= */
    const _dq = new THREE.Quaternion();
    const _daxis = new THREE.Vector3();

    function updateDetachedParts(dt) {
        const AIR_DRAG = Math.pow(0.90, dt);   /* horizontal air drag    */
        const GROUND_FRIC = Math.pow(0.02, dt);   /* horizontal ground stop */
        const GROUND_ANG_FRIC = Math.pow(0.008, dt); /* ground spin stop       */
        const AIR_ANG_FRIC = Math.pow(0.55, dt);   /* NEW — air spin decay   */
        const MAX_SPIN = 6.0;                  /* rad/s cap on tumble    */
        const SPIN_DEADZONE = 0.05;                 /* below this → zero it   */

        for (let i = DETACHED_PARTS.length - 1; i >= 0; i--) {
            const d = DETACHED_PARTS[i];
            d.life -= dt;
            if (d.life <= 0) {
                scene.remove(d.mesh);
                if (!d.sharedGeometry && d.mesh.geometry) d.mesh.geometry.dispose();
                DETACHED_PARTS.splice(i, 1);
                continue;
            }

            /* Gravity + translation — chunks are ALWAYS in physics, never
               locked, so the player can shove them around at any time. */
            d.vel.y -= GRAVITY * dt;
            d.mesh.position.x += d.vel.x * dt;
            d.mesh.position.y += d.vel.y * dt;
            d.mesh.position.z += d.vel.z * dt;

            /* Spin integration — capped so a kick can't set them
               tumbling wildly, and so nothing can accumulate over time. */
            let w = d.angVel.length();
            if (w > MAX_SPIN) {
                d.angVel.multiplyScalar(MAX_SPIN / w);
                w = MAX_SPIN;
            }
            if (w > 1e-4) {
                _daxis.copy(d.angVel).multiplyScalar(1 / w);
                _dq.setFromAxisAngle(_daxis, w * dt);
                d.quat.premultiply(_dq);
                d.mesh.quaternion.copy(d.quat);
            }

            /* Voxel ground check — use cluster's BOTTOM extent, not center */
            const halfY = d.halfExtentY != null ? d.halfExtentY : 0.03;
            const bottomY = d.mesh.position.y - halfY;
            const gx = Math.floor(d.mesh.position.x / VOXEL);
            const gy = Math.floor(bottomY / VOXEL);
            const gz = Math.floor(d.mesh.position.z / VOXEL);
            const onGround = getV(gx, gy, gz) !== 0;

            if (onGround) {
                d.mesh.position.y = (gy + 1) * VOXEL + halfY + 0.01;
                if (d.vel.y < 0) d.vel.y = -d.vel.y * 0.18;
                if (Math.abs(d.vel.y) < 0.25) d.vel.y = 0;
                d.vel.x *= GROUND_FRIC;
                d.vel.z *= GROUND_FRIC;
                d.angVel.multiplyScalar(GROUND_ANG_FRIC);
            } else {
                d.vel.x *= AIR_DRAG;
                d.vel.z *= AIR_DRAG;
                d.angVel.multiplyScalar(AIR_ANG_FRIC);   /* NEW — spin decays in air too */
            }

            /* Clamp tiny residual motion so they don't micro-jitter */
            if (Math.abs(d.vel.x) < 0.005) d.vel.x = 0;
            if (Math.abs(d.vel.z) < 0.005) d.vel.z = 0;
            if (onGround && Math.abs(d.vel.y) < 0.05) d.vel.y = 0;

            /* Dead-zone on spin — once a piece is barely rotating,
               snap it to fully still so it reads as settled gore. */
            if (d.angVel.lengthSq() < SPIN_DEADZONE * SPIN_DEADZONE) {
                d.angVel.set(0, 0, 0);
            }

            /* Never fully stops — but the numbers above make a settled chunk
               visually still until the player touches it again. */

            if (d.mesh.position.y < -3) d.life = 0;
        }
    }

    /* =========================================================================
       PLAYER ↔ DETACHED-PART COLLISION
       -------------------------------------------------------------------------
       Every piece gets kicked when the player runs into it — small debris
       flies hard, heavy pieces barely budge.  ON TOP of that, heavy pieces
       also push the player out so you can't phase through a fallen limb.

       Heaviness is derived from the cluster's bounding radius:
         · tiny crumb (r < 0.14 m)  → almost no player resistance
         · limb / torso (r ≥ 0.14)  → real collision + a modest kick
       ========================================================================= */
    function resolvePlayerDetachedCollisions(pos, hw, h) {
        if (!DETACHED_PARTS.length) return;

        const playerVelX = player ? player.vel.x : 0;
        const playerVelZ = player ? player.vel.z : 0;
        const playerSpeed = Math.hypot(playerVelX, playerVelZ);

        const plMinX = pos.x - hw, plMaxX = pos.x + hw;
        const plMinY = pos.y, plMaxY = pos.y + h;
        const plMinZ = pos.z - hw, plMaxZ = pos.z + hw;

        for (let i = 0; i < DETACHED_PARTS.length; i++) {
            const d = DETACHED_PARTS[i];
            if (!d.mesh || !d.radius) continue;
            if (d.life < 0.35) continue;

            const c = d.mesh.position;

            /* Closest point on the player AABB to the chunk center */
            const cx = c.x < plMinX ? plMinX : (c.x > plMaxX ? plMaxX : c.x);
            const cy = c.y < plMinY ? plMinY : (c.y > plMaxY ? plMaxY : c.y);
            const cz = c.z < plMinZ ? plMinZ : (c.z > plMaxZ ? plMaxZ : c.z);

            const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
            const d2 = dx * dx + dy * dy + dz * dz;
            const r = d.radius;
            if (d2 > r * r || d2 < 1e-6) continue;

            const dist = Math.sqrt(d2);
            const overlap = r - dist;
            const invDist = 1 / dist;

            /* Horizontal outward normal, fallback to random if coaxial */
            let nx, nz;
            const h2 = dx * dx + dz * dz;
            if (h2 < 1e-6) {
                const a = Math.random() * Math.PI * 2;
                nx = Math.cos(a);
                nz = Math.sin(a);
            } else {
                const hd = Math.sqrt(h2);
                nx = dx / hd;
                nz = dz / hd;
            }

            /* ---- Heavy vs. light ---------------------------------------
               Light crumbs get a big hard kick and don't block the player.
               Heavy pieces get a *weaker* kick (their weight resists it)
               AND push the player back so they act as real obstacles.   */
            const isSmall =
                r < 0.14 || (d.voxelCount != null && d.voxelCount <= 3);

            /* Kick impulse — always applied, but scaled down by size.
               radius of a small crumb ≈ 0.05 m, of a leg ≈ 0.28 m, so this
               lands around 1.0× for crumbs and ~0.35× for limbs. */
            const sizeFactor = clamp(0.14 / r, 0.25, 2.2);
            const kick = (2.2 + playerSpeed * 0.55) * sizeFactor;
            d.vel.x = nx * kick + playerVelX * 0.35;
            d.vel.z = nz * kick + playerVelZ * 0.35;
            d.vel.y = Math.max(d.vel.y, 0.8 + Math.random() * 0.9 * sizeFactor);

            /* Modest tumble — heavier pieces resist */
            const tumble = 3.0 * sizeFactor;
            d.angVel.x += (Math.random() - 0.5) * tumble;
            d.angVel.y += (Math.random() - 0.5) * tumble;
            d.angVel.z += (Math.random() - 0.5) * tumble;

            /* Always push the chunk out of the player capsule so we don't
               re-kick every frame — the chunk moves, not the player (yet). */
            d.mesh.position.x += nx * (overlap + 0.02);
            d.mesh.position.z += nz * (overlap + 0.02);

            /* ---- Heavy pieces also block the player --------------------- */
            if (!isSmall) {
                const oldX = pos.x, oldZ = pos.z;
                const correction = Math.min(overlap, 0.14);
                pos.x -= nx * correction;
                pos.z -= nz * correction;

                /* If the push would shove the player into a wall, revert
                   and let the chunk keep its kick instead. */
                if (_wouldPlayerCollide(pos, hw, h)) {
                    pos.x = oldX;
                    pos.z = oldZ;
                }
            }
        }
    }

    /* Cheap AABB-vs-voxel test so we don't shove the player through walls */
    function _wouldPlayerCollide(pos, hw, h) {
        const x0 = Math.floor((pos.x - hw) / VOXEL + 1e-4);
        const x1 = Math.floor((pos.x + hw) / VOXEL - 1e-4);
        const y0 = Math.floor(pos.y / VOXEL + 1e-4);
        const y1 = Math.floor((pos.y + h) / VOXEL - 1e-4);
        const z0 = Math.floor((pos.z - hw) / VOXEL + 1e-4);
        const z1 = Math.floor((pos.z + hw) / VOXEL - 1e-4);
        for (let y = y0; y <= y1; y++)
            for (let z = z0; z <= z1; z++)
                for (let x = x0; x <= x1; x++)
                    if (getV(x, y, z) !== 0) return true;
        return false;
    }

    /* =========================================================================
       ENEMY ↔ DETACHED-PART PUSH
       -------------------------------------------------------------------------
       Enemies don't block on debris — they shove it out of the way.  Otherwise
       the nav can wedge them against a fallen limb and they'd never reach you.
       ========================================================================= */
    function resolveEnemyDetachedCollisions(e, hw, h) {
        if (!DETACHED_PARTS.length) return;

        for (let i = 0; i < DETACHED_PARTS.length; i++) {
            const d = DETACHED_PARTS[i];
            if (!d.mesh || !d.radius) continue;
            if (d.life < 0.35) continue;

            const c = d.mesh.position;

            /* Vertical overlap check first (cheap) */
            if (c.y + d.radius < e.pos.y) continue;
            if (c.y - d.radius > e.pos.y + h) continue;

            const dx = c.x - e.pos.x;
            const dz = c.z - e.pos.z;
            const minD = hw + d.radius;
            const d2 = dx * dx + dz * dz;
            if (d2 > minD * minD || d2 < 1e-6) continue;

            const dist = Math.sqrt(d2);
            const nx = dx / dist, nz = dz / dist;

            /* Shove the chunk away — enemies plow through gore */
            const strength = 1.8 + Math.random() * 1.2;
            d.vel.x += nx * strength;
            d.vel.z += nz * strength;
            d.vel.y = Math.max(d.vel.y, 0.9 + Math.random() * 0.8);
            d.angVel.x += (Math.random() - 0.5) * 3;
            d.angVel.y += (Math.random() - 0.5) * 3;
            d.angVel.z += (Math.random() - 0.5) * 3;

            /* Physically separate so we don't re-shove every frame */
            const overlap = minD - dist;
            d.mesh.position.x += nx * (overlap + 0.02);
            d.mesh.position.z += nz * (overlap + 0.02);
        }
    }

    /* =========================================================================
       WAVE SPAWNER  (unchanged)
       ========================================================================= */
    const SPAWN_TABLE = [
        { type: "walker", weight: 90, minWave: 1 },
        { type: "stripey", weight: 28, minWave: 1 },
        { type: "formal", weight: 20, minWave: 2 },
        { type: "crawler", weight: 20, minWave: 2 },
        { type: "hatty", weight: 28, minWave: 2 },
        { type: "blondie", weight: 26, minWave: 2 },
        { type: "beanie", weight: 22, minWave: 3 },
        { type: "runner", weight: 32, minWave: 3 },
        { type: "hooded", weight: 26, minWave: 3 },
        { type: "capboy", weight: 22, minWave: 3 },
        { type: "skull", weight: 18, minWave: 4 },
        { type: "vested", weight: 22, minWave: 4 },
        { type: "rotter", weight: 26, minWave: 4 },
        { type: "oldblood", weight: 22, minWave: 5 },
        { type: "demon", weight: 14, minWave: 6 },
        { type: "brute", weight: 14, minWave: 6 },
        { type: "greyscout", weight: 24, minWave: 3 },
        { type: "wisp", weight: 22, minWave: 3 },
        { type: "trilens", weight: 22, minWave: 4 },
        { type: "bloom", weight: 20, minWave: 4 },
        { type: "voidtwin", weight: 20, minWave: 5 },
        { type: "blobtron", weight: 18, minWave: 4 },
        { type: "serpent", weight: 18, minWave: 4 },
        { type: "imp", weight: 16, minWave: 5 },
    ];

    function pickZombieType(wave) {
        const pool = [];
        let total = 0;
        for (const row of SPAWN_TABLE) {
            if (wave < row.minWave) continue;
            pool.push(row);
            total += row.weight;
        }
        if (!pool.length) return "walker";
        let r = Math.random() * total;
        for (const row of pool) {
            r -= row.weight;
            if (r <= 0) return row.type;
        }
        return pool[pool.length - 1].type;
    }

    let enemySpawnTimer = 4, wave = 1, waveTimer = 0;
    let sandboxSpawnType = null;
    let sandboxCycleIdx = 0;
    let sandboxCycleTimer = 0;
    let sandboxSpawnTimer = 6;
    const SANDBOX_CYCLE_SEC = 8;
    const SANDBOX_SPAWN_SEC = 4;

    function groundYAt(wx, wz) {
        const vx = Math.floor(wx / VOXEL);
        const vz = Math.floor(wz / VOXEL);
        for (let y = SY - 1; y > 0; y--) {
            if (getV(vx, y, vz) !== 0) return (y + 1) * VOXEL + 0.1;
        }
        return 30;
    }

    function tickSandboxWaves(dt) {
        const types = Object.keys(MODELS);
        if (!types.length) return;
        sandboxCycleTimer += dt;
        if (sandboxCycleTimer >= SANDBOX_CYCLE_SEC) {
            sandboxCycleTimer = 0;
            sandboxCycleIdx = (sandboxCycleIdx + 1) % types.length;
        }
        sandboxSpawnTimer -= dt;
        if (sandboxSpawnTimer > 0) return;
        const type = (sandboxSpawnType && MODELS[sandboxSpawnType])
            ? sandboxSpawnType
            : types[sandboxCycleIdx];
        const p = player.pos;
        const a = Math.random() * Math.PI * 2;
        const d = 7 + Math.random() * 6;
        const wx = p.x + Math.cos(a) * d;
        const wz = p.z + Math.sin(a) * d;
        spawnEnemy(type, { x: wx, y: groundYAt(wx, wz), z: wz });
        sandboxSpawnTimer = SANDBOX_SPAWN_SEC;
    }

    function tickWaves(dt, mapType) {
        const _mp = window.ARiveMP;
        if (window.SurvivalMode &&
            (window.SurvivalMode.state === 'PREP' ||
                window.SurvivalMode.state === 'WAVE' ||
                window.SurvivalMode.state === 'BOSS')) {
            return;
        }
        if (_mp && _mp.connected && !_mp.isHost) return;
        if (mapType === "sandbox") {
            /* Only run the loop when the sandbox flag is enabled. */
            if (!window.ARiveSandboxFlags || !window.ARiveSandboxFlags.enemyLoop) {
                return;
            }

            sandboxSpawnTimer -= dt;
            if (sandboxSpawnTimer > 0) return;

            /* Uniform pick from EVERY registered model — zombies AND aliens.
               No wave gating, so rare aliens show up immediately. */
            const allKeys = Object.keys(MODELS);
            if (!allKeys.length) return;

            const p = player.pos;

            const roll = Math.random();
            const count = roll < 0.35 ? 2 : 1;

            for (let i = 0; i < count; i++) {
                const type = allKeys[(Math.random() * allKeys.length) | 0];
                const a = Math.random() * Math.PI * 2;
                const d = 8 + Math.random() * 8;
                const wx = clamp(p.x + Math.cos(a) * d, 1, WORLD_W - 1);
                const wz = clamp(p.z + Math.sin(a) * d, 1, WORLD_D - 1);
                spawnEnemy(type, { x: wx, y: groundYAt(wx, wz), z: wz });
            }

            /* Snappy cadence — the sandbox is for experimentation, not survival. */
            sandboxSpawnTimer = 1.4 + Math.random() * 1.6;
            return;
        }

        waveTimer += dt;
        if (waveTimer > 55) { wave++; waveTimer = 0; }
        enemySpawnTimer -= dt;
        if (enemySpawnTimer <= 0) {
            const count = 1 + Math.min(3, Math.floor(wave / 2));
            for (let i = 0; i < count; i++) spawnEnemy(pickZombieType(wave));
            enemySpawnTimer = Math.max(4, 11 - wave * 0.5);
        }
    }

    function resetWaves() {
        wave = 1; waveTimer = 0; enemySpawnTimer = 4;
        sandboxSpawnType = null;
        sandboxCycleIdx = 0;
        sandboxCycleTimer = 0;
        sandboxSpawnTimer = 6;
    }

    function findByMpId(mpId) {
        for (let i = 0; i < enemies.length; i++) {
            if (enemies[i]._mpId === mpId) return enemies[i];
        }
        return null;
    }

    function updateRemoteEnemy(e, dt) {
        // Interpolate toward the last snapshot from the host.
        const k = Math.min(1, dt * 12);
        const oldX = e.pos.x, oldZ = e.pos.z;

        e.pos.x += (e._targetX - e.pos.x) * k;
        e.pos.y += (e._targetY - e.pos.y) * k;
        e.pos.z += (e._targetZ - e.pos.z) * k;

        // Derive velocity so the walk cycle has something to read.
        e.vel.x = (e.pos.x - oldX) / Math.max(dt, 1e-4);
        e.vel.z = (e.pos.z - oldZ) / Math.max(dt, 1e-4);
        e.vel.y = 0;

        // Yaw — shortest arc.
        let d = e._targetYaw - e.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        e.yaw += d * Math.min(1, dt * 14);

        // Feed the animator.
        const spd = Math.hypot(e.vel.x, e.vel.z);
        e.moving = spd > 0.35;
        if (typeof e._targetSlow === 'number') {
            e.hitSlowTimer = e._targetSlow;
        }
        if (typeof e._targetCrawlBlend === 'number') {
            e.crawlBlend += (e._targetCrawlBlend - e.crawlBlend) * Math.min(1, dt * 6);
        }
        if (typeof e._targetHp === 'number') e.hp = e._targetHp;

        animateEnemy(e, dt);
        e.rig.root.position.set(
            e.pos.x,
            e.pos.y + (e._visualYOffset || 0),
            e.pos.z,
        );
        e.rig.root.rotation.y = e.yaw;

        if (e._targetAlive === false && e.alive) {
            e.hp = 0;
            checkEnemyDeath(e);
        }
    }

    function spawnRemoteEnemy(type, x, y, z, yaw, mpId) {
        const e = spawnEnemy(type, { x, y, z }, mpId);
        if (!e) return null;
        e.yaw = yaw || 0;
        e.rig.root.rotation.y = e.yaw;
        e._targetYaw = e.yaw;
        e._targetX = x; e._targetY = y; e._targetZ = z;
        return e;
    }

    function applyRemoteEnemyState(list) {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            const e = findByMpId(s.i);
            if (!e) continue;
            e._targetX = s.x;
            e._targetY = s.y;
            e._targetZ = s.z;
            e._targetYaw = s.yaw;
            e._targetHp = s.hp;
            e._targetAlive = !!s.a;
            e._targetSlow = s.sl || 0;
            e._targetCrawlBlend = s.cb || 0;

            // NEW: boss action state sync
            if (e.kind === '__mini_boss__' || e.kind === '__final_boss__') {
                const wasThrowing = !!e.isThrowing;
                const nowThrowing = !!s.th;
                e.isThrowing = nowThrowing;
                if (nowThrowing && !wasThrowing) {
                    // Transition into throw — snapshot the host timer + reset
                    // local sub-flags so the arm animation starts clean.
                    e.throwTimer = s.tt || 0;
                    e._blockBroken = false;
                    e._blockThrown = false;
                } else if (nowThrowing && typeof s.tt === 'number') {
                    // Correct drift every batch (100 ms window). Small jumps
                    // read as "caught up", not as teleporting.
                    if (Math.abs((e.throwTimer || 0) - s.tt) > 0.3) {
                        e.throwTimer = s.tt;
                    }
                }

                const wasSlamming = !!e.isSlamming;
                const nowSlamming = !!s.sm;
                e.isSlamming = nowSlamming;
                if (nowSlamming && !wasSlamming) {
                    e.slamTimer = s.st || 0;
                    e.slamYaw = s.sy || 0;
                    e._waveSpawned = false;
                } else if (nowSlamming) {
                    if (typeof s.st === 'number' &&
                        Math.abs((e.slamTimer || 0) - s.st) > 0.2) {
                        e.slamTimer = s.st;
                    }
                    if (typeof s.sy === 'number') e.slamYaw = s.sy;
                }
            }
        }
    }

    function applyRemoteEnemyCarve(eid, partKey, wx, wy, wz, rVox) {
        const e = findByMpId(eid);
        if (!e) return;
        const part = e.parts[partKey];
        if (!part) return;
        const wp = new THREE.Vector3(wx, wy, wz);
        carvePartAt(part, wp, rVox, e.model.voxelSize);
    }

    function hitEnemyById(eid, hx, hy, hz, dmg, dirX, dirY, dirZ, carveRadiusWorld) {
        const e = findByMpId(eid);
        if (!e || !e.alive) return false;

        applyHitSlow(e);

        // Find the part whose bounding sphere is closest to the hit point.
        let bestKey = null, bestD2 = Infinity;
        _hitV.set(hx, hy, hz);
        for (const key in e.parts) {
            const p = e.parts[key];
            if (!p.connected || p.voxels.length === 0) continue;
            partCentreWorld(p, e.model.voxelSize, _pv);
            const d2 = _pv.distanceToSquared(_hitV);
            const rad = partVoxelAABB(p, e.model.voxelSize).radius + 0.6;
            if (d2 > rad * rad) continue;
            if (d2 < bestD2) { bestD2 = d2; bestKey = key; }
        }
        if (!bestKey) return false;

        const part = e.parts[bestKey];
        const vs = e.model.voxelSize;

        let top = part.mesh;
        while (top.parent) top = top.parent;
        top.updateMatrixWorld(true);

        _hitInv.copy(part.mesh.matrixWorld).invert();
        _hitLocal.copy(_hitV).applyMatrix4(_hitInv);

        let nearestVoxel = null, nearestD2 = Infinity;
        const voxels = part.voxels;
        for (let i = 0; i < voxels.length; i++) {
            const v = voxels[i];
            const ddx = (v[0] + 0.5) * vs - _hitLocal.x;
            const ddy = (v[1] + 0.5) * vs - _hitLocal.y;
            const ddz = (v[2] + 0.5) * vs - _hitLocal.z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < nearestD2) { nearestD2 = d2; nearestVoxel = v; }
        }
        const carveAt = nearestVoxel
            ? voxelWorldPosition(part, nearestVoxel, vs, _tmpCarve, part.mesh.matrixWorld)
            : _hitV.clone();

        const radiusVox = (typeof carveRadiusWorld === "number" && carveRadiusWorld > 0)
            ? carveRadiusWorld * ENEMY_CARVE_WORLD_TO_VOX
            : 1.85;
        carvePartAt(part, carveAt, radiusVox, vs);
        for (let i = 0; i < 5; i++) {
            spawnBloodDrop(
                carveAt.x + (Math.random() - 0.5) * 0.10,
                carveAt.y + (Math.random() - 0.5) * 0.10,
                carveAt.z + (Math.random() - 0.5) * 0.10,
            );
        }
        if (!(window.ARiveSandboxFlags && window.ARiveSandboxFlags.infiniteEnemyHealth)) {
            e.hp -= dmg;
        }
        e.hitFlash = 1.0;
        if (Hooks.spawnBloodBurst)
            Hooks.spawnBloodBurst(carveAt.x, carveAt.y, carveAt.z, 8);
        checkEnemyDeath(e);
        return true;
    }

    /* =========================================================================
       PUBLIC API  (unchanged)
       ========================================================================= */
    function clearAll() {
        // ✅ 修复：清理活着的敌人
        for (const e of enemies) {
            scene.remove(e.rig.root);
            if (e.heldBlock) {
                scene.remove(e.heldBlock.mesh);
                if (e.heldBlock.mesh.geometry) e.heldBlock.mesh.geometry.dispose();
                e.heldBlock = null;
            }
            for (const key in e.parts) {
                const p = e.parts[key];
                if (p.mesh && p.mesh.geometry) {
                    // 防止重复释放已经掉落的肢体
                    if (!DETACHED_PARTS.some(d => d.mesh === p.mesh)) {
                        p.mesh.geometry.dispose();
                    }
                }
            }
        }
        enemies.length = 0;

        // ✅ 修复：清理碎块
        for (const d of DETACHED_PARTS) {
            scene.remove(d.mesh);
            if (d.mesh.geometry) d.mesh.geometry.dispose();
        }
        DETACHED_PARTS.length = 0;

        // 血迹和投掷物使用的是共享的几何体，不需要 dispose，直接移除即可
        for (const d of BLOOD_DROPS) scene.remove(d.mesh);
        BLOOD_DROPS.length = 0;

        for (const p of bossProjectiles) scene.remove(p.mesh);
        bossProjectiles.length = 0;

        for (const w of stoneWaves) scene.remove(w.mesh);
        stoneWaves.length = 0;

        for (const d of DUST_PARTICLES) scene.remove(d.mesh);
        DUST_PARTICLES.length = 0;

        resetWaves();
    }

    window.Enemies = {
        update: updateEnemies,
        spawn: spawnEnemy,
        hurt: hurtEnemy,
        hitRay: hitEnemyRay,
        canSeePlayer,
        clear: clearAll,
        tickWaves,
        resolvePlayerDetachedCollisions,

        // MP surface:
        spawnRemote: spawnRemoteEnemy,
        findByMpId,
        applyRemoteState: applyRemoteEnemyState,
        applyRemoteCarve: applyRemoteEnemyCarve,
        hitRemote: hitEnemyById,

        types: ZOMBIE_TYPES,
        get wave() { return wave; },
        setSandboxType: (t) => {
            sandboxSpawnType = (t && MODELS[t]) ? t : null;
            if (sandboxSpawnType) sandboxSpawnTimer = 0;
            return sandboxSpawnType;
        },
        getSandboxType: () => sandboxSpawnType,
        get list() { return enemies; },
        get count() {
            let n = 0;
            for (const e of enemies) if (e.alive) n++;
            return n;
        },
    };

    /* =========================================================================
   BOSS HP BAR — floating top-of-screen bar for __mini_boss__ / __final_boss__
   -------------------------------------------------------------------------
   · Self-contained: creates its own DOM element + RAF loop.
   · Reads game state via Hooks (getGameRunning, player).
   · Shows whenever a boss exists in `enemies` — waves, sandbox, anywhere.
   · Pauses/hides on death or game pause, auto-hides when boss is removed.
   ========================================================================= */
    (function setupBossBar() {
        if (typeof document === "undefined" || typeof window === "undefined") return;

        const barEl = document.createElement("div");
        barEl.id = "ariveBossBar";
        barEl.style.cssText =
            "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
            "width:min(600px,72vw);z-index:7;pointer-events:none;" +
            "opacity:0;transition:opacity .35s ease;";
        barEl.innerHTML =
            '<div id="ariveBossName" style="' +
            'font:bold 14px \'Courier New\',monospace;letter-spacing:4px;' +
            'color:#e8c86a;text-align:center;' +
            'text-shadow:2px 2px 0 #000,0 0 10px rgba(232,200,106,.5);' +
            'margin-bottom:5px;text-transform:uppercase;white-space:nowrap;">' +
            'BOSS</div>' +
            '<div style="' +
            'width:100%;height:20px;background:#12161d;' +
            'border:2px solid #e8c86a;' +
            'box-shadow:inset 0 0 0 1px #05070a,0 0 16px rgba(232,200,106,.35);' +
            'position:relative;overflow:hidden;">' +
            '<div id="ariveBossFill" style="' +
            'height:100%;width:100%;' +
            'background:linear-gradient(to right,#8a1818,#c03030 60%,#e05050);' +
            'transition:width .18s linear;' +
            'box-shadow:inset 0 -3px 0 rgba(0,0,0,.25);"></div>' +
            '</div>';

        const nameEl = barEl.querySelector("#ariveBossName");
        const fillEl = barEl.querySelector("#ariveBossFill");

        let lastLabel = "";
        let hideT = 0;
        let lastT = 0;

        function mount() {
            if (!document.body) { setTimeout(mount, 30); return; }
            document.body.appendChild(barEl);
            requestAnimationFrame(tick);
        }

        function tick() {
            requestAnimationFrame(tick);
            const now = performance.now();
            const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
            lastT = now;

            // Only show during active play
            const running = Hooks.getGameRunning ? Hooks.getGameRunning() : true;
            if (!running || !player.alive) {
                barEl.style.opacity = "0";
                hideT = 0;
                return;
            }

            // Pick which boss to display — final boss wins over mini boss,
            // first alive-one wins otherwise.
            let boss = null;
            for (let i = 0; i < enemies.length; i++) {
                const e = enemies[i];
                if (e.kind === "__final_boss__") { boss = e; break; }
                if (e.kind === "__mini_boss__" && !boss) boss = e;
            }

            if (!boss) {
                hideT += dt;
                if (hideT > 0.4) barEl.style.opacity = "0";
                return;
            }

            hideT = 0;
            barEl.style.opacity = "1";

            const pct = boss.alive
                ? Math.max(0, Math.min(100, (boss.hp / boss.maxHp) * 100))
                : 0;
            fillEl.style.width = pct + "%";

            const label = boss.kind === "__final_boss__"
                ? "◆ FINAL BOSS ◆"
                : "◆ MINI BOSS ◆";
            if (lastLabel !== label) {
                nameEl.textContent = label;
                lastLabel = label;
            }
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", mount);
        } else {
            mount();
        }
    })();
})();