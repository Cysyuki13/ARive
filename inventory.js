/* =========================================================================
   ARive — Grid Inventory  (Delta-Force / Tarkov style bag)
   -------------------------------------------------------------------------
   • 10 × 6 cell grid
   • Every item occupies w×h cells (puzzle placement)
   • LMB drag · R rotate · drop to place
   • Self-contained: injects its own CSS, exposes window.GridInventory
   ========================================================================= */
(function (global) {
    'use strict';
    const CELL = 44;
    const DEFAULT_COLS = 10;
    const DEFAULT_ROWS = 6;
    const STYLE_ID = 'gridInventoryStyle';

    const UI_RANKS = [0.70, 0.85, 1.00, 1.15, 1.30];
    const DEFAULT_UI_RANK = 3;
    const UI_RANK_KEY = 'arive‑inv‑ui‑rank';

    function rankScale(rank) {
        const i = Math.max(0, Math.min(UI_RANKS.length - 1, (rank | 0) - 1));
        return UI_RANKS[i];
    }

    const CSS = `
.inv-root {
  position: fixed; inset:0; z-index:30;
  display:flex; align-items:center; justify-content:center;
  background:rgba(4,6,9,0.72);
  font-family:"Courier New",monospace;
  color:#dfe4ea;
  user-select:none;-webkit-user-select:none;
}
.inv-root.hidden { display:none; }
.inv-panel {
    background:rgba(14,17,22,0.97);
    border:3px solid #3a2e26;
    box-shadow:0 0 0 3px #05070a,0 22px 60px rgba(0,0,0,.75);
    padding:18px 20px 14px;
    position:relative;
    max-width:96vw;
    transform-origin:50% 50%;
    transition:transform .15s ease-out;
}
.inv-title {
  font-size:16px; letter-spacing:6px; color:#e8c86a;
  text-align:center; margin-bottom:12px;
  text-shadow:2px 2px 0 #0c1119;
}

.inv-grid-wrap {
    position: relative;
    padding: 4px;
    background: #0a0d12;
    border: 2px solid #232b36;
    box-shadow: inset 0 0 0 1px #05070a;
    display: flex;
    gap: 10px;
    align-items: flex-start;
}

.inv-grid {
    position: relative;
    flex: 0 0 auto;
    width: calc(var(--cols) * ${CELL}px);
    height: calc(var(--rows) * ${CELL}px);
    background-color: rgba(0, 0, 0, 0.38);
    background-image:
        linear-gradient(to right, rgba(255,255,255,0.055) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.055) 1px, transparent 1px);
    background-size: ${CELL}px ${CELL}px;
}

.inv-item {
  position:absolute; box-sizing:border-box;
  border:2px solid rgba(0,0,0,0.55);
  border-radius:3px;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12),
              inset 0 -18px 20px -12px rgba(0,0,0,0.55);
  cursor:grab;
  display:flex; flex-direction:column;
  align-items:center; justify-content:center;
  gap:2px; overflow:hidden;
  transition:filter .1s;
}
.inv-item:hover { filter:brightness(1.18); }
.inv-item:active { cursor:grabbing; }
.inv-item-icon { font-size:20px; line-height:1; text-shadow:0 1px 0 rgba(0,0,0,0.5); }
.inv-item-name {
  font-size:10px; letter-spacing:0.5px;
  color:#eef3ff; text-shadow:1px 1px 0 #000,-1px -1px 0 #000;
  padding:0 3px; text-align:center; line-height:1.15; max-width:100%;
}
.inv-item-size {
  position:absolute; right:3px; bottom:2px;
  font-size:9px; color:rgba(255,255,255,0.55);
  text-shadow:1px 1px 0 #000;
}
.inv-help {
  margin-top:10px; font-size:11px; letter-spacing:1px;
  color:#7a6e5e; text-align:center;
}
.inv-help b { color:#e8c86a; }
.inv-size-row {
    display:flex;
    align-items:center;
    justify-content:center;
    gap:5px;
    margin-top:12px;
    font-size:10px;
    letter-spacing:1px;
}
.inv-size-row .inv-size-label {
    color:#7a6e5e;
    margin-right:6px;
}
.inv-size-row button {
    font-family:inherit;
    font-size:10px;
    padding:4px 8px;
    letter-spacing:0.5px;
    color:#b8c8d8;
    background:#141c26;
    border:1px solid #2a3a4a;
    cursor:pointer;
    transition:background .1s,color .1s,border-color .1s;
}
.inv-size-row button:hover {
    background:#1a2530;
    color:#e8c86a;
    border-color:#e8c86a;
}
.inv-size-row button.active {
    background:#2a3a4a;
    color:#e8c86a;
    border-color:#e8c86a;
    font-weight:bold;
}
/* ========= AUTO ARRANGE BUTTON ========= */
.inv-arrange-row {
    margin-top:10px;
    display:flex;
    justify-content:center;
}
.inv-arrange-row button {
    font-family:inherit;
    font-size:11px;
    font-weight:bold;
    text-transform:uppercase;
    padding:7px 18px;
    letter-spacing:1.8px;
    background:#1f2b38;
    color:#f6dd8b;
    border:2px solid #e8c86a;
    border-radius:3px;
    cursor:pointer;
    transition: all 0.16s ease-out;
    box-shadow: 0 0 0 rgba(232,200,106,0);
}
.inv-arrange-row button:hover {
    background:#37485a;
    color:#fff2c8;
    box-shadow: 0 0 12px 2px rgba(232, 200, 106, 0.35);
    border-color:#f6dd8b;
    transform: translateY(-1px);
}
.inv-arrange-row button:active {
    transform: translateY(1px) scale(0.97);
    background:#2a3a4a;
    box-shadow:0 0 4px 1px rgba(232,200,106,0.20);
}
.inv-arrange-row button:focus-visible {
    outline: none;
    box-shadow:0 0 0 2px #05070a, 0 0 0 4px #e8c86a;
}

/* ========= OVERFLOW SWAP PANEL (when inventory full on pickup) ========= */
.inv-overflow-wrap {
    position:absolute;
    left:105%;
    top:0;
    width:220px;
    background:rgba(12,15,20,0.96);
    border:2px solid #e8c86a;
    box-shadow:0 8px 24px rgba(0,0,0,0.7);
    padding:12px;
    z-index:35;
    display:none;
}
.inv-overflow-wrap.show { display:block; }
.inv-overflow-title {
    font-size:11px;
    letter-spacing:2px;
    color:#e8c86a;
    margin-bottom:8px;
    text-align:center;
}
.inv-overflow-item-preview {
    border:1px solid #444;
    min-height:80px;
    display:flex;
    align-items:center;
    justify-content:center;
    margin-bottom:10px;
}
.inv-overflow-buttons {
    display:flex; gap:6px;
}
.inv-overflow-buttons button {
    flex:1;
    font-family:inherit;
    font-size:10px;
    padding:6px;
    border:1px solid #2a3a4a;
    background:#141c26;
    color:#b8c8d8;
    cursor:pointer;
}
.inv-overflow-buttons button.danger {
    color:#e08a8a;
    border-color:#4a2a2a;
}
.inv-overflow-buttons button:hover {
    background:#1a2530;
    border-color:#6ac8e8;
}

/* ===== INCOMING — compact side card ===== */
.inv-incoming {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px;
    background: #0a0d12;
    border: 2px dashed #e8c86a;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px #05070a;
    min-width: 116px;
    transition: opacity .15s ease-out;
}

.inv-incoming-label {
    font-size: 9px;
    letter-spacing: 2px;
    color: #e8c86a;
    text-align: center;
    writing-mode: horizontal-tb;
    transform: none;
    opacity: 0.9;
}

.inv-incoming-slot {
    position: relative;
    width: 96px;
    height: 96px;
    background-color: rgba(0, 0, 0, 0.4);
    background-image:
        linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px);
    background-size: 8px 8px;
    border: 1px solid #232b36;
    overflow: hidden;
}

.inv-incoming-slot.empty::after {
    content: '—';
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #3a4a5a;
    font-size: 18px;
}

.inv-item-incoming {
    position: absolute !important;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    cursor: grab;
}

/* Keep every item icon contained, whatever the tile's inner size. */
.inv-item-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    display: block;
    pointer-events: none;
}

.inv-drag-layer { position:fixed; inset:0; pointer-events:none; z-index:40; }
.inv-drag-ghost {
  position:absolute; box-sizing:border-box;
  border:2px solid #e8c86a; border-radius:3px;
  box-shadow:0 0 0 1px #000,0 8px 24px rgba(0,0,0,.6);
  opacity:0.95; pointer-events:none;
  display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:2px;
  transition:left .04s linear,top .04s linear;
  transform-origin:0 0;
}
.inv-drag-ghost.invalid { border-color:#d04030; opacity:0.55; }
.inv-drag-ghost .inv-item-icon { font-size:20px; line-height:1; color:#fff; text-shadow:0 1px 0 rgba(0,0,0,0.5); }
.inv-drag-ghost .inv-item-name { font-size:10px; color:#fff; text-shadow:1px 1px 0 #000,-1px -1px 0 #000; text-align:center; padding:0 3px; }
.inv-drag-ghost .inv-item-size { position:absolute; right:3px; bottom:2px; font-size:9px; color:rgba(255,255,255,0.7); text-shadow:1px 1px 0 #000; }
`;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    class GridInventory {
        constructor(opts) {
            opts = opts || {};
            injectStyle();
            this.cols = Math.max(1, opts.cols | 0 || DEFAULT_COLS);
            this.rows = Math.max(1, opts.rows | 0 || DEFAULT_ROWS);
            this.uiRank = this._loadUiRank();
            this.items = [];
            this._nextId = 1;
            this.isOpen = false;
            this.onChange = opts.onChange || null;
            this.onOpen = opts.onOpen || null;
            this.onClose = opts.onClose || null;
            this.onDropOutside = opts.onDropOutside || null;

            // === OVERFLOW / incoming pickup when full ===
            this._overflowItem = null;
            this._onOverflowDropToFloor = opts.onOverflowDropToFloor || null;
            this._onOverflowSwapComplete = opts.onOverflowSwapComplete || null;

            this._drag = null;
            this._dragGhost = null;
            this._onPointerMove = this._onPointerMove.bind(this);
            this._onPointerUp = this._onPointerUp.bind(this);
            this._onKeyDown = this._onKeyDown.bind(this);
            this._buildDom();
        }

        _loadUiRank() {
            try {
                const s = localStorage.getItem(UI_RANK_KEY);
                const n = parseInt(s, 10);
                if (n >= 1 && n <= 5) return n;
            } catch (e) { }
            return DEFAULT_UI_RANK;
        }
        _saveUiRank() {
            try { localStorage.setItem(UI_RANK_KEY, String(this.uiRank)); } catch (e) { }
        }
        _applyUiScale() {
            if (!this.panelEl) return;
            const s = rankScale(this.uiRank);
            this.panelEl.style.transform = (s === 1) ? '' : ('scale(' + s + ')');
        }
        _updateSizeRow() {
            if (!this.sizeRowEl) return;
            const btns = this.sizeRowEl.querySelectorAll('button[data-rank]');
            for (let i = 0; i < btns.length; i++) {
                const b = btns[i];
                b.classList.toggle('active', parseInt(b.dataset.rank, 10) === this.uiRank);
            }
        }
        setUiRank(rank) {
            rank = Math.max(1, Math.min(UI_RANKS.length, rank | 0));
            if (rank === this.uiRank) return;
            this.uiRank = rank;
            this._saveUiRank();
            this._applyUiScale();
            this._updateSizeRow();
            if (this._dragGhost) {
                this._dragGhost.style.transform = 'scale(' + rankScale(this.uiRank) + ')';
                if (this._drag) this._updateDragPos(this._drag.pointerX, this._drag.pointerY);
            }
        }
        getUiRank() { return this.uiRank; }

        addItem(def) {
            const item = {
                id: def.id != null ? def.id : ('it' + (this._nextId++)),
                name: def.name || 'Item',
                w: Math.max(1, def.w | 0),
                h: Math.max(1, def.h | 0),
                icon: def.icon || '',
                iconImage: def.iconImage || '',
                iconImageRotated: def.iconImageRotated || '',
                color: def.color || '#4a5a6a',
                rotated: !!def.rotated,
                x: 0, y: 0,
                meta: def.meta || null,
                /* Carry the furniture tags through the bag so a stashed piece
                   still knows it's furniture when it comes back out. */
                size: def.size,
                furnitureKey: def.furnitureKey
            };
            const spot = this._findFreeSpot(item);
            if (!spot) return null;
            item.x = spot.x; item.y = spot.y;
            this.items.push(item);
            this.render();
            this._emitChange();
            return item;
        }

        removeItem(id) {
            const i = this.items.findIndex(it => it.id === id);
            if (i < 0) return null;
            const it = this.items.splice(i, 1)[0];
            this.render();
            this._emitChange();
            return it;
        }
        getItems() { return this.items.slice(); }
        getItem(id) { return this.items.find(it => it.id === id) || null; }

        /** check if there exists ANY free cell (not just fit for item) */
        hasAnyFreeCell() {
            const occ = this._occupancy();
            for (let y = 0; y < this.rows; y++) {
                for (let x = 0; x < this.cols; x++) {
                    if (!occ[y][x]) return true;
                }
            }
            return false;
        }

        hasRoomFor(w, h) {
            return !!this._findFreeSpot({ id: '__probe', w: w, h: h, rotated: false });
        }

        open() {
            if (this.isOpen) return;
            this.isOpen = true;
            this.root.classList.remove('hidden');
            this.render();
            document.addEventListener('keydown', this._onKeyDown, true);
            if (this.onOpen) this.onOpen();
        }
        close() {
            if (!this.isOpen) return;
            this._cancelDrag();
            this._hideOverflowPanel();

            /* Flip `isOpen` BEFORE firing the drop callback.  The callback
               may re-enter close() (furniture drops do this when they route
               through dropItemInWorld → enterFurnitureCarry).  The early-
               return guard must already be armed, otherwise we'd recurse. */
            this.isOpen = false;
            this.root.classList.add('hidden');
            document.removeEventListener('keydown', this._onKeyDown, true);

            /* Anything left in the incoming staging slot is dumped to the
               world.  Furniture enters carry mode via dropItemInWorld;
               regular items simply fall to the floor. */
            if (this.incomingItem && this.onDropOutside) {
                const staged = this.incomingItem;
                this.incomingItem = null;
                try { this.onDropOutside(staged); }
                catch (e) { console.error(e); }
            }

            if (this.onClose) this.onClose();
        }
        toggle() { this.isOpen ? this.close() : this.open(); }

        // ========== AUTO ARRANGE NEW FUNCTION ==========
        /**
         * Auto‑arrange: compact items top‑left, preserve trailing empty space at bottom‑right.
         * Do NOT fill every hole inside grid; leave contiguous empty area for new pickups.
         */
        autoArrange() {
            /* Snapshot with original positions so a piece that can't be
               re-packed at all can still fall back to where it was, rather
               than vanishing from the inventory. */
            const snapshot = this.items.map(it => ({
                it,
                x: it.x,
                y: it.y,
                rotated: it.rotated
            }));

            /* Greedy bin-packing heuristic: sort largest-first.
               Without this, a bunch of 1×1 items would eat every top-left
               cell before a 3×1 or 2×2 item got a chance, and the big item
               would be silently dropped. */
            snapshot.sort((a, b) => {
                const areaA = a.it.w * a.it.h;
                const areaB = b.it.w * b.it.h;
                if (areaA !== areaB) return areaB - areaA;
                /* Tie-break on longest edge, so 3×1 beats 2×2 at the same area. */
                const longA = Math.max(a.it.w, a.it.h);
                const longB = Math.max(b.it.w, b.it.h);
                return longB - longA;
            });

            this.items.length = 0;

            for (const entry of snapshot) {
                const it = entry.it;
                it.x = 0;
                it.y = 0;
                it.rotated = false;

                const spot = this._findFreeSpot(it);
                if (spot) {
                    it.x = spot.x;
                    it.y = spot.y;
                    this.items.push(it);
                } else {
                    /* Couldn't re-pack — restore the pre-sort position so the
                       item never disappears.  It may overlap with the re-packed
                       pieces; the player can drag it manually if that happens. */
                    it.x = entry.x;
                    it.y = entry.y;
                    it.rotated = entry.rotated;
                    this.items.push(it);
                }
            }

            this.render();
            this._emitChange();
        }

        // ========== OVERFLOW PANEL API: show incoming item when inventory full ==========
        showOverflowPanel(incomingItemDef) {
            this._overflowItem = { ...incomingItemDef };
            this._renderOverflowPanel();
            this._overflowWrapEl.classList.add('show');
        }
        _hideOverflowPanel() {
            this._overflowItem = null;
            if (this._overflowWrapEl) this._overflowWrapEl.classList.remove('show');
        }
        _renderOverflowPanel() {
            if (!this._overflowWrapEl || !this._overflowItem) return;
            const preview = this._overflowWrapEl.querySelector('.inv-overflow-item-preview');
            preview.innerHTML = `<div class="inv-item-icon">${this._overflowItem.icon || ''}</div>
        <div class="inv-item-name">${this._overflowItem.name}</div>
        <div class="inv-item-size">${this._overflowItem.w}×${this._overflowItem.h}</div>`;
        }

        _buildDom() {
            const root = document.createElement('div');
            root.className = 'inv-root hidden';
            root.innerHTML =
                '<div class="inv-panel">' +
                '  <div class="inv-title">FIELD PACK</div>' +
                '  <div class="inv-grid-wrap">' +
                '    <div class="inv-grid"></div>' +
                '    <div class="inv-incoming" title="Incoming item — drag into the bag">' +
                '      <div class="inv-incoming-label">INCOMING</div>' +
                '      <div class="inv-incoming-slot"></div>' +
                '    </div>' +
                '    <!-- OVERFLOW PANEL -->' +
                '    <div class="inv-overflow-wrap">' +
                '        <div class="inv-overflow-title">INCOMING ITEM</div>' +
                '        <div class="inv-overflow-item-preview"></div>' +
                '        <div class="inv-overflow-buttons">' +
                '            <button class="inv‑swap‑btn">SWAP TO SLOT</button>' +
                '            <button class="inv‑drop‑floor‑btn danger">DROP FLOOR</button>' +
                '        </div>' +
                '    </div>' +
                '  </div>' +
                '  <div class="inv‑arrange‑row">' +
                '    <button class="auto‑arrange‑btn" title="Auto arrange — pack items into the top-left">' +
                '      <svg class="aa-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '        <path d="M16.5 16.5 9 9"/>' +
                '        <path d="M9 13.5V9h4.5"/>' +
                '        <rect x="2" y="2" width="5.2" height="5.2" rx="1" fill="currentColor" stroke="none" opacity=".95"/>' +
                '        <rect x="12.8" y="2" width="5.2" height="5.2" rx="1" fill="currentColor" stroke="none" opacity=".42"/>' +
                '        <rect x="2" y="12.8" width="5.2" height="5.2" rx="1" fill="currentColor" stroke="none" opacity=".42"/>' +
                '      </svg>' +
                '      <span class="aa-label">Sort</span>' +
                '    </button>' +
                '  </div>' +

                '  <div class="inv-size-row">' +
                '    <span class="inv-size-label">UI SIZE</span>' +
                '    <button data-rank="1">70%</button>' +
                '    <button data-rank="2">85%</button>' +
                '    <button data-rank="3">100%</button>' +
                '    <button data-rank="4">115%</button>' +
                '    <button data-rank="5">130%</button>' +
                '  </div>' +
                '  <div class="inv-help"><b>LMB</b> drag &nbsp;·&nbsp; <b>R</b> rotate &nbsp;·&nbsp; <b>–/+</b> size &nbsp;·&nbsp; <b>TAB</b> close</div>' +
                '</div>' +
                '<div class="inv-drag-layer"></div>';
            document.body.appendChild(root);
            this.root = root;
            this.gridEl = root.querySelector('.inv-grid');
            this.panelEl = root.querySelector('.inv-panel');
            this.dragLayer = root.querySelector('.inv-drag-layer');
            this.sizeRowEl = root.querySelector('.inv-size-row');
            this._overflowWrapEl = root.querySelector('.inv-overflow-wrap');
            this.incomingSlotEl = root.querySelector('.inv-incoming-slot');
            this.incomingWrapEl = root.querySelector('.inv-incoming');

            this.gridEl.style.setProperty('--cols', this.cols);
            this.gridEl.style.setProperty('--rows', this.rows);

            // auto arrange button click
            const arrangeBtn = root.querySelector('.auto‑arrange‑btn');
            arrangeBtn.addEventListener('click', () => {
                this.autoArrange();
                arrangeBtn.classList.add('done');
                clearTimeout(this._arrangeFlashT);
                this._arrangeFlashT = setTimeout(() => arrangeBtn.classList.remove('done'), 240);
            });

            // overflow drop‑to‑floor button
            root.querySelector('.inv‑drop‑floor‑btn').addEventListener('click', () => {
                const item = this._overflowItem;
                this._hideOverflowPanel();
                if (this._onOverflowDropToFloor && item) this._onOverflowDropToFloor(item);
            });

            // overflow swap button hint: user drag preview item onto inventory slot to perform swap
            const btns = this.sizeRowEl.querySelectorAll('button[data-rank]');
            for (let i = 0; i < btns.length; i++) {
                const b = btns[i];
                b.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    this.setUiRank(parseInt(b.dataset.rank, 10));
                });
            }
            root.addEventListener('contextmenu', e => e.preventDefault());
            this._applyUiScale();
            this._updateSizeRow();
        }

        render() {
            const old = this.gridEl.querySelectorAll('.inv-item');
            for (let i = 0; i < old.length; i++) old[i].remove();
            for (const it of this.items) {
                const w = it.rotated ? it.h : it.w;
                const h = it.rotated ? it.w : it.h;
                const el = document.createElement('div');
                el.className = 'inv-item';
                el.style.left = (it.x * CELL) + 'px';
                el.style.top = (it.y * CELL) + 'px';
                el.style.width = (w * CELL) + 'px';
                el.style.height = (h * CELL) + 'px';
                el.style.background = it.color;
                el.innerHTML = this._itemHtml(it, w, h);
                el.addEventListener('pointerdown', (e) => this._onItemPointerDown(e, it));
                this.gridEl.appendChild(el);
            }
            /* Draw the incoming slot every render, so it reflects the latest
               piece the player picked up with a full bag.  Runs once — after
               the loop — so an empty inventory still shows the slot. */
            this._renderIncomingSlot();
            /* The incoming card only appears when something is actually
               staged there.  An empty dashed box was confusing because it
               never disappeared after the item was dragged into the grid. */
            if (this.incomingWrapEl) {
                const hasItem = !!this.incomingItem;
                this.incomingWrapEl.style.display = hasItem ? '' : 'none';
                this.incomingWrapEl.style.opacity = hasItem ? '1' : '0';
            }
        }

        _itemHtml(it, w, h) {
            const activeIcon = (it.rotated && it.iconImageRotated) ? it.iconImageRotated : it.iconImage;
            const icon = activeIcon ? `<img class="inv-item-img" src="${activeIcon}" alt="">` : (it.icon || '');
            return `<div class="inv-item-icon">${icon}</div>
        <div class="inv-item-name">${it.name}</div>
        <div class="inv-item-size">${w}×${h}</div>`;
        }

        _occupancy(excludeId) {
            const g = [];
            for (let y = 0; y < this.rows; y++) g.push(new Array(this.cols).fill(null));
            for (const it of this.items) {
                if (it.id === excludeId) continue;
                const w = it.rotated ? it.h : it.w;
                const h = it.rotated ? it.w : it.h;
                for (let dy = 0; dy < h; dy++) {
                    for (let dx = 0; dx < w; dx++) {
                        const gx = it.x + dx;
                        const gy = it.y + dy;
                        if (gx >= 0 && gy >= 0 && gx < this.cols && gy < this.rows) g[gy][gx] = it.id;
                    }
                }
            }
            return g;
        }

        _canPlace(item, x, y, rotated, excludeId) {
            const w = rotated ? item.h : item.w;
            const h = rotated ? item.w : item.h;
            if (x < 0 || y < 0) return false;
            if (x + w > this.cols || y + h > this.rows) return false;
            const occ = this._occupancy(excludeId);
            for (let dy = 0; dy < h; dy++) {
                for (let dx = 0; dx < w; dx++) {
                    if (occ[y + dy][x + dx]) return false;
                }
            }
            return true;
        }

        _findFreeSpot(item) {
            for (let pass = 0; pass < 2; pass++) {
                const rot = (pass === 1);
                const w = rot ? item.h : item.w;
                const h = rot ? item.w : item.h;
                if (w > this.cols || h > this.rows) continue;
                for (let y = 0; y + h <= this.rows; y++) {
                    for (let x = 0; x + w <= this.cols; x++) {
                        if (this._canPlace(item, x, y, rot, item.id)) {
                            item.rotated = rot;
                            return { x, y };
                        }
                    }
                }
            }
            return null;
        }

        // ========== DRAG‑DROP SWAP LOGIC ==========
        _onItemPointerDown(e, it) {
            if (e.button !== 0) return;
            if (this._drag) return;
            e.preventDefault(); e.stopPropagation();
            const el = e.currentTarget;
            const r = el.getBoundingClientRect();
            this._drag = {
                item: it,
                originX: it.x,
                originY: it.y,
                originRotated: it.rotated,
                grabX: e.clientX - r.left,
                grabY: e.clientY - r.top,
                pointerX: e.clientX,
                pointerY: e.clientY,
                gridX: it.x,
                gridY: it.y,
                valid: true
            };
            el.remove();
            this._createGhost(it);
            window.addEventListener('pointermove', this._onPointerMove);
            window.addEventListener('pointerup', this._onPointerUp);
            this._updateDragPos(e.clientX, e.clientY);
        }

        _createGhost(item) {
            const w = item.rotated ? item.h : item.w;
            const h = item.rotated ? item.w : item.h;
            const g = document.createElement('div');
            g.className = 'inv-drag-ghost';
            g.style.width = (w * CELL) + 'px';
            g.style.height = (h * CELL) + 'px';
            g.style.transformOrigin = '0 0';
            g.style.transform = 'scale(' + rankScale(this.uiRank) + ')';
            g.style.background = item.color;
            g.innerHTML = this._itemHtml(item, w, h);
            this.dragLayer.appendChild(g);
            this._dragGhost = g;
        }

        _updateDragPos(clientX, clientY) {
            const d = this._drag;
            if (!d) return;
            d.pointerX = clientX; d.pointerY = clientY;
            const scale = rankScale(this.uiRank);
            const gr = this.gridEl.getBoundingClientRect();
            const localX = clientX - gr.left - d.grabX;
            const localY = clientY - gr.top - d.grabY;
            const cx = Math.round(localX / (CELL * scale));
            const cy = Math.round(localY / (CELL * scale));
            d.gridX = cx; d.gridY = cy;

            // SWAP LOGIC: an item already in the grid may be dropped onto
            // another grid item (→ swap).  An incoming item has no grid
            // slot to swap *from*, so it may only land on a free cell.
            const canPlace = this._canPlace(d.item, cx, cy, d.item.rotated, d.item.id);
            if (d.fromIncoming) {
                d.valid = canPlace;
            } else {
                const occ = this._occupancy(d.item.id);
                const targetOccupied =
                    (cy >= 0 && cx >= 0 && cy < this.rows && cx < this.cols) &&
                    !!occ[cy][cx];
                d.valid = canPlace || targetOccupied;
            }

            this._dragGhost.style.left = (gr.left + cx * CELL * scale) + 'px';
            this._dragGhost.style.top = (gr.top + cy * CELL * scale) + 'px';
            this._dragGhost.classList.toggle('invalid', !d.valid);
        }

        _onPointerMove(e) {
            if (!this._drag) return;
            this._updateDragPos(e.clientX, e.clientY);
        }

        _onPointerUp() {
            const d = this._drag;
            if (!d) return;
            // detect drop outside panel
            if (this.onDropOutside && this.panelEl) {
                const rr = this.panelEl.getBoundingClientRect();
                const M = 24;
                const px = d.pointerX, py = d.pointerY;
                const outside = px < rr.left - M || px > rr.right + M || py < rr.top - M || py > rr.bottom + M;
                if (outside) {
                    const dropped = d.item;
                    this._destroyGhost();
                    this._drag = null;
                    window.removeEventListener('pointermove', this._onPointerMove);
                    window.removeEventListener('pointerup', this._onPointerUp);
                    /* removeItem() finds the record by id, so it works whether the
                       drop came from a grid slot or from the incoming staging slot. */
                    this.removeItem(dropped.id);
                    try { if (this.onDropOutside) this.onDropOutside(dropped); } catch (err) { console.error(err); }
                    return;
                }
            }

            let placed = false;
            const occ = this._occupancy(d.item.id);
            const tx = d.gridX;
            const ty = d.gridY;
            // ========= SWAP IMPLEMENTATION =========
            let swapTargetItem = null;
            if (!d.fromIncoming &&
                ty >= 0 && tx >= 0 && ty < this.rows && tx < this.cols) {
                const targetId = occ[ty][tx];
                if (targetId) {
                    swapTargetItem = this.items.find(it => it.id === targetId);
                }
            }

            if (swapTargetItem) {
                // perform swap: swap positions of dragged item and target item
                const tmpX = d.item.x;
                const tmpY = d.item.y;
                d.item.x = swapTargetItem.x;
                d.item.y = swapTargetItem.y;
                swapTargetItem.x = tmpX;
                swapTargetItem.y = tmpY;
                placed = true;
            } else if (this._canPlace(d.item, tx, ty, d.item.rotated, d.item.id)) {
                d.item.x = tx; d.item.y = ty;
                placed = true;
            } else if (this._canPlace(d.item, d.originX, d.originY, d.item.rotated, d.item.id)) {
                d.item.x = d.originX; d.item.y = d.originY;
                placed = true;
            } else if (d.fromIncoming) {
                /* Incoming item couldn't be placed — put it back in the
                   incoming slot.  Remove the ghostItem by id, not by
                   position, so we never yank the wrong item. */
                const gi = this.items.findIndex(it => it.id === d.item.id);
                if (gi >= 0) this.items.splice(gi, 1);
                this.addToIncoming(d.item);
                this._destroyGhost();
                this._drag = null;
                window.removeEventListener('pointermove', this._onPointerMove);
                window.removeEventListener('pointerup', this._onPointerUp);
                this.render();
                this._emitChange();
                return;
            } else {
                d.item.x = d.originX; d.item.y = d.originY;
                d.item.rotated = d.originRotated;
            }

            this._destroyGhost();
            this._drag = null;
            window.removeEventListener('pointermove', this._onPointerMove);
            window.removeEventListener('pointerup', this._onPointerUp);
            this.render();
            this._emitChange();
        }

        _cancelDrag() {
            const d = this._drag;
            if (d) {
                if (d.fromIncoming) {
                    /* Incoming drags have no grid origin to return to.
                       Pull the ghost out of items and put it back in the
                       staging slot so the piece isn't lost. */
                    const gi = this.items.findIndex(it => it.id === d.item.id);
                    if (gi >= 0) this.items.splice(gi, 1);
                    this.addToIncoming(d.item);
                } else {
                    d.item.x = d.originX;
                    d.item.y = d.originY;
                    d.item.rotated = d.originRotated;
                }
            }
            this._destroyGhost();
            this._drag = null;
            window.removeEventListener('pointermove', this._onPointerMove);
            window.removeEventListener('pointerup', this._onPointerUp);
            this.render();
        }

        _destroyGhost() {
            if (this._dragGhost) {
                this._dragGhost.remove();
                this._dragGhost = null;
            }
        }

        _onKeyDown(e) {
            if (!this.isOpen) return;
            if (e.code === 'Minus' || e.code === 'BracketLeft') {
                e.preventDefault(); e.stopPropagation();
                this.setUiRank(this.uiRank - 1);
                return;
            }
            if (e.code === 'Equal' || e.code === 'BracketRight') {
                e.preventDefault(); e.stopPropagation();
                this.setUiRank(this.uiRank + 1);
                return;
            }
            if (e.code === 'KeyR' && this._drag) {
                e.preventDefault(); e.stopPropagation();
                const it = this._drag.item;
                it.rotated = !it.rotated;
                const g = this._dragGhost;
                if (g) {
                    const w = it.rotated ? it.h : it.w;
                    const h = it.rotated ? it.w : it.h;
                    g.style.width = (w * CELL) + 'px';
                    g.style.height = (h * CELL) + 'px';
                    g.innerHTML = this._itemHtml(it, w, h);
                }
                this._updateDragPos(this._drag.pointerX, this._drag.pointerY);
            }
        }

        _emitChange() {
            if (this.onChange) { try { this.onChange(this.getItems()); } catch (err) { console.error(err); } }
        }

        /* ============================================================
           INCOMING SLOT
           ------------------------------------------------------------
           A single-cell staging area for items the player picked up
           while the bag was full.  The item shows up here; the player
           drags it into a free cell to commit it.  If a second item
           arrives while the slot is occupied, the previous one is
           dropped to the floor (via onDropOutside) so nothing is
           silently lost.
           ============================================================ */
        addToIncoming(def) {
            if (this.incomingItem && this.onDropOutside) {
                /* Spill the stale incoming item to the world first. */
                try { this.onDropOutside(this.incomingItem); }
                catch (e) { console.error(e); }
            }
            this.incomingItem = Object.assign({}, def);
            this.incomingItem._incoming = true;
            this.render();               // refresh → draws the slot
        }

        _clearIncoming() {
            this.incomingItem = null;
            this.render();
        }

        /* Builds the clickable tile that lives in the incoming slot.
           Uses the same .inv-item visual language as a real grid item
           so the player immediately recognises it as draggable. */
        _renderIncomingSlot() {
            const host = this.incomingSlotEl;
            if (!host) return;
            host.innerHTML = '';
            if (!this.incomingItem) {
                host.classList.add('empty');
                return;
            }
            host.classList.remove('empty');

            const it = this.incomingItem;
            const w = it.rotated ? it.h : it.w;
            const h = it.rotated ? it.w : it.h;

            /* Fit the item inside the 96×96 slot, leaving a small visual margin.
               We keep the item's w:h aspect ratio, then scale both axes by the
               same factor so it never overflows — long rifles get squashed to
               88×22, a 2×2 crate becomes 88×88, and so on. */
            const SLOT_W = 96, SLOT_H = 96;
            const PAD = 8;
            const availW = SLOT_W - PAD * 2;
            const availH = SLOT_H - PAD * 2;
            const cellW = availW / w;
            const cellH = availH / h;
            const cw = Math.min(cellW, cellH);

            const el = document.createElement('div');
            el.className = 'inv-item inv-item-incoming';
            el.style.width = (cw * w) + 'px';
            el.style.height = (cw * h) + 'px';
            el.style.background = it.color;
            el.innerHTML = this._itemHtml(it, w, h);
            el.addEventListener('pointerdown', (e) => this._onIncomingPointerDown(e, it));
            host.appendChild(el);
        }

        _onIncomingPointerDown(e, it) {
            if (e.button !== 0) return;
            if (this._drag) return;
            e.preventDefault(); e.stopPropagation();

            const el = e.currentTarget;
            const r = el.getBoundingClientRect();

            /* Move the item out of the slot and into the drag flow. */
            this.incomingItem = null;
            this.render();

            /* Only promote the tags if this is genuinely a furniture piece.
               Anything else keeps the plain item flow — grab with hand tool,
               drop as a physics body. */
            const isFurnitureItem = (it.size === 'small' ||
                it.size === 'medium' ||
                it.size === 'large');

            const ghostItem = {
                id: 'incoming-' + (this._nextId++),
                name: it.name,
                w: Math.max(1, it.w | 0),
                h: Math.max(1, it.h | 0),
                icon: it.icon || '',
                iconImage: it.iconImage || '',
                iconImageRotated: it.iconImageRotated || '',
                color: it.color || '#4a5a6a',
                rotated: !!it.rotated,
                x: -99, y: -99,
                meta: it.meta || null,
                size: isFurnitureItem ? it.size : undefined,
                furnitureKey: isFurnitureItem ? it.furnitureKey : undefined
            };

            this.items.push(ghostItem);

            this._drag = {
                item: ghostItem,
                originX: -99, originY: -99,
                originRotated: ghostItem.rotated,
                grabX: e.clientX - r.left,
                grabY: e.clientY - r.top,
                pointerX: e.clientX,
                pointerY: e.clientY,
                gridX: 0, gridY: 0,
                valid: true,
                fromIncoming: true
            };
            el.remove();
            this._createGhost(ghostItem);
            window.addEventListener('pointermove', this._onPointerMove);
            window.addEventListener('pointerup', this._onPointerUp);
            this._updateDragPos(e.clientX, e.clientY);
        }
    }
    global.GridInventory = GridInventory;
})(window);
