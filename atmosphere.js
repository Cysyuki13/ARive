/* =========================================================================
   ARive — Cinematic Apocalypse Atmosphere
   -------------------------------------------------------------------------
   Layers a post-apocalyptic, cinematic look on top of the base game:

     · Falling ash particles (drifting dark flecks)
     · Rising embers (glowing orange specks)
     · Floating dust motes (gentle shimmer)
     · Distant sun glow (additive 3D sprite, visible through fog)
     · Screen overlays: film grain, vignette, warm color tint

   Loaded AFTER game.js so window.ARiveHooks is available.
   ========================================================================= */
(function () {
    'use strict';

    function H() { return window.ARiveHooks || {}; }

    // ---------- state ----------
    let scene = null, camera = null;
    let inited = false, time = 0;

    let ashPoints, ashGeo, ashData;
    let emberPoints, emberGeo, emberData;
    let dustPoints, dustGeo, dustData;
    let sunSprite;

    let grainEl, grainFrames = [], grainFrame = 0;
    let sunDir = null;

    // ---------- tunables ----------
    const ASH_COUNT = 700;
    const EMBER_COUNT = 100;
    const DUST_COUNT = 350;
    const ASH_BOX = 30;   // half-extent of the ash field around the player
    const EMBER_BOX = 20;
    const DUST_BOX = 15;
    const GRAIN_FRAMES = 4;
    const GRAIN_CYCLE_FRAMES = 2;

    // ---------- texture helpers ----------
    function radialTex(size, stops) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        for (const s of stops) g.addColorStop(s[0], s[1]);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return new THREE.CanvasTexture(c);
    }
    const ashTex = () => radialTex(16, [
        [0, 'rgba(120,100,80,0.95)'],
        [0.6, 'rgba(80,60,45,0.6)'],
        [1, 'rgba(60,40,30,0)'],
    ]);
    const emberTex = () => radialTex(32, [
        [0, 'rgba(255,245,200,1)'],
        [0.15, 'rgba(255,200,100,0.95)'],
        [0.5, 'rgba(255,120,40,0.4)'],
        [1, 'rgba(255,60,10,0)'],
    ]);
    const dustTex = () => radialTex(16, [
        [0, 'rgba(255,235,180,0.9)'],
        [0.4, 'rgba(255,220,150,0.35)'],
        [1, 'rgba(255,200,100,0)'],
    ]);
    const sunTex = () => radialTex(128, [
        [0, 'rgba(255,245,220,1)'],
        [0.08, 'rgba(255,220,140,0.95)'],
        [0.2, 'rgba(255,160,70,0.6)'],
        [0.4, 'rgba(255,120,40,0.2)'],
        [1, 'rgba(255,80,20,0)'],
    ]);

    function makeGrainDataURL() {
        const s = 256;
        const c = document.createElement('canvas');
        c.width = c.height = s;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(s, s);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = Math.random() < 0.5 ? 30 : 225;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = Math.random() < 0.35 ? 255 : 0;
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL();
    }

    // ---------- particle init ----------
    function initAsh() {
        ashGeo = new THREE.BufferGeometry();
        const pos = new Float32Array(ASH_COUNT * 3);
        ashData = new Float32Array(ASH_COUNT * 4);
        for (let i = 0; i < ASH_COUNT; i++) {
            pos[i * 3 + 0] = (Math.random() - 0.5) * ASH_BOX * 2;
            pos[i * 3 + 1] = Math.random() * 30;
            pos[i * 3 + 2] = (Math.random() - 0.5) * ASH_BOX * 2;
            ashData[i * 4 + 0] = Math.random() * 6.28;
            ashData[i * 4 + 1] = 0.3 + Math.random() * 0.8;
            ashData[i * 4 + 2] = 0.3 + Math.random() * 0.7;
            ashData[i * 4 + 3] = Math.random();
        }
        ashGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.10, map: ashTex(), transparent: true,
            depthWrite: false, opacity: 0.8, sizeAttenuation: true,
        });
        ashPoints = new THREE.Points(ashGeo, mat);
        ashPoints.frustumCulled = false;
        scene.add(ashPoints);
    }

    function initEmbers() {
        emberGeo = new THREE.BufferGeometry();
        const pos = new Float32Array(EMBER_COUNT * 3);
        emberData = new Float32Array(EMBER_COUNT * 4);
        for (let i = 0; i < EMBER_COUNT; i++) {
            pos[i * 3 + 0] = (Math.random() - 0.5) * EMBER_BOX * 2;
            pos[i * 3 + 1] = Math.random() * 15;
            pos[i * 3 + 2] = (Math.random() - 0.5) * EMBER_BOX * 2;
            emberData[i * 4 + 0] = Math.random() * 6.28;
            emberData[i * 4 + 1] = 0.4 + Math.random() * 1.0;
            emberData[i * 4 + 2] = Math.random() * 6.28;
            emberData[i * 4 + 3] = Math.random();
        }
        emberGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.20, map: emberTex(), transparent: true,
            depthWrite: false, blending: THREE.AdditiveBlending,
            opacity: 0.9, sizeAttenuation: true, color: 0xffaa40,
        });
        emberPoints = new THREE.Points(emberGeo, mat);
        emberPoints.frustumCulled = false;
        scene.add(emberPoints);
    }

    function initDust() {
        dustGeo = new THREE.BufferGeometry();
        const pos = new Float32Array(DUST_COUNT * 3);
        dustData = new Float32Array(DUST_COUNT * 4);
        for (let i = 0; i < DUST_COUNT; i++) {
            pos[i * 3 + 0] = (Math.random() - 0.5) * DUST_BOX * 2;
            pos[i * 3 + 1] = Math.random() * 15;
            pos[i * 3 + 2] = (Math.random() - 0.5) * DUST_BOX * 2;
            dustData[i * 4 + 0] = Math.random() * 6.28;
            dustData[i * 4 + 1] = 0.2 + Math.random() * 0.5;
            dustData[i * 4 + 2] = Math.random() * 6.28;
            dustData[i * 4 + 3] = Math.random();
        }
        dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.06, map: dustTex(), transparent: true,
            depthWrite: false, blending: THREE.AdditiveBlending,
            opacity: 0.55, sizeAttenuation: true, color: 0xffe8b0,
        });
        dustPoints = new THREE.Points(dustGeo, mat);
        dustPoints.frustumCulled = false;
        scene.add(dustPoints);
    }

    function initSun() {
        const g = H();
        const W = g.WORLD_W || 153.6;
        const D = g.WORLD_D || 153.6;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: sunTex(), transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false, depthTest: false,
            color: 0xffe0c0, opacity: 0.95,
        }));
        const dist = 100;
        sprite.position.set(
            W * 0.5 + sunDir.x * dist,
            sunDir.y * dist,
            D * 0.5 + sunDir.z * dist
        );
        sprite.scale.setScalar(28);
        sprite.renderOrder = -5;
        scene.add(sprite);
        sunSprite = sprite;
    }

    // ---------- screen overlays ----------
    function initOverlays() {
        // Vignette
        const vig = document.createElement('div');
        vig.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:4;' +
            'background:radial-gradient(ellipse at center,' +
            'transparent 22%,rgba(20,8,4,0.22) 60%,' +
            'rgba(8,3,2,0.70) 92%,rgba(4,2,1,0.88) 100%);';
        document.body.appendChild(vig);

        // Warm color tint (multiply → warm/darkens)
        const tint = document.createElement('div');
        tint.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:4;' +
            'background:linear-gradient(180deg,' +
            'rgba(180,90,30,0.10) 0%,' +
            'rgba(120,50,15,0.06) 40%,' +
            'rgba(40,15,5,0.18) 100%);' +
            'mix-blend-mode:multiply;';
        document.body.appendChild(tint);

        // Film grain
        grainEl = document.createElement('div');
        grainEl.id = 'atmoGrain';
        grainEl.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:4;' +
            'mix-blend-mode:overlay;opacity:0.09;' +
            'background-repeat:repeat;background-size:256px 256px;';
        document.body.appendChild(grainEl);

        for (let i = 0; i < GRAIN_FRAMES; i++) {
            grainFrames.push('url(' + makeGrainDataURL() + ')');
        }
        grainEl.style.backgroundImage = grainFrames[0];
    }

    function updateOverlays() {
        grainFrame++;
        if (grainFrame >= GRAIN_CYCLE_FRAMES) {
            grainFrame = 0;
            const idx = (Math.random() * GRAIN_FRAMES) | 0;
            grainEl.style.backgroundImage = grainFrames[idx];
            grainEl.style.backgroundPosition =
                ((Math.random() * 256) | 0) + 'px ' +
                ((Math.random() * 256) | 0) + 'px';
            grainEl.style.opacity = (0.07 + Math.random() * 0.04).toFixed(3);
        }
    }

    // ---------- particle updates ----------
    function updateParticles(dt, cx, cy, cz) {
        // Ash — falls, drifts, recycles around the player
        {
            const p = ashGeo.attributes.position.array;
            for (let i = 0; i < ASH_COUNT; i++) {
                ashData[i * 4 + 0] += dt * 0.5;
                p[i * 3 + 0] += Math.sin(time * ashData[i * 4 + 2] + ashData[i * 4 + 0]) * dt * 0.6 + dt * 0.3;
                p[i * 3 + 1] -= dt * ashData[i * 4 + 1];
                p[i * 3 + 2] += Math.cos(time * ashData[i * 4 + 2] * 0.8 + ashData[i * 4 + 0]) * dt * 0.4 + dt * 0.15;

                if (p[i * 3 + 1] < cy - 5) {
                    p[i * 3 + 1] = cy + 25 + Math.random() * 5;
                    p[i * 3 + 0] = cx + (Math.random() - 0.5) * ASH_BOX * 2;
                    p[i * 3 + 2] = cz + (Math.random() - 0.5) * ASH_BOX * 2;
                }
                if (p[i * 3 + 0] > cx + ASH_BOX) p[i * 3 + 0] = cx - ASH_BOX;
                else if (p[i * 3 + 0] < cx - ASH_BOX) p[i * 3 + 0] = cx + ASH_BOX;
                if (p[i * 3 + 2] > cz + ASH_BOX) p[i * 3 + 2] = cz - ASH_BOX;
                else if (p[i * 3 + 2] < cz - ASH_BOX) p[i * 3 + 2] = cz + ASH_BOX;
            }
            ashGeo.attributes.position.needsUpdate = true;
        }

        // Embers — rise, flicker, recycle
        {
            const p = emberGeo.attributes.position.array;
            for (let i = 0; i < EMBER_COUNT; i++) {
                emberData[i * 4 + 0] += dt * 2.0;
                p[i * 3 + 0] += Math.sin(emberData[i * 4 + 0] + emberData[i * 4 + 2]) * dt * 0.4;
                p[i * 3 + 1] += dt * emberData[i * 4 + 1];
                p[i * 3 + 2] += Math.cos(emberData[i * 4 + 0] * 0.7 + emberData[i * 4 + 2]) * dt * 0.3;

                if (p[i * 3 + 1] > cy + 20) {
                    p[i * 3 + 1] = cy - 3;
                    p[i * 3 + 0] = cx + (Math.random() - 0.5) * EMBER_BOX * 2;
                    p[i * 3 + 2] = cz + (Math.random() - 0.5) * EMBER_BOX * 2;
                }
                if (p[i * 3 + 0] > cx + EMBER_BOX) p[i * 3 + 0] = cx - EMBER_BOX;
                else if (p[i * 3 + 0] < cx - EMBER_BOX) p[i * 3 + 0] = cx + EMBER_BOX;
                if (p[i * 3 + 2] > cz + EMBER_BOX) p[i * 3 + 2] = cz - EMBER_BOX;
                else if (p[i * 3 + 2] < cz - EMBER_BOX) p[i * 3 + 2] = cz + EMBER_BOX;
            }
            emberGeo.attributes.position.needsUpdate = true;
        }

        // Dust — gentle float
        {
            const p = dustGeo.attributes.position.array;
            for (let i = 0; i < DUST_COUNT; i++) {
                dustData[i * 4 + 0] += dt;
                p[i * 3 + 0] += Math.sin(time * 0.4 + dustData[i * 4 + 0] + dustData[i * 4 + 2]) * dt * 0.15;
                p[i * 3 + 1] += Math.sin(time * 0.6 + dustData[i * 4 + 0] * 2) * dt * 0.10;
                p[i * 3 + 2] += Math.cos(time * 0.4 + dustData[i * 4 + 0] + dustData[i * 4 + 2]) * dt * 0.15;

                if (p[i * 3 + 0] > cx + DUST_BOX) p[i * 3 + 0] = cx - DUST_BOX;
                else if (p[i * 3 + 0] < cx - DUST_BOX) p[i * 3 + 0] = cx + DUST_BOX;
                if (p[i * 3 + 2] > cz + DUST_BOX) p[i * 3 + 2] = cz - DUST_BOX;
                else if (p[i * 3 + 2] < cz - DUST_BOX) p[i * 3 + 2] = cz + DUST_BOX;
                if (p[i * 3 + 1] > cy + 12) p[i * 3 + 1] = cy - 3;
                else if (p[i * 3 + 1] < cy - 3) p[i * 3 + 1] = cy + 12;
            }
            dustGeo.attributes.position.needsUpdate = true;
        }
    }

    // ---------- public ----------
    function init() {
        if (inited) return;
        if (typeof THREE === 'undefined') return;
        const g = H();
        scene = g.scene;
        camera = g.camera;
        if (!scene) return;

        sunDir = new THREE.Vector3(0.8, 0.25, 0.15).normalize();

        initAsh();
        initEmbers();
        initDust();
        initSun();
        initOverlays();

        inited = true;
        console.log('[Atmosphere] cinematic apocalypse layers active');
    }

    function update(dt) {
        if (!inited) { init(); return; }
        const g = H();
        const player = g.player;
        if (!player) return;
        time += dt;
        updateParticles(dt, player.pos.x, player.pos.y, player.pos.z);
        updateOverlays();

        if (sunSprite) {
            const s = 28 + Math.sin(time * 1.1) * 1.5;
            sunSprite.scale.setScalar(s);
            sunSprite.material.opacity = 0.88 + Math.sin(time * 2.3) * 0.07;
        }
    }

    window.Atmosphere = { init, update };
})();