/* =========================================================================
   ARive — Avatar Customizer (main-menu UI)
   ========================================================================= */
(function (global) {
    'use strict';

    const COLOR_KEYS = [
        { k: 'skin', label: 'SKIN' },
        { k: 'hair', label: 'HAIR' },
        { k: 'shirt', label: 'SHIRT' },
        { k: 'pants', label: 'PANTS' },
        { k: 'boot', label: 'BOOT' },
        { k: 'accent', label: 'ACCENT' },
    ];
    const PART_PARENTS = ['head', 'torso', 'hip', 'armL', 'armR', 'legL', 'legR'];

    let root = null;
    let previewRenderer = null, previewScene = null, previewCamera = null, previewModel = null;
    let previewCanvas = null;
    let previewAngle = 0;
    let animRunning = false;
    let workingAvatar = null;
    let statusEl = null;
    let partListEl = null;

    function H() { return global.ARiveHooks || {}; }

    function injectStyles() {
        if (document.getElementById('avatarStyles')) return;
        const style = document.createElement('style');
        style.id = 'avatarStyles';
        style.textContent = `
#avRoot { position:fixed; inset:0; z-index:65; background:rgba(6,8,12,.78);
  display:none; align-items:center; justify-content:center;
  font-family:'Courier New',monospace; }
#avRoot.open { display:flex; }
#avWindow { width:min(940px,94vw); max-height:90vh; background:#0d1016;
  border:2px solid #e8c86a; box-shadow:0 0 40px rgba(232,200,106,.18);
  display:flex; flex-direction:column; overflow:hidden; }
.av-header { display:flex; align-items:center; gap:12px; padding:10px 16px;
  background:#12161d; border-bottom:2px solid #2b333f; }
.av-title { font:bold 14px 'Courier New',monospace; letter-spacing:3px;
  color:#e8c86a; text-shadow:0 0 8px rgba(232,200,106,.4); }
.av-close { margin-left:auto; background:transparent; border:2px solid #6a5a44;
  color:#e8c86a; font:bold 12px 'Courier New',monospace; padding:6px 12px;
  cursor:pointer; letter-spacing:1px; }
.av-close:hover { background:#e8c86a; color:#0d1016; }
.av-body { flex:1 1 auto; display:flex; min-height:0; }
.av-preview { flex:0 0 360px; background:#05070a; border-right:2px solid #2b333f;
  position:relative; display:flex; align-items:center; justify-content:center; }
.av-preview canvas { display:block; }
.av-preview-label { position:absolute; top:8px; left:10px;
  font:bold 10px 'Courier New',monospace; letter-spacing:2px; color:#6a5a44; }
.av-preview-hint { position:absolute; bottom:8px; left:10px; right:10px;
  font:9px 'Courier New',monospace; letter-spacing:1px; color:#4a4030;
  text-align:center; }
.av-controls { flex:1 1 auto; overflow-y:auto; padding:14px 16px;
  display:flex; flex-direction:column; gap:8px; }
.av-section-title { font:bold 11px 'Courier New',monospace; letter-spacing:2px;
  color:#e8c86a; margin-top:6px; margin-bottom:2px; border-bottom:1px solid #1a1f26;
  padding-bottom:4px; }
.av-color-row { display:flex; align-items:center; gap:10px; }
.av-color-row label { flex:0 0 90px; font:bold 10px 'Courier New',monospace;
  letter-spacing:1px; color:#a89a84; }
.av-color-row input[type=color] { width:44px; height:32px; background:transparent;
  border:2px solid #2b333f; padding:0; cursor:pointer; }
.av-color-row input[type=color]:hover { border-color:#e8c86a; }
.av-color-row .av-hex { flex:1 1 auto; font:10px 'Courier New',monospace;
  color:#7a6e5e; letter-spacing:1px; }
.av-parts-list { display:flex; flex-direction:column; gap:6px; max-height:240px;
  overflow-y:auto; padding-right:4px; }
.av-part-row { display:flex; align-items:center; gap:6px; padding:6px 8px;
  background:#12161d; border:1px solid #2b333f; }
.av-part-row select { font:10px 'Courier New',monospace; background:#05070a;
  color:#e8c86a; border:1px solid #2b333f; padding:3px; flex:0 0 72px; }
.av-part-row input[type=color] { width:26px; height:24px; padding:0;
  border:1px solid #2b333f; cursor:pointer; }
.av-part-inputs { display:flex; gap:3px; }
.av-part-inputs label { font:8px 'Courier New',monospace; color:#6a5a44;
  text-align:center; display:flex; flex-direction:column; gap:1px; }
.av-part-inputs input[type=number] { width:40px; font:10px 'Courier New',monospace;
  background:#05070a; color:#e8c86a; border:1px solid #2b333f; padding:2px 3px; }
.av-del { margin-left:auto; background:transparent; border:1px solid #4a2e2e;
  color:#e8a0a0; font:bold 10px 'Courier New',monospace; padding:2px 7px;
  cursor:pointer; }
.av-del:hover { background:#4a2e2e; color:#ffc8c8; }
.av-add-part-btn { margin-top:4px; padding:6px 10px;
  font:bold 10px 'Courier New',monospace; background:#1a2530; color:#a89a84;
  border:1px dashed #2b333f; cursor:pointer; letter-spacing:1px; }
.av-add-part-btn:hover { color:#e8c86a; border-color:#e8c86a; }
.av-footer { padding:10px 16px; background:#12161d; border-top:2px solid #2b333f;
  display:flex; gap:10px; align-items:center; }
.av-btn { font:bold 11px 'Courier New',monospace; letter-spacing:2px; padding:8px 16px;
  cursor:pointer; background:#1a2530; color:#e8c86a; border:2px solid #e8c86a; }
.av-btn:hover { background:#e8c86a; color:#0d1016; }
.av-btn.primary { background:#e8c86a; color:#0d1016; }
.av-btn.primary:hover { background:#f6dd8b; }
.av-status { margin-left:auto; font:10px 'Courier New',monospace;
  letter-spacing:1px; color:#7a6e5e; }
`;
        document.head.appendChild(style);
    }

    /* ---------------- Preview scene ---------------- */
    function initPreview() {
        if (previewRenderer) return true;
        const THREE = window.THREE || (H() && H().THREE);
        if (!THREE) return false;

        previewCanvas = document.createElement('canvas');
        previewCanvas.width = 340;
        previewCanvas.height = 500;

        previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
        previewRenderer.setPixelRatio(1);
        previewRenderer.setSize(340, 500, false);

        previewScene = new THREE.Scene();
        previewScene.background = null;

        previewCamera = new THREE.PerspectiveCamera(30, 340 / 500, 0.05, 30);
        previewCamera.position.set(1.15, 1.55, 2.15);
        previewCamera.lookAt(0, 0.9, 0);

        const key = new THREE.DirectionalLight(0xffd890, 1.2);
        key.position.set(2, 4, 2);
        previewScene.add(key);
        const fill = new THREE.DirectionalLight(0x6080a0, 0.6);
        fill.position.set(-2, 2, -2);
        previewScene.add(fill);
        previewScene.add(new THREE.AmbientLight(0xffffff, 0.55));

        const grid = new THREE.GridHelper(4, 8, 0x2b333f, 0x1a1f26);
        previewScene.add(grid);
        const platGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.04, 24);
        const platMat = new THREE.MeshStandardMaterial({ color: 0x1a2530, metalness: 0.3, roughness: 0.7 });
        const plat = new THREE.Mesh(platGeo, platMat);
        plat.position.y = 0.02;
        previewScene.add(plat);

        return true;
    }

    function rebuildPreviewModel() {
        if (!previewRenderer) return;
        if (previewModel) {
            previewScene.remove(previewModel);
            previewModel.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
            previewModel = null;
        }
        const Hk = global.ARiveHooks;
        if (!Hk || !Hk.buildRemotePlayerMesh) return;
        const model = Hk.buildRemotePlayerMesh(global.ARiveAvatar.toRemoteModelData(workingAvatar));
        previewModel = model.group;
        previewScene.add(previewModel);
        previewAngle = 0;
    }

    function animatePreview() {
        if (!previewRenderer) return;
        previewAngle += 0.008;
        if (previewModel) previewModel.rotation.y = previewAngle;
        previewRenderer.render(previewScene, previewCamera);
        requestAnimationFrame(animatePreview);
    }

    /* ---------------- Part row ---------------- */
    function buildPartRow(part, idx) {
        const row = document.createElement('div');
        row.className = 'av-part-row';

        const sel = document.createElement('select');
        PART_PARENTS.forEach(pp => {
            const o = document.createElement('option');
            o.value = pp; o.textContent = pp.toUpperCase();
            if (part.parent === pp) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            workingAvatar.parts[idx].parent = sel.value;
            rebuildPreviewModel();
        });
        row.appendChild(sel);

        const colInp = document.createElement('input');
        colInp.type = 'color';
        colInp.value = part.c;
        colInp.addEventListener('input', () => {
            workingAvatar.parts[idx].c = colInp.value;
            rebuildPreviewModel();
        });
        row.appendChild(colInp);

        for (const [axKey, label, step, min] of [
            ['p', 'XYZ', 0.02, null],
            ['s', 'WHD', 0.02, 0.02],
        ]) {
            const wrap = document.createElement('div');
            wrap.className = 'av-part-inputs';
            ['x', 'y', 'z'].forEach((ax, ai) => {
                const lbl = document.createElement('label');
                const letter = label[ai];
                lbl.textContent = letter;
                const ni = document.createElement('input');
                ni.type = 'number';
                ni.step = step;
                if (min != null) ni.min = min;
                ni.value = part[axKey][ai];
                ni.addEventListener('input', () => {
                    let v = parseFloat(ni.value);
                    if (!isFinite(v)) v = 0;
                    if (axKey === 's') v = Math.max(0.02, v);
                    workingAvatar.parts[idx][axKey][ai] = v;
                    rebuildPreviewModel();
                });
                lbl.appendChild(ni);
                wrap.appendChild(lbl);
            });
            row.appendChild(wrap);
        }

        const del = document.createElement('button');
        del.className = 'av-del';
        del.textContent = '✕';
        del.addEventListener('click', () => {
            workingAvatar.parts.splice(idx, 1);
            renderPartRows();
            rebuildPreviewModel();
        });
        row.appendChild(del);
        return row;
    }

    function renderPartRows() {
        if (!partListEl) return;
        partListEl.innerHTML = '';
        workingAvatar.parts.forEach((p, i) => partListEl.appendChild(buildPartRow(p, i)));
    }

    function renderColors() {
        if (!root) return;
        const rows = root.querySelectorAll('.av-color-row');
        COLOR_KEYS.forEach(({ k }, i) => {
            const row = rows[i];
            if (!row) return;
            const inp = row.querySelector('input[type=color]');
            const hex = row.querySelector('.av-hex');
            if (inp) inp.value = workingAvatar.colors[k] || '#ffffff';
            if (hex) hex.textContent = workingAvatar.colors[k] || '#ffffff';
        });
    }

    /* ---------------- Apply to player ---------------- */
    function applyToPlayer() {
        const Hk = global.ARiveHooks;
        if (!Hk || !Hk.applyAvatar) return;
        try {
            Hk.applyAvatar(
                global.ARiveAvatar.toFpvModelData(workingAvatar),
                global.ARiveAvatar.toRemoteModelData(workingAvatar)
            );
        } catch (e) { console.warn('[Avatar] apply failed:', e); }
    }

    /* ---------------- UI ---------------- */
    function buildUI() {
        root = document.createElement('div');
        root.id = 'avRoot';

        const win = document.createElement('div');
        win.id = 'avWindow';
        root.appendChild(win);

        // header
        const header = document.createElement('div');
        header.className = 'av-header';
        const title = document.createElement('span');
        title.className = 'av-title';
        title.textContent = '◈ AVATAR CUSTOMIZER';
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'av-close';
        closeBtn.textContent = '✕ CLOSE';
        closeBtn.addEventListener('click', close);
        header.appendChild(closeBtn);
        win.appendChild(header);

        // body
        const body = document.createElement('div');
        body.className = 'av-body';
        win.appendChild(body);

        const previewWrap = document.createElement('div');
        previewWrap.className = 'av-preview';
        const lbl = document.createElement('div');
        lbl.className = 'av-preview-label';
        lbl.textContent = 'LIVE PREVIEW';
        previewWrap.appendChild(lbl);
        previewWrap.appendChild(previewCanvas);
        const hint = document.createElement('div');
        hint.className = 'av-preview-hint';
        hint.textContent = 'Auto-rotating · parts show on remote view';
        previewWrap.appendChild(hint);
        body.appendChild(previewWrap);

        const controls = document.createElement('div');
        controls.className = 'av-controls';
        body.appendChild(controls);

        const colT = document.createElement('div');
        colT.className = 'av-section-title';
        colT.textContent = 'COLORS  ·  APPLY TO BOTH VIEWS';
        controls.appendChild(colT);

        COLOR_KEYS.forEach(({ k, label }) => {
            const row = document.createElement('div');
            row.className = 'av-color-row';
            const lb = document.createElement('label');
            lb.textContent = label;
            row.appendChild(lb);
            const inp = document.createElement('input');
            inp.type = 'color';
            inp.addEventListener('input', () => {
                workingAvatar.colors[k] = inp.value;
                const hex = row.querySelector('.av-hex');
                if (hex) hex.textContent = inp.value;
                rebuildPreviewModel();
            });
            row.appendChild(inp);
            const hex = document.createElement('span');
            hex.className = 'av-hex';
            row.appendChild(hex);
            controls.appendChild(row);
        });

        const partT = document.createElement('div');
        partT.className = 'av-section-title';
        partT.textContent = 'CUSTOM PARTS  ·  REMOTE VIEW ONLY';
        controls.appendChild(partT);

        partListEl = document.createElement('div');
        partListEl.className = 'av-parts-list';
        controls.appendChild(partListEl);

        const addBtn = document.createElement('button');
        addBtn.className = 'av-add-part-btn';
        addBtn.textContent = '+ ADD PART';
        addBtn.addEventListener('click', () => {
            workingAvatar.parts.push({
                parent: 'head',
                s: [0.24, 0.06, 0.24],
                p: [0, 0.18, 0],
                c: '#c0c0c0',
            });
            renderPartRows();
            rebuildPreviewModel();
        });
        controls.appendChild(addBtn);

        // footer
        const footer = document.createElement('div');
        footer.className = 'av-footer';
        win.appendChild(footer);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'av-btn';
        resetBtn.textContent = 'RESET';
        resetBtn.addEventListener('click', () => {
            workingAvatar = global.ARiveAvatar.getDefault();
            renderColors();
            renderPartRows();
            rebuildPreviewModel();
        });
        footer.appendChild(resetBtn);

        const applyBtn = document.createElement('button');
        applyBtn.className = 'av-btn';
        applyBtn.textContent = 'APPLY NOW';
        applyBtn.addEventListener('click', () => {
            applyToPlayer();
            setStatus('APPLIED  ·  SAVE TO KEEP');
        });
        footer.appendChild(applyBtn);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'av-btn primary';
        saveBtn.textContent = 'SAVE';
        saveBtn.addEventListener('click', async () => {
            const where = await global.ARiveAvatar.save(workingAvatar);
            setStatus('SAVED  ·  ' + (where === 'cloud' ? 'GOOGLE ACCOUNT' : 'LOCAL ONLY'));
            applyToPlayer();
        });
        footer.appendChild(saveBtn);

        statusEl = document.createElement('span');
        statusEl.className = 'av-status';
        footer.appendChild(statusEl);

        root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
        root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });

        document.body.appendChild(root);
    }

    function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }

    async function open() {
        injectStyles();
        if (!initPreview()) { console.warn('[Avatar] THREE unavailable'); return; }
        if (!root) buildUI();

        workingAvatar = await global.ARiveAvatar.load();
        renderColors();
        renderPartRows();
        rebuildPreviewModel();

        if (!animRunning) { animRunning = true; animatePreview(); }

        const signedIn = !!(global.ARiveAuth && global.ARiveAuth.isSignedIn && global.ARiveAuth.isSignedIn());
        setStatus(signedIn ? 'SIGNED IN  ·  will save to Google account' : 'GUEST  ·  will save locally');
        root.classList.add('open');
    }

    function close() { if (root) root.classList.remove('open'); }
    function toggle() { root && root.classList.contains('open') ? close() : open(); }

    global.AvatarCustomizer = { open, close, toggle };
})(window);