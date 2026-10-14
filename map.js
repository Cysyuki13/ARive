/* =========================================================================
   ARive — World Map  (map.js)
   ------------------------------------------------------------------------
   Extracted from game.js.  Owns:
     · top-right minimap       (always visible while playing)
     · full-screen world map   (M key)

   Reads live game state lazily via window.ARiveHooks, which game.js
   populates after all of its subsystems are wired up.

   Fog of war: game.js calls  Minimap.markExplored(cx, cz)  the first
   time each chunk column is generated.  Only those chunks get baked
   into the terrain cache; everything else stays black — including
   structure labels, which now hide until their chunk is discovered.

   The map draws as an "infinite" field: no world border rectangle,
   no clamp on pan other than keeping the world edge on screen, pure
   black everywhere that hasn't been explored.
   ========================================================================= */
(function () {
    'use strict';

    /* ---- lazy accessor for game state ---- */
    function H() { return window.ARiveHooks || {}; }

    /* ---- tunables ---- */
    const MINIMAP_SIZE = 180;          // on-screen px
    const MINIMAP_RANGE_VOX = 180;     // half-width in voxels
    const BIGMAP_MIN_ZOOM = 1;
    const BIGMAP_MAX_ZOOM = 12;
    const PAN_KEEP_PX = 24;            // how many px of world must stay visible

    /* ---- state ---- */
    let minimapCanvas = null, minimapCtx = null;
    let bigmapCanvas = null, bigmapCtx = null, bigmapWrap = null;
    let terrainCache = null;           // SX × SZ offscreen canvas
    let bigmapOpen = false;

    /* ---- zoom / pan ---- */
    let bigZoom = 1;
    let bigPanX = 0, bigPanY = 0;
    let spaceHeld = false;
    let dragActive = false;
    let dragLastX = 0, dragLastY = 0;

    /* ---- fog of war ---- */
    const exploredChunks = new Set();

    /* =====================================================================
       TERRAIN CACHE
       ===================================================================== */
    function initTerrainCache() {
        if (terrainCache) return;
        const SX = H().SX, SZ = H().SZ;
        if (!SX || !SZ) return;
        terrainCache = document.createElement('canvas');
        terrainCache.width = SX;
        terrainCache.height = SZ;
        const ctx = terrainCache.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, SX, SZ);
    }

    function bakeChunk(cx, cz) {
        if (!terrainCache) return;
        const g = H();
        if (!g.getV || !g.BLOCKS || !g.CHUNK) return;

        const CHUNK = g.CHUNK, SX = g.SX, SY = g.SY, SZ = g.SZ;
        const x0 = cx * CHUNK, z0 = cz * CHUNK;
        if (x0 < 0 || z0 < 0 || x0 >= SX || z0 >= SZ) return;
        const x1 = Math.min(x0 + CHUNK, SX);
        const z1 = Math.min(z0 + CHUNK, SZ);
        const w = x1 - x0, h = z1 - z0;

        const ctx = terrainCache.getContext('2d');
        const img = ctx.createImageData(w, h);
        const d = img.data;

        for (let lz = 0; lz < h; lz++) {
            for (let lx = 0; lx < w; lx++) {
                const wx = x0 + lx, wz = z0 + lz;

                let topY = -1, topB = 0;
                for (let y = SY - 1; y >= 0; y--) {
                    const b = g.getV(wx, y, wz);
                    if (b !== 0) { topY = y; topB = b; break; }
                }

                const i = (lz * w + lx) * 4;

                if (topY < 0) {
                    /* empty column inside an explored chunk — deep void */
                    d[i] = 8; d[i + 1] = 8; d[i + 2] = 12; d[i + 3] = 255;
                    continue;
                }

                const def = g.BLOCKS[topB];
                const col = def ? def.color : 0xff00ff;
                const r = (col >> 16) & 255;
                const gg = (col >> 8) & 255;
                const b2 = col & 255;

                const shade = 0.55 + (topY / (SY - 1)) * 0.85;

                d[i] = Math.min(255, (r * shade) | 0);
                d[i + 1] = Math.min(255, (gg * shade) | 0);
                d[i + 2] = Math.min(255, (b2 * shade) | 0);
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, x0, z0);
    }

    /* Public-ish helper for the label pass. */
    function chunkExplored(worldVx, worldVz) {
        const CHUNK = H().CHUNK || 32;
        const cx = Math.floor(worldVx / CHUNK);
        const cz = Math.floor(worldVz / CHUNK);
        return exploredChunks.has(cx + ',' + cz);
    }

    /* =====================================================================
       MINIMAP  (top-right corner)
       ===================================================================== */
    function initMinimap() {
        if (minimapCanvas) return;
        minimapCanvas = document.createElement('canvas');
        minimapCanvas.id = 'minimap';
        minimapCanvas.width = MINIMAP_SIZE;
        minimapCanvas.height = MINIMAP_SIZE;
        minimapCanvas.style.cssText =
            'position:fixed;top:14px;left:14px;' +
            'width:' + MINIMAP_SIZE + 'px;height:' + MINIMAP_SIZE + 'px;' +
            'z-index:7;pointer-events:none;opacity:0;transition:opacity .2s;' +
            'background:#000;border:2px solid #3a2e26;' +
            'box-shadow:0 0 0 2px #05070a,0 6px 20px rgba(0,0,0,.7);' +
            'image-rendering:pixelated;';
        document.body.appendChild(minimapCanvas);
        minimapCtx = minimapCanvas.getContext('2d');
    }

    function drawMinimap() {
        if (!terrainCache) return;
        const g = H();
        if (!g.player || !g.VOXEL) return;

        const W = MINIMAP_SIZE, Hc = MINIMAP_SIZE;
        const ctx = minimapCtx;
        const px = g.player.pos.x / g.VOXEL;
        const pz = g.player.pos.z / g.VOXEL;

        const srcX = px - MINIMAP_RANGE_VOX;
        const srcY = pz - MINIMAP_RANGE_VOX;
        const srcW = MINIMAP_RANGE_VOX * 2;
        const srcH = MINIMAP_RANGE_VOX * 2;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, Hc);
        ctx.imageSmoothingEnabled = false;

        const ix0 = Math.max(0, srcX);
        const iy0 = Math.max(0, srcY);
        const ix1 = Math.min(g.SX, srcX + srcW);
        const iy1 = Math.min(g.SZ, srcY + srcH);
        if (ix1 > ix0 && iy1 > iy0) {
            const sx = W / srcW;
            const sy = Hc / srcH;
            const dx = (ix0 - srcX) * sx;
            const dy = (iy0 - srcY) * sy;
            const dw = (ix1 - ix0) * sx;
            const dh = (iy1 - iy0) * sy;
            ctx.drawImage(terrainCache, ix0, iy0, ix1 - ix0, iy1 - iy0,
                dx, dy, dw, dh);
        }

        const pxToScr = W / srcW;
        const pzToScr = Hc / srcH;

        /* enemies — only draw if their chunk is explored */
        if (g.enemies) {
            for (const e of g.enemies) {
                if (!e.alive) continue;
                if (!chunkExplored(e.pos.x / g.VOXEL, e.pos.z / g.VOXEL)) continue;
                const ex = (e.pos.x / g.VOXEL - srcX) * pxToScr;
                const ez = (e.pos.z / g.VOXEL - srcY) * pzToScr;
                if (ex < 0 || ex > W || ez < 0 || ez > Hc) continue;
                ctx.fillStyle = '#e03030';
                ctx.beginPath(); ctx.arc(ex, ez, 2.5, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
            }
        }

        /* pickups */
        if (g.pickups) {
            for (const p of g.pickups) {
                if (p.carriedBy) continue;
                if (!chunkExplored(p.mesh.position.x / g.VOXEL,
                    p.mesh.position.z / g.VOXEL)) continue;
                const fx = (p.mesh.position.x / g.VOXEL - srcX) * pxToScr;
                const fz = (p.mesh.position.z / g.VOXEL - srcY) * pzToScr;
                if (fx < 0 || fx > W || fz < 0 || fz > Hc) continue;
                ctx.fillStyle = p.isFurniture ? '#7ad07a' : '#e8c86a';
                ctx.fillRect(fx - 1, fz - 1, 2, 2);
            }
        }

        /* player arrow */
        ctx.save();
        ctx.translate(W / 2, Hc / 2);
        ctx.rotate(-g.player.yaw);
        ctx.fillStyle = '#f6dd8b';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -7); ctx.lineTo(-5, 6);
        ctx.lineTo(0, 3); ctx.lineTo(5, 6);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();

        /* frame + compass */
        ctx.strokeStyle = '#e8c86a'; ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, W - 1, Hc - 1);

        ctx.font = 'bold 9px "Courier New",monospace';
        ctx.fillStyle = 'rgba(232,200,106,0.85)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('N', W / 2, 8);
        ctx.fillText('S', W / 2, Hc - 8);
        ctx.textAlign = 'left';
        ctx.fillText('E', W - 8, Hc / 2);
        ctx.textAlign = 'right';
        ctx.fillText('W', 8, Hc / 2);
    }

    /* =====================================================================
       BIGMAP  (full-screen, M key)
       ===================================================================== */
    function sizeBigmapCanvas() {
        if (!bigmapCanvas) return;
        const chromeH = 110;
        const chromeW = 60;
        const w = Math.max(480, Math.floor(window.innerWidth - chromeW));
        const h = Math.max(360, Math.floor(window.innerHeight - chromeH));
        bigmapCanvas.width = w;
        bigmapCanvas.height = h;
        bigmapCanvas.style.width = w + 'px';
        bigmapCanvas.style.height = h + 'px';
    }

    function initBigmap() {
        if (bigmapCanvas) return;

        bigmapWrap = document.createElement('div');
        bigmapWrap.id = 'bigmapWrap';
        bigmapWrap.style.cssText =
            'position:fixed;inset:0;z-index:45;display:none;' +
            'align-items:center;justify-content:center;' +
            'background:rgba(4,6,9,0.94);' +
            'font-family:"Courier New",monospace;';

        const panel = document.createElement('div');
        panel.style.cssText =
            'background:rgba(14,17,22,0.97);border:3px solid #3a2e26;' +
            'box-shadow:0 0 0 3px #05070a,0 22px 60px rgba(0,0,0,.75);' +
            'padding:10px 14px 12px;position:relative;' +
            'display:flex;flex-direction:column;align-items:center;';

        const title = document.createElement('div');
        title.textContent = '◈ WORLD MAP ◈';
        title.style.cssText =
            'font-size:24px;letter-spacing:8px;color:#e8c86a;text-align:center;' +
            'margin-bottom:8px;text-shadow:3px 3px 0 #0c1119;font-weight:bold;';
        panel.appendChild(title);

        bigmapCanvas = document.createElement('canvas');
        bigmapCanvas.style.cssText =
            'display:block;background:#000;border:2px solid #232b36;' +
            'image-rendering:pixelated;cursor:grab;touch-action:none;';
        panel.appendChild(bigmapCanvas);
        bigmapCtx = bigmapCanvas.getContext('2d');
        sizeBigmapCanvas();

        const hint = document.createElement('div');
        hint.innerHTML =
            '<b style="color:#e8c86a">WHEEL</b> zoom&nbsp;·&nbsp;' +
            '<b style="color:#e8c86a">HOLD LMB</b> + drag to pan&nbsp;·&nbsp;' +
            '<b style="color:#e8c86a">R</b> reset&nbsp;·&nbsp;' +
            '<b style="color:#e8c86a">M</b> / <b style="color:#e8c86a">ESC</b> close';
        hint.style.cssText =
            'text-align:center;margin-top:10px;font-size:14px;' +
            'letter-spacing:2px;color:#a89a84;';
        panel.appendChild(hint);

        bigmapWrap.appendChild(panel);
        document.body.appendChild(bigmapWrap);

        /* ---------- wheel = zoom (anchored on cursor) ---------- */
        bigmapCanvas.addEventListener('wheel', (e) => {
            if (!bigmapOpen) return;
            e.preventDefault();

            const g = H();
            const SX = g.SX, SZ = g.SZ;
            const W = bigmapCanvas.width, Hc = bigmapCanvas.height;

            const rect = bigmapCanvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / rect.width * W;
            const my = (e.clientY - rect.top) / rect.height * Hc;

            const fitBase = Math.min(W / SX, Hc / SZ);
            const fitOld = fitBase * bigZoom;
            const offXOld = (W - SX * fitOld) * 0.5 + bigPanX;
            const offYOld = (Hc - SZ * fitOld) * 0.5 + bigPanY;

            const wx = (mx - offXOld) / fitOld;
            const wz = (my - offYOld) / fitOld;

            const factor = e.deltaY > 0 ? 0.85 : 1.18;
            const newZoom = Math.max(BIGMAP_MIN_ZOOM,
                Math.min(BIGMAP_MAX_ZOOM, bigZoom * factor));
            if (newZoom === bigZoom) return;
            bigZoom = newZoom;

            const fitNew = fitBase * bigZoom;
            bigPanX = mx - wx * fitNew - (W - SX * fitNew) * 0.5;
            bigPanY = my - wz * fitNew - (Hc - SZ * fitNew) * 0.5;
            clampPan();
            drawBigmap();
        }, { passive: false });

        /* ---------- space + drag = pan ---------- */
        /* ---------- hold left click = pan ---------- */
        bigmapCanvas.addEventListener('mousedown', (e) => {
            if (!bigmapOpen) return;
            if (e.button === 0) {          // LMB only
                e.preventDefault();
                dragActive = true;
                dragLastX = e.clientX;
                dragLastY = e.clientY;
                bigmapCanvas.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (!bigmapOpen || !dragActive) return;
            const rect = bigmapCanvas.getBoundingClientRect();
            const sf = bigmapCanvas.width / rect.width;
            bigPanX += (e.clientX - dragLastX) * sf;
            bigPanY += (e.clientY - dragLastY) * sf;
            dragLastX = e.clientX;
            dragLastY = e.clientY;
            clampPan();
            drawBigmap();
        });

        window.addEventListener('mouseup', () => {
            if (dragActive) {
                dragActive = false;
                if (bigmapCanvas) bigmapCanvas.style.cursor = 'grab';
            }
        });

        bigmapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        window.addEventListener('resize', () => {
            if (!bigmapCanvas) return;
            sizeBigmapCanvas();
            if (bigmapOpen) drawBigmap();
        });
    }

    /* Loose clamp: keep at least PAN_KEEP_PX pixels of the world rect
       visible so the player can't lose the map entirely.  The world is
       treated as an island floating in an infinite black sea. */
    function clampPan() {
        const g = H();
        if (!bigmapCanvas || !g.SX) return;
        const W = bigmapCanvas.width, Hc = bigmapCanvas.height;
        const SX = g.SX, SZ = g.SZ;
        const fitBase = Math.min(W / SX, Hc / SZ);
        const fit = fitBase * bigZoom;
        const drawW = SX * fit;
        const drawH = SZ * fit;

        const wLeft = (W - drawW) * 0.5 + bigPanX;
        const wRight = wLeft + drawW;
        const wTop = (Hc - drawH) * 0.5 + bigPanY;
        const wBot = wTop + drawH;

        const KEEP = PAN_KEEP_PX;
        if (wLeft > W - KEEP) bigPanX -= wLeft - (W - KEEP);
        if (wRight < KEEP) bigPanX += KEEP - wRight;
        if (wTop > Hc - KEEP) bigPanY -= wTop - (Hc - KEEP);
        if (wBot < KEEP) bigPanY += KEEP - wBot;
    }

    function drawBigmap() {
        if (!terrainCache) return;
        const g = H();
        if (!g.SX) return;

        const W = bigmapCanvas.width, Hc = bigmapCanvas.height;
        const ctx = bigmapCtx;
        const SX = g.SX, SZ = g.SZ;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        /* Deep void — anything not covered by the terrain cache reads as
           "outside the known world". */
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, Hc);
        ctx.imageSmoothingEnabled = false;

        const fitBase = Math.min(W / SX, Hc / SZ);
        const fit = fitBase * bigZoom;
        const drawW = SX * fit;
        const drawH = SZ * fit;
        const offX = (W - drawW) * 0.5 + bigPanX;
        const offY = (Hc - drawH) * 0.5 + bigPanY;

        ctx.drawImage(terrainCache, 0, 0, SX, SZ, offX, offY, drawW, drawH);

        /* enemies — hidden until their chunk is explored */
        if (g.enemies) {
            for (const e of g.enemies) {
                if (!e.alive) continue;
                const evx = e.pos.x / g.VOXEL, evz = e.pos.z / g.VOXEL;
                if (!chunkExplored(evx, evz)) continue;
                const ex = offX + evx * fit;
                const ez = offY + evz * fit;
                if (ex < 0 || ex > W || ez < 0 || ez > Hc) continue;
                ctx.fillStyle = '#e03030';
                ctx.beginPath(); ctx.arc(ex, ez, 6, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
            }
        }

        /* pickups — same fog-of-war rule */
        if (g.pickups) {
            for (const p of g.pickups) {
                if (p.carriedBy) continue;
                const pvx = p.mesh.position.x / g.VOXEL;
                const pvz = p.mesh.position.z / g.VOXEL;
                if (!chunkExplored(pvx, pvz)) continue;
                const fx = offX + pvx * fit;
                const fz = offY + pvz * fit;
                if (fx < 0 || fx > W || fz < 0 || fz > Hc) continue;
                ctx.fillStyle = p.isFurniture ? '#7ad07a' : '#e8c86a';
                ctx.fillRect(fx - 2.5, fz - 2.5, 5, 5);
            }
        }

        /* ---------- Structure labels — FOG OF WAR ----------
           Only draw a label if the plot's CENTER chunk is in the
           explored set.  Previously every plot drew its name from
           world-gen, which leaked unfinished/unseen POIs onto the
           map. */
        const layout = g.getCityLayout && g.getCityLayout();
        if (layout && layout.plots) {
            ctx.font = 'bold 17px "Courier New",monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (const p of layout.plots) {
                /* Chunk lookup from the plot's mid-point. */
                const midVx = p.x + p.w * 0.5;
                const midVz = p.z + p.d * 0.5;
                if (!chunkExplored(midVx, midVz)) continue;

                const pw = p.w * fit, pd = p.d * fit;
                if (pw < 48 || pd < 26) continue;
                const sx = offX + p.x * fit, sz = offY + p.z * fit;
                if (sx + pw < 0 || sx > W) continue;
                if (sz + pd < 0 || sz > Hc) continue;

                const cx = offX + (p.x + p.w / 2) * fit;
                const cy = offY + (p.z + p.d / 2) * fit;
                let label = (p.struct && p.struct.name) ? p.struct.name : '·';
                if (label.length > 16) label = label.slice(0, 15) + '…';

                const tm = ctx.measureText(label);
                const tw = tm.width + 18, th = 26;
                ctx.fillStyle = 'rgba(6,8,12,0.88)';
                ctx.fillRect(cx - tw / 2, cy - th / 2, tw, th);
                ctx.strokeStyle = p.struct ? '#e8c86a' : '#5a4a3a';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(cx - tw / 2 + 0.5, cy - th / 2 + 0.5,
                    tw - 1, th - 1);
                ctx.fillStyle = p.struct ? '#f6dd8b' : '#b0a090';
                ctx.fillText(label, cx, cy);
            }
        }

        /* player arrow */
        if (g.player) {
            const ppx = offX + (g.player.pos.x / g.VOXEL) * fit;
            const ppz = offY + (g.player.pos.z / g.VOXEL) * fit;
            ctx.save();
            ctx.translate(ppx, ppz);
            ctx.rotate(-g.player.yaw);
            ctx.fillStyle = '#f6dd8b';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, -14); ctx.lineTo(-10, 11);
            ctx.lineTo(0, 6); ctx.lineTo(10, 11);
            ctx.closePath(); ctx.fill(); ctx.stroke();
            ctx.restore();
        }

        /* NOTE: no world border rectangle — the map reads as infinite. */

        /* compass pinned to the CANVAS edges (not the world rect),
           so it stays put regardless of zoom/pan. */
        ctx.font = 'bold 22px "Courier New",monospace';
        ctx.fillStyle = 'rgba(232,200,106,0.55)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('N', W / 2, 18);
        ctx.fillText('S', W / 2, Hc - 18);
        ctx.textAlign = 'left';
        ctx.fillText('E', W - 22, Hc / 2);
        ctx.textAlign = 'right';
        ctx.fillText('W', 22, Hc / 2);

        /* zoom indicator, top-left of the canvas */
        ctx.font = 'bold 15px "Courier New",monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = '#a89a84';
        ctx.fillText('ZOOM ' + bigZoom.toFixed(1) + '×', 14, 12);
    }

    /* =====================================================================
       OPEN / CLOSE / TOGGLE
       ===================================================================== */
    function openBigmap() {
        if (bigmapOpen) return;
        const g = H();
        if (!g.getGameRunning || !g.getGameRunning()) return;
        if (!g.player || !g.player.alive) return;
        const inv = g.getInventory && g.getInventory();
        if (inv && inv.isOpen) return;
        if (g.getDevMenuActive && g.getDevMenuActive()) return;

        bigmapOpen = true;
        bigmapWrap.style.display = 'flex';
        bigZoom = 1;
        bigPanX = 0; bigPanY = 0;

        sizeBigmapCanvas();

        if (document.pointerLockElement) {
            try { document.exitPointerLock(); } catch (e) { }
        }
        drawBigmap();
    }

    function closeBigmap(suppressPause) {
        if (!bigmapOpen) return;
        bigmapOpen = false;
        bigmapWrap.style.display = 'none';
        spaceHeld = false;
        dragActive = false;

        const g = H();

        /* When the map was closed with ESC, the browser may fire its own
           pointer-unlock handling in the next tick.  Suppress the pause
           menu for the next ~1.5 s so the game doesn't flash the overlay. */
        if (suppressPause && g.suppressNextPause) g.suppressNextPause();

        /* Hand re-locking to game.js, which knows to retry past Chrome's
           ~1 s post-exit pointer-lock cooldown. */
        if (g.requestPointerLock) {
            g.requestPointerLock();
        }
    }

    /* =====================================================================
       PUBLIC API
       ===================================================================== */
    window.Minimap = {
        update: function () {
            initMinimap();
            initBigmap();

            if (bigmapOpen) {
                drawBigmap();
                if (minimapCanvas) minimapCanvas.style.opacity = '0';
                return;
            }

            const g = H();
            const vis = g.getGameRunning && g.getGameRunning()
                && g.player && g.player.alive
                && !(g.getInventory && g.getInventory().isOpen)
                && !(g.getDevMenuActive && g.getDevMenuActive());
            if (minimapCanvas) minimapCanvas.style.opacity = vis ? '1' : '0';
            if (vis) drawMinimap();
        },

        buildTerrainCache: function () {
            initMinimap();
            initBigmap();
            terrainCache = null;
            initTerrainCache();
            for (const key of exploredChunks) {
                const parts = key.split(',');
                bakeChunk(+parts[0], +parts[1]);
            }
        },

        markExplored: function (cx, cz) {
            const key = cx + ',' + cz;
            if (exploredChunks.has(key)) return;
            exploredChunks.add(key);
            if (terrainCache) bakeChunk(cx, cz);
        },

        /* Expose for game.js / debug tools. */
        isExplored: function (cx, cz) {
            return exploredChunks.has(cx + ',' + cz);
        },

        reset: function () {
            exploredChunks.clear();
            terrainCache = null;
        },

        toggle: function () { bigmapOpen ? closeBigmap() : openBigmap(); },
        close: closeBigmap,
        isOpen: function () { return bigmapOpen; },
    };

    /* =====================================================================
       KEY HANDLERS
       ===================================================================== */
    window.addEventListener('keydown', (e) => {
        if (!bigmapOpen) return;
        if (e.code === 'KeyR') {
            e.preventDefault();
            bigZoom = 1;
            bigPanX = 0; bigPanY = 0;
            drawBigmap();
        } else if (e.code === 'Escape') {
            e.preventDefault();
            closeBigmap(true);
        }
    });

    window.addEventListener('blur', () => {
        spaceHeld = false;
        dragActive = false;
    });

})();