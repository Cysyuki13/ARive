/* =========================================================================
   ARive — Sandbox Spawn Menu (GMod-style)
   -------------------------------------------------------------------------
   Full-screen spawn menu for the sandbox map.  Press G to open.  Browse
   categories on the left, click a card to spawn that entity at the
   crosshair.

   Categories:
     · WEAPONS      — every weapon in WEAPON_MODEL_DATA (+ per-skin variants)
     · AMMO         — 9mm / 5.56 / shell
     · ITEMS        — non-furniture items from ITEM_DEFS
     · FURNITURE    — every editor-authored furniture piece
     · ZOMBIES      — every zombie type from Enemies.types
     · BLOCKS       — every block type in BLOCKS
     · STRUCTURES   — building presets (wall, pillar, house, stairs, …)

   Exposes window.SandboxMenu.  game.js calls SandboxMenu.init() once
   after boot, and SandboxMenu.toggle() on the G key.
   ========================================================================= */
(function () {
    "use strict";

    /* =====================================================================
       Config
       ===================================================================== */
    const CATEGORY_DEFS = [
        { id: "weapons", name: "WEAPONS", icon: "▸" },
        { id: "ammo", name: "AMMO", icon: "▮" },
        { id: "items", name: "ITEMS", icon: "◆" },
        { id: "furniture", name: "FURNITURE", icon: "▤" },
        { id: "zombies", name: "ZOMBIES", icon: "☠" },
        { id: "blocks", name: "BLOCKS", icon: "■" },
        { id: "structures", name: "STRUCTURES", icon: "⌂" },
        { id: "toggles", name: "SANDBOX", icon: "⚙" },
    ];

    /* =====================================================================
       State
       ===================================================================== */
    let isOpen = false;
    let currentCat = "weapons";
    let searchQuery = "";
    let initialized = false;
    let cardsBuilt = false;
    let zombieIconCache = null;
    let allCards = [];
    let catCounts = {};

    /* =====================================================================
       DOM refs (populated on init)
       ===================================================================== */
    let rootEl = null;
    let sidebarEl = null;
    let gridEl = null;
    let searchEl = null;
    let statusEl = null;

    function H() { return window.ARiveHooks || {}; }

    /* =====================================================================
       CSS injection — one <style> tag, dark + gold ARive palette
       ===================================================================== */
    function injectStyles() {
        if (document.getElementById("sbmStyles")) return;
        const style = document.createElement("style");
        style.id = "sbmStyles";
        style.textContent = `
      #sbmRoot {
        position: fixed; inset: 0; z-index: 60;
        background: rgba(6, 8, 12, 0.78);
        display: none;
        font-family: "Courier New", monospace;
        color: #e8c86a;
        user-select: none;
      }
      #sbmRoot.open { display: flex; }

      #sbmWindow {
        position: absolute; inset: 4vh 4vw;
        background: #0d1016;
        border: 2px solid #e8c86a;
        box-shadow: 0 0 40px rgba(232,200,106,0.18),
                    inset 0 0 0 1px #05070a;
        display: flex; flex-direction: column;
        overflow: hidden;
      }

      .sbm-header {
        flex: 0 0 auto;
        display: flex; align-items: center; gap: 12px;
        padding: 10px 14px;
        background: #12161d;
        border-bottom: 2px solid #2b333f;
      }
      .sbm-title {
        font: bold 14px "Courier New", monospace;
        letter-spacing: 3px; color: #e8c86a;
        text-shadow: 0 0 8px rgba(232,200,106,0.4);
        white-space: nowrap;
      }
      #sbmSearch {
        flex: 1 1 auto;
        background: #05070a;
        border: 2px solid #2b333f;
        color: #e8c86a;
        font: bold 12px "Courier New", monospace;
        padding: 6px 10px;
        letter-spacing: 1px;
        outline: none;
      }
      #sbmSearch:focus { border-color: #e8c86a; }
      #sbmSearch::placeholder { color: #6a5a44; }

      .sbm-close {
        background: transparent;
        border: 2px solid #6a5a44;
        color: #e8c86a;
        font: bold 12px "Courier New", monospace;
        padding: 6px 12px;
        cursor: pointer;
        letter-spacing: 1px;
      }
      .sbm-close:hover { background: #e8c86a; color: #0d1016; }

      .sbm-body { flex: 1 1 auto; display: flex; min-height: 0; }

      .sbm-sidebar {
        flex: 0 0 170px;
        background: #0a0d12;
        border-right: 2px solid #2b333f;
        overflow-y: auto;
        padding: 8px 0;
      }
      .sbm-cat {
        display: flex; align-items: center; gap: 8px;
        width: 100%;
        background: transparent; border: none;
        color: #a89a84;
        font: bold 11px "Courier New", monospace;
        letter-spacing: 2px;
        padding: 10px 14px;
        cursor: pointer;
        text-align: left;
        border-left: 3px solid transparent;
      }
      .sbm-cat:hover { background: #12161d; color: #e8c86a; }
      .sbm-cat.active {
        background: #12161d;
        color: #e8c86a;
        border-left-color: #e8c86a;
      }
      .sbm-cat .sbm-cat-count {
        margin-left: auto;
        font-size: 9px;
        color: #6a5a44;
      }
      .sbm-cat.active .sbm-cat-count { color: #e8c86a; }

      .sbm-grid {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 14px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px;
        align-content: start;
      }

      .sbm-card {
        background: #12161d;
        border: 2px solid #2b333f;
        cursor: pointer;
        display: flex; flex-direction: column;
        transition: border-color .1s, transform .08s, box-shadow .12s;
        overflow: hidden;
        position: relative;
      }
      .sbm-card:hover {
        border-color: #e8c86a;
        box-shadow: 0 0 12px rgba(232,200,106,0.35);
        transform: translateY(-1px);
      }
      .sbm-card:active { transform: translateY(0); }

      .sbm-card-icon {
        width: 100%; aspect-ratio: 1;
        background: #05070a;
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
        position: relative;
      }
      .sbm-card-icon img {
        width: 100%; height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
      }
      .sbm-card-icon .sbm-color-swatch {
        width: 100%; height: 100%;
      }
      .sbm-card-icon .sbm-fallback {
        font: bold 28px "Courier New", monospace;
        color: #e8c86a;
        opacity: 0.7;
      }

      .sbm-card-name {
        padding: 5px 6px 6px;
        font: bold 10px "Courier New", monospace;
        letter-spacing: 1px;
        color: #c8b88a;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border-top: 1px solid #1a1f26;
        background: #0e1218;
      }
      .sbm-card:hover .sbm-card-name { color: #f6dd8b; }

      .sbm-card-tag {
        position: absolute; top: 4px; left: 4px;
        font: bold 8px "Courier New", monospace;
        letter-spacing: 1px;
        background: rgba(0,0,0,0.7);
        color: #e8c86a;
        padding: 1px 4px;
        border: 1px solid #6a5a44;
        pointer-events: none;
      }

      .sbm-footer {
        flex: 0 0 auto;
        background: #12161d;
        border-top: 2px solid #2b333f;
        padding: 8px 14px;
        font: bold 10px "Courier New", monospace;
        letter-spacing: 2px;
        color: #7a6e5e;
        display: flex; justify-content: space-between;
        align-items: center;
      }
      .sbm-footer .sbm-status { color: #e8c86a; }
      .sbm-footer .sbm-hint { color: #6a5a44; }

      .sbm-empty {
        grid-column: 1 / -1;
        text-align: center;
        padding: 60px 20px;
        color: #6a5a44;
        font: bold 13px "Courier New", monospace;
        letter-spacing: 2px;
      }

      .sbm-grid::-webkit-scrollbar,
      .sbm-sidebar::-webkit-scrollbar { width: 8px; }
      .sbm-grid::-webkit-scrollbar-track,
      .sbm-sidebar::-webkit-scrollbar-track { background: #05070a; }
      .sbm-grid::-webkit-scrollbar-thumb,
      .sbm-sidebar::-webkit-scrollbar-thumb {
        background: #2b333f; border: 2px solid #05070a;
      }
      .sbm-grid::-webkit-scrollbar-thumb:hover,
      .sbm-sidebar::-webkit-scrollbar-thumb:hover { background: #e8c86a; }
    `;
        document.head.appendChild(style);
    }

    /* =====================================================================
       Zombie icon — 2D front-view silhouette drawn from the voxel data
       ===================================================================== */
    function renderZombieIcon(type, size) {
        size = size || 96;
        const types = (window.Enemies && window.Enemies.types) || null;
        if (!types || !types[type]) return null;

        const model = types[type];
        const cv = document.createElement("canvas");
        cv.width = size; cv.height = size;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        ctx.fillStyle = "#05070a";
        ctx.fillRect(0, 0, size, size);

        /* Flatten every part's voxels into one list, offset by its pivot. */
        const all = [];
        for (const key in model.parts) {
            const part = model.parts[key];
            const p = part.pivot || [0, 0, 0];
            for (const v of part.voxels) {
                all.push([v[0] + p[0], v[1] + p[1], v[2] + p[2], v[3]]);
            }
        }
        if (!all.length) return cv.toDataURL("image/png");

        let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
        for (const v of all) {
            if (v[0] < mnX) mnX = v[0];
            if (v[0] > mxX) mxX = v[0];
            if (v[1] < mnY) mnY = v[1];
            if (v[1] > mxY) mxY = v[1];
        }
        const w = mxX - mnX + 1;
        const h = mxY - mnY + 1;
        const pad = 6;
        const scale = (size - pad * 2) / Math.max(w, h);
        const offX = (size - w * scale) * 0.5;
        const offY = (size - h * scale) * 0.5;

        /* Back-to-front so nearer voxels overwrite farther ones. */
        all.sort((a, b) => a[2] - b[2]);

        for (const v of all) {
            const px = offX + (v[0] - mnX) * scale;
            const py = offY + (mxY - v[1]) * scale;
            const hex = v[3];
            const r = (hex >> 16) & 255;
            const g = (hex >> 8) & 255;
            const b = hex & 255;
            const shade = v[2] < 0 ? 0.82 : 1.0;
            ctx.fillStyle = "rgb(" +
                Math.floor(r * shade) + "," +
                Math.floor(g * shade) + "," +
                Math.floor(b * shade) + ")";
            ctx.fillRect(px, py, scale + 0.4, scale + 0.4);
        }
        return cv.toDataURL("image/png");
    }

    function getZombieIcons() {
        if (zombieIconCache) return zombieIconCache;
        zombieIconCache = {};
        const types = (window.Enemies && window.Enemies.types) || null;
        if (!types) return zombieIconCache;
        for (const key in types) {
            try { zombieIconCache[key] = renderZombieIcon(key, 96); }
            catch (e) { console.warn("[SandboxMenu] zombie icon failed:", key, e); }
        }
        return zombieIconCache;
    }

    /* =====================================================================
       Card catalogue — one card = one spawnable entity
       ===================================================================== */
    function buildWeaponCards() {
        const defs = window.WEAPON_MODEL_DATA || [];
        const cards = [];
        for (const def of defs) {
            if (!def || !def.key) continue;
            if (window.WeaponSkins && window.WeaponSkins.isSkinSource(def.key)) continue;

            cards.push({
                id: "w_" + def.key,
                name: def.name || def.key,
                category: "weapons",
                iconUrl: def.iconImage || def.iconImageRotated,
                fallbackIcon: "▸",
                tag: (def.w || "?") + "×" + (def.h || "?"),
                data: { kind: "weapon", def, skinId: null },
            });

            if (window.WeaponSkins) {
                const skins = window.WeaponSkins.getSkins(def.key);
                for (const skin of skins) {
                    if (skin.id === "default" && !skin.model) continue;
                    let skinned = null;
                    try { skinned = window.WeaponSkins.applySkin(def, skin.id); }
                    catch (e) { continue; }
                    if (!skinned || skinned === def) continue;
                    cards.push({
                        id: "w_" + def.key + "@" + skin.id,
                        name: skin.name || (def.name + " · " + skin.id),
                        category: "weapons",
                        iconUrl: skinned.iconImage || skinned.iconImageRotated,
                        fallbackIcon: "▸",
                        tag: "SKIN",
                        data: { kind: "weapon", def, skinId: skin.id },
                    });
                }
            }
        }
        return cards;
    }

    function buildAmmoCards() {
        const byType = H().AMMO_BY_TYPE || {};
        const cards = [];
        for (const type in byType) {
            const a = byType[type];
            cards.push({
                id: "am_" + type,
                name: a.name || type,
                category: "ammo",
                iconUrl: a.iconImage || a.iconImageRotated,
                fallbackIcon: "▮",
                iconColor: a.color,
                data: { kind: "ammo", def: a },
            });
        }
        return cards;
    }

    function buildItemCards() {
        const defs = (H().getItemDefs && H().getItemDefs()) || [];
        const cards = [];
        const seen = new Set();
        for (const d of defs) {
            if (!d || !d.key || !d.name) continue;
            if (seen.has(d.key)) continue;
            seen.add(d.key);
            if (d.isAmmo || String(d.key).indexOf("ammo_") === 0) continue;
            if (d.size === "small" || d.size === "medium" || d.size === "large") continue;

            cards.push({
                id: "it_" + d.key,
                name: d.name,
                category: "items",
                iconUrl: d.iconImage || d.iconImageRotated,
                fallbackIcon: "◆",
                iconColor: d.color,
                data: { kind: "item", def: d },
            });
        }
        return cards;
    }

    function buildFurnitureCards() {
        const defs = (H().getFurnitureDefs && H().getFurnitureDefs()) || [];
        const cards = [];
        for (const d of defs) {
            if (!d || !d.key || !d.name) continue;
            cards.push({
                id: "fu_" + d.key,
                name: d.name,
                category: "furniture",
                iconUrl: d.iconImage || d.iconImageRotated,
                fallbackIcon: "▤",
                iconColor: d.color,
                tag: d.size || "—",
                data: { kind: "furniture", def: d },
            });
        }
        return cards;
    }

    function buildZombieCards() {
        const types = (window.Enemies && window.Enemies.types) || null;
        if (!types) return [];
        const icons = getZombieIcons();
        const cards = [];
        for (const key in types) {
            const m = types[key];
            cards.push({
                id: "zo_" + key,
                name: key.toUpperCase(),
                category: "zombies",
                iconUrl: icons[key],
                fallbackIcon: "☠",
                tag: "HP " + (m.hp != null ? m.hp : "?"),
                data: { kind: "zombie", type: key },
            });
        }
        return cards;
    }

    function buildBlockCards() {
        const blocks = H().BLOCKS || {};
        const cards = [];
        for (const id in blocks) {
            const b = blocks[id];
            if (!b || !b.color) continue;
            const hex = "#" + b.color.toString(16).padStart(6, "0");
            cards.push({
                id: "bl_" + id,
                name: b.name || ("BLOCK " + id),
                category: "blocks",
                iconUrl: null,
                fallbackIcon: null,
                iconColor: hex,
                tag: "S" + (b.strength || 1),
                data: { kind: "block", blockId: parseInt(id, 10), def: b },
            });
        }
        return cards;
    }

    const STRUCTURE_PRESETS = [
        { id: "cube_wood", name: "WOOD CUBE", iconColor: "#6a4824", preset: "cube-wood" },
        { id: "cube_conc", name: "CONC CUBE", iconColor: "#9a9a92", preset: "cube-concrete" },
        { id: "cube_metal", name: "METAL CUBE", iconColor: "#7a8088", preset: "cube-metal" },
        { id: "cube_glass", name: "GLASS CUBE", iconColor: "#7ab8cc", preset: "cube-glass" },
        { id: "wall", name: "WALL", iconColor: "#8c4637", preset: "wall" },
        { id: "pillar", name: "PILLAR", iconColor: "#7a8088", preset: "pillar" },
        { id: "house", name: "HOUSE", iconColor: "#9a9a92", preset: "house" },
        { id: "stairs", name: "STAIRS", iconColor: "#9a9a92", preset: "stairs" },
        { id: "barrel", name: "BARREL STACK", iconColor: "#b03024", preset: "barrel" },
        { id: "rubble", name: "RUBBLE PILE", iconColor: "#60564b", preset: "rubble" },
    ];

    /* ============================================================
   SANDBOX TOGGLES
   ------------------------------------------------------------
   These are "toggle" cards rather than "spawn" cards.  Clicking
   one flips a global flag in game.js / window.ARiveSandboxFlags
   and updates its own label in place.  The card never closes
   the menu, so you can flip several in a row.
   ============================================================ */
    function buildToggleCards() {
        const flags = window.ARiveSandboxFlags || {};
        const creativeOn =
            !!(H().getCreativeMode && H().getCreativeMode());

        return [
            {
                id: "tg_creative",
                name: "CREATIVE  ·  " + (creativeOn ? "ON" : "OFF"),
                category: "toggles",
                iconUrl: null,
                fallbackIcon: "✈",
                iconColor: creativeOn ? "#80ffb0" : "#4a5a6a",
                tag: "FLY + INVULN",
                data: { kind: "toggle", toggleId: "creative" },
            },
            {
                id: "tg_ammo",
                name: "∞ AMMO  ·  " + (flags.infiniteAmmo ? "ON" : "OFF"),
                category: "toggles",
                iconUrl: null,
                fallbackIcon: "∞",
                iconColor: flags.infiniteAmmo ? "#80ffb0" : "#4a5a6a",
                tag: "NO RELOAD",
                data: { kind: "toggle", toggleId: "ammo" },
            },
            {
                id: "tg_ehp",
                name: "∞ ENEMY HP  ·  " +
                    (flags.infiniteEnemyHealth ? "ON" : "OFF"),
                category: "toggles",
                iconUrl: null,
                fallbackIcon: "♥",
                iconColor: flags.infiniteEnemyHealth ? "#80ffb0" : "#4a5a6a",
                tag: "UNKILLABLE",
                data: { kind: "toggle", toggleId: "ehp" },
            },
            {
                id: "tg_eloop",
                name: "ENEMY LOOP  ·  " + (flags.enemyLoop ? "ON" : "OFF"),
                category: "toggles",
                iconUrl: null,
                fallbackIcon: "☠",
                iconColor: flags.enemyLoop ? "#80ffb0" : "#4a5a6a",
                tag: "SPAWN LOOP",
                data: { kind: "toggle", toggleId: "eloop" },
            },
        ];
    }

    function buildStructureCards() {
        return STRUCTURE_PRESETS.map(p => ({
            id: "st_" + p.id,
            name: p.name,
            category: "structures",
            iconUrl: null,
            fallbackIcon: "⌂",
            iconColor: p.iconColor,
            data: { kind: "structure", preset: p.preset },
        }));
    }

    function buildAllCards() {
        allCards = []
            .concat(buildWeaponCards())
            .concat(buildAmmoCards())
            .concat(buildItemCards())
            .concat(buildFurnitureCards())
            .concat(buildZombieCards())
            .concat(buildBlockCards())
            .concat(buildStructureCards())
            .concat(buildToggleCards());

        catCounts = {};
        for (const c of allCards) {
            catCounts[c.category] = (catCounts[c.category] || 0) + 1;
        }
    }

    /* =====================================================================
       Spawning — one dispatcher, one spawn hook per entity kind
       ===================================================================== */
    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }

    let spawnCard = function (card) {
        const Hk = H();
        const target = Hk.getCrosshairTarget && Hk.getCrosshairTarget();
        if (!target) {
            setStatus("✗  no surface in view — aim at something");
            return;
        }
        const d = card.data;

        if (d.kind === "weapon" && Hk.spawnWeaponAt) {
            Hk.spawnWeaponAt(target.x, target.y, target.z, d.def, d.skinId);
            setStatus("✓  " + card.name);
        } else if (d.kind === "ammo" && Hk.spawnAmmoAt) {
            Hk.spawnAmmoAt(target.x, target.y, target.z, d.def);
            setStatus("✓  " + card.name);
        } else if (d.kind === "item" && Hk.spawnItemAt) {
            Hk.spawnItemAt(target.x, target.y, target.z, d.def);
            setStatus("✓  " + card.name);
        } else if (d.kind === "furniture" && Hk.spawnFurnitureAt) {
            Hk.spawnFurnitureAt(target.x, target.y, target.z, d.def);
            setStatus("✓  " + card.name);
        } else if (d.kind === "zombie" && window.Enemies) {
            const gy = (Hk.getGroundYAtVoxel && Hk.getGroundYAtVoxel(target.vx, target.vz)) || 4;
            const MP = window.ARiveMP;
            if (MP && MP.connected && !MP.isHost && MP.requestEnemySpawn) {
                MP.requestEnemySpawn(d.type, target.x, gy, target.z);
                setStatus("✓  requested " + d.type.toUpperCase());
            } else {
                window.Enemies.spawn(d.type, { x: target.x, y: gy, z: target.z });
                setStatus("✓  " + d.type.toUpperCase());
            }
        } else if (d.kind === "block" && Hk.placeBlockAt) {
            Hk.placeBlockAt(target.vx, target.vy, target.vz, d.blockId);
            setStatus("✓  " + card.name);
        } else if (d.kind === "structure" && Hk.spawnStructurePresetAt) {
            Hk.spawnStructurePresetAt(target.vx, target.vy, target.vz, d.preset);
            setStatus("✓  " + card.name);
        } else {
            setStatus("✗  spawn failed");
        }
    }

    /* =====================================================================
       Rendering
       ===================================================================== */
    function makeCard(card) {
        const el = document.createElement("div");
        el.className = "sbm-card";
        card._el = el;                     // ← for toggle state colouring

        const iconEl = document.createElement("div");
        iconEl.className = "sbm-card-icon";

        if (card.iconUrl) {
            const img = document.createElement("img");
            img.src = card.iconUrl;
            img.alt = card.name;
            img.draggable = false;
            iconEl.appendChild(img);
        } else if (card.iconColor) {
            const sw = document.createElement("div");
            sw.className = "sbm-color-swatch";
            sw.style.background = card.iconColor;
            iconEl.appendChild(sw);
            if (card.fallbackIcon) {
                const glyph = document.createElement("div");
                glyph.className = "sbm-fallback";
                glyph.textContent = card.fallbackIcon;
                glyph.style.position = "absolute";
                glyph.style.textShadow = "0 0 6px rgba(0,0,0,0.9)";
                iconEl.appendChild(glyph);
            }
        } else {
            const glyph = document.createElement("div");
            glyph.className = "sbm-fallback";
            glyph.textContent = card.fallbackIcon || "?";
            iconEl.appendChild(glyph);
        }
        el.appendChild(iconEl);

        if (card.tag) {
            const tag = document.createElement("div");
            tag.className = "sbm-card-tag";
            tag.textContent = card.tag;
            el.appendChild(tag);
        }

        const nameEl = document.createElement("div");
        nameEl.className = "sbm-card-name";
        nameEl.textContent = card.name;
        nameEl.title = card.name;
        card._nameEl = nameEl;             // ← for in-place label updates
        el.appendChild(nameEl);

        el.addEventListener("click", (e) => { e.preventDefault(); spawnCard(card); });
        return el;
    }

    function renderGrid() {
        if (!gridEl) return;
        gridEl.innerHTML = "";

        const q = searchQuery.trim().toLowerCase();
        const visible = allCards.filter(c => {
            if (c.category !== currentCat) return false;
            if (!q) return true;
            return c.name.toLowerCase().indexOf(q) !== -1;
        });

        if (!visible.length) {
            const e = document.createElement("div");
            e.className = "sbm-empty";
            e.textContent = q
                ? 'no matches for "' + searchQuery + '"'
                : "nothing in this category";
            gridEl.appendChild(e);
            return;
        }
        for (const c of visible) gridEl.appendChild(makeCard(c));
    }

    function renderSidebar() {
        if (!sidebarEl) return;
        sidebarEl.innerHTML = "";
        for (const cat of CATEGORY_DEFS) {
            const btn = document.createElement("button");
            btn.className = "sbm-cat" + (cat.id === currentCat ? " active" : "");

            const icon = document.createElement("span");
            icon.textContent = cat.icon;
            icon.style.opacity = "0.8";
            btn.appendChild(icon);

            const nm = document.createElement("span");
            nm.textContent = cat.name;
            btn.appendChild(nm);

            const cnt = document.createElement("span");
            cnt.className = "sbm-cat-count";
            cnt.textContent = catCounts[cat.id] || 0;
            btn.appendChild(cnt);

            btn.addEventListener("click", () => {
                currentCat = cat.id;
                searchQuery = "";
                if (searchEl) searchEl.value = "";
                renderSidebar();
                renderGrid();
            });

            sidebarEl.appendChild(btn);
        }
    }

    /* =====================================================================
       Open / close
       ===================================================================== */
    function open() {
        if (isOpen) return;
        if (!initialized) init();

        if (!cardsBuilt) {
            buildAllCards();
            cardsBuilt = true;
        }

        renderSidebar();
        renderGrid();

        rootEl.classList.add("open");
        isOpen = true;
        setStatus("");

        /* Release the pointer so the player can click */
        if (document.pointerLockElement) {
            try { document.exitPointerLock(); } catch (e) { }
        }

        if (searchEl) {
            searchEl.value = "";
            searchQuery = "";
            setTimeout(() => { try { searchEl.focus(); } catch (e) { } }, 30);
        }
    }

    function close() {
        if (!isOpen) return;
        rootEl.classList.remove("open");
        isOpen = false;

        /* Tell game.js not to interpret this unlock as a pause request. */
        const Hk = H();
        if (Hk.suppressNextPause) Hk.suppressNextPause();

        if (placing) return;

        if (Hk.requestPointerLock) Hk.requestPointerLock();
    }

    function toggle() { isOpen ? close() : open(); }

    /* =====================================================================
       Init
       ===================================================================== */
    function init() {
        if (initialized) return;
        initialized = true;

        injectStyles();

        rootEl = document.createElement("div");
        rootEl.id = "sbmRoot";
        document.body.appendChild(rootEl);

        const win = document.createElement("div");
        win.id = "sbmWindow";
        rootEl.appendChild(win);

        /* Header */
        const header = document.createElement("div");
        header.className = "sbm-header";
        win.appendChild(header);

        const title = document.createElement("span");
        title.className = "sbm-title";
        title.textContent = "◈ SANDBOX SPAWNER";
        header.appendChild(title);

        searchEl = document.createElement("input");
        searchEl.id = "sbmSearch";
        searchEl.type = "text";
        searchEl.placeholder = "search…";
        searchEl.addEventListener("input", () => {
            searchQuery = searchEl.value;
            renderGrid();
        });
        header.appendChild(searchEl);

        const closeBtn = document.createElement("button");
        closeBtn.className = "sbm-close";
        closeBtn.textContent = "✕ CLOSE";
        closeBtn.addEventListener("click", close);
        header.appendChild(closeBtn);

        /* Body */
        const body = document.createElement("div");
        body.className = "sbm-body";
        win.appendChild(body);

        sidebarEl = document.createElement("div");
        sidebarEl.className = "sbm-sidebar";
        body.appendChild(sidebarEl);

        gridEl = document.createElement("div");
        gridEl.className = "sbm-grid";
        body.appendChild(gridEl);

        /* Footer */
        const footer = document.createElement("div");
        footer.className = "sbm-footer";
        win.appendChild(footer);

        statusEl = document.createElement("span");
        statusEl.className = "sbm-status";
        footer.appendChild(statusEl);

        const hint = document.createElement("span");
        hint.className = "sbm-hint";
        hint.textContent = "CLICK A CARD TO SPAWN AT CROSSHAIR   ·   G / ESC TO CLOSE";
        footer.appendChild(hint);

        /* Backdrop click closes */
        rootEl.addEventListener("mousedown", (e) => { if (e.target === rootEl) close(); });

        /* Escape closes */
        rootEl.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { e.preventDefault(); close(); }
        });

        buildAllCards();
        cardsBuilt = true;
        renderSidebar();
        renderGrid();
    }

    /* =====================================================================
   GHOST PREVIEW + PLACEMENT
   ---------------------------------------------------------------------
   Picking a card does NOT spawn immediately any more — it closes the
   menu and enters "placement mode": a translucent ghost follows the
   crosshair, and clicking places the real thing.

     · LMB             → commit the spawn at the current target
     · RMB / ESC / Q    → cancel placement
     · G                → cancel placement and re-open the menu

   Every card carries a `data.kind` — the placement module re-uses the
   same spawnCard() dispatcher at commit time, so nothing about the
   spawn logic changes: we just delay it.
   ===================================================================== */
    let placing = null;      // { card, ghost, ready } or null
    let placeCanvas = null;

    /* Darken a 24-bit hex so the ghost reads as a translucent hologram
       of the real model, regardless of the source colour. */
    function _ghostColor(hex, mul) {
        mul = mul == null ? 0.55 : mul;
        const r = Math.floor(((hex >> 16) & 255) * mul);
        const g = Math.floor(((hex >> 8) & 255) * mul);
        const b = Math.floor((hex & 255) * mul);
        return (r << 16) | (g << 8) | b;
    }

    function buildGhostMesh(card) {
        const Hk = H();
        const THREE = Hk.THREE;
        if (!THREE) return null;

        const ghostMat = new THREE.MeshBasicMaterial({
            color: 0x80ffcc,
            transparent: true,
            opacity: 0.42,
            depthWrite: false,
            fog: false,
        });
        const group = new THREE.Group();

        const d = card.data;

        /* ---- WEAPON / ITEM / AMMO / FURNITURE — box model from def.model */
        if (d.kind === "weapon" || d.kind === "item" ||
            d.kind === "ammo" || d.kind === "furniture") {
            const def = d.def;
            const model = Array.isArray(def.model) ? def.model
                : (def.meta && Array.isArray(def.meta.model)) ? def.meta.model
                    : null;
            if (model) {
                for (const b of model) {
                    const geo = new THREE.BoxGeometry(b.s[0], b.s[1], b.s[2]);
                    const m = new THREE.Mesh(geo, ghostMat);
                    m.position.set(b.p[0], b.p[1], b.p[2]);
                    if (b.r) m.rotation.set(b.r[0], b.r[1], b.r[2]);
                    group.add(m);
                }
            }
        }

        /* ---- BLOCK — single cube at 1 voxel */
        if (d.kind === "block" && Hk.VOXEL) {
            const v = Hk.VOXEL;
            const geo = new THREE.BoxGeometry(v, v, v);
            const m = new THREE.Mesh(geo, ghostMat);
            m.position.set(0, v * 0.5, 0);
            group.add(m);
        }

        /* ---- STRUCTURE — outline box sized to the preset footprint */
        if (d.kind === "structure") {
            let w = 1, h = 1, dep = 1;
            const p = d.preset;
            const presets = {
                "cube-wood": [6, 6, 6],
                "cube-concrete": [6, 6, 6],
                "cube-metal": [6, 6, 6],
                "cube-glass": [6, 6, 6],
                "wall": [2, 8, 16],
                "pillar": [3, 16, 3],
                "house": [14, 11, 14],
                "stairs": [8, 8, 16],
                "barrel": [3, 4, 3],
                "rubble": [6, 4, 6],
            };
            if (presets[p]) { w = presets[p][0]; h = presets[p][1]; dep = presets[p][2]; }
            const V = Hk.VOXEL || 0.1;
            const geo = new THREE.BoxGeometry(w * V, h * V, dep * V);
            const m = new THREE.Mesh(geo, ghostMat);
            m.position.set(0, h * V * 0.5, 0);
            group.add(m);
        }

        /* ---- ZOMBIE — coloured capsule marker */
        if (d.kind === "zombie") {
            const geo = new THREE.CylinderGeometry(0.28, 0.28, 1.4, 10);
            const m = new THREE.Mesh(geo, ghostMat);
            m.position.set(0, 0.7, 0);
            group.add(m);
        }

        return group;
    }

    function updateGhostPosition() {
        if (!placing || !placing.ghost) return;
        const Hk = H();
        if (!Hk.camera || !Hk.raycastVoxel || !Hk.getLookDir) return;

        const cam = Hk.camera;
        const dir = Hk.getLookDir();
        const hit = Hk.raycastVoxel(cam.position, dir, 14);

        let tx, ty, tz;
        if (hit) {
            const vx = hit.x + hit.nx;
            const vy = hit.y + hit.ny;
            const vz = hit.z + hit.nz;
            tx = (vx + 0.5) * (Hk.VOXEL || 0.1);
            ty = (vy + 0.5) * (Hk.VOXEL || 0.1);
            tz = (vz + 0.5) * (Hk.VOXEL || 0.1);
        } else {
            tx = cam.position.x + dir.x * 5;
            ty = cam.position.y + dir.y * 5;
            tz = cam.position.z + dir.z * 5;
        }

        placing.ghost.position.set(tx, ty, tz);
        placing.ready = !!hit;
    }

    function beginPlacing(card) {
        cancelPlacing(); // any existing ghost first

        const Hk = H();
        const THREE = Hk.THREE;
        if (!THREE || !Hk.scene) return;

        const ghost = buildGhostMesh(card);
        if (!ghost) return;

        Hk.scene.add(ghost);
        placing = { card, ghost, ready: false };

        /* Bind global listeners once */
        if (!placeCanvas) placeCanvas = Hk.canvas || document;
        placeCanvas.addEventListener("mousedown", onPlaceMouseDown, true);
        document.addEventListener("keydown", onPlaceKeyDown, true);

        setStatus("PLACING  ·  " + card.name + "   —   LMB place   ·   RMB / ESC cancel");
        _updateGhostHud();
    }

    function _updateGhostHud() {
        /* Reuse the menu's own #sbmStatus if it exists; otherwise write to
           a floating hint in the corner. */
        let el = document.getElementById("sbmPlaceHint");
        if (!el) {
            el = document.createElement("div");
            el.id = "sbmPlaceHint";
            el.style.cssText =
                "position:fixed;left:50%;bottom:140px;transform:translateX(-50%);" +
                "z-index:55;pointer-events:none;" +
                'font:bold 12px "Courier New",monospace;letter-spacing:2px;' +
                "color:#e8c86a;background:rgba(13,16,22,0.85);" +
                "border:2px solid #e8c86a;padding:6px 14px;" +
                "box-shadow:0 0 14px rgba(232,200,106,.35);" +
                "opacity:0;transition:opacity .15s;white-space:nowrap;";
            document.body.appendChild(el);
        }
        if (placing) {
            el.textContent =
                "PLACING  ·  " + placing.card.name +
                (placing.ready ? "" : "  (no surface)") +
                "   —   LMB place · RMB cancel";
            el.style.opacity = "1";
        } else {
            el.style.opacity = "0";
        }
    }

    function cancelPlacing() {
        if (!placing) return;
        const Hk = H();
        if (placing.ghost && Hk.scene) Hk.scene.remove(placing.ghost);
        if (placing.ghost) {
            placing.ghost.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
        }
        placing = null;

        if (placeCanvas) placeCanvas.removeEventListener("mousedown", onPlaceMouseDown, true);
        document.removeEventListener("keydown", onPlaceKeyDown, true);
        _updateGhostHud();
    }

    function commitPlacing() {
        if (!placing || !placing.ready) return;
        const card = placing.card;
        cancelPlacing();
        spawnCardDirect(card);
    }

    function onPlaceMouseDown(e) {
        if (!placing) return;
        if (e.button === 0) {
            e.preventDefault();
            e.stopPropagation();
            commitPlacing();
        } else if (e.button === 2) {
            e.preventDefault();
            e.stopPropagation();
            cancelPlacing();
        }
    }

    function onPlaceKeyDown(e) {
        if (!placing) return;
        if (e.code === "Escape" || e.code === "KeyQ") {
            e.preventDefault();
            cancelPlacing();
        }
    }

    /* ============================================================
   TOGGLE HANDLER
   ------------------------------------------------------------
   Called instead of the spawn / placement path when a card's
   `data.kind === "toggle"`.  Flips the flag, updates the card's
   label + border colour, shows a status message.  Does NOT close
   the menu.
   ============================================================ */
    function handleToggle(card) {
        const Hk = H();
        const id = card.data.toggleId;
        let label, on;

        if (id === "creative") {
            const next = !(Hk.getCreativeMode && Hk.getCreativeMode());
            if (Hk.setCreativeMode) Hk.setCreativeMode(next);
            on = next;
            label = "CREATIVE";
        } else if (id === "ammo") {
            const f = window.ARiveSandboxFlags;
            f.infiniteAmmo = !f.infiniteAmmo;
            on = f.infiniteAmmo;
            label = "∞ AMMO";
        } else if (id === "ehp") {
            const f = window.ARiveSandboxFlags;
            f.infiniteEnemyHealth = !f.infiniteEnemyHealth;
            on = f.infiniteEnemyHealth;
            label = "∞ ENEMY HP";
        } else if (id === "eloop") {
            const f = window.ARiveSandboxFlags;
            f.enemyLoop = !f.enemyLoop;
            on = f.enemyLoop;
            label = "ENEMY LOOP";
        } else {
            return;
        }

        card.name = label + "  ·  " + (on ? "ON" : "OFF");
        if (card._nameEl) card._nameEl.textContent = card.name;
        if (card._el) {
            card._el.style.borderColor = on ? "#80ffb0" : "";
            card._el.style.boxShadow = on
                ? "0 0 12px rgba(128,255,176,0.55)"
                : "";
        }

        setStatus((on ? "✓  " : "✗  ") + label + "  " + (on ? "ON" : "OFF"));
    }

    const spawnCardDirect = spawnCard;
    spawnCard = function (card) {
        /* Toggle cards flip a flag and stay in the menu. */
        if (card.data && card.data.kind === "toggle") {
            handleToggle(card);
            return;
        }
        close();
        beginPlacing(card);
    };

    /* =====================================================================
       Public API
       ===================================================================== */
    window.SandboxMenu = {
        init,
        open,
        close,
        toggle,
        isOpen: () => isOpen,
        isPlacing: () => !!placing,
        cancelPlacing,
        update: function () { if (placing) updateGhostPosition(); },
        rebuild: () => {
            cardsBuilt = false;
            zombieIconCache = null;
            buildAllCards();
            cardsBuilt = true;
            if (isOpen) { renderSidebar(); renderGrid(); }
        },
    };
})();