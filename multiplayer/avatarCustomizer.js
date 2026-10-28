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

  const PART_LABELS = {
    head: 'HEAD', torso: 'TORSO', hip: 'HIP',
    armL: 'ARM L', armR: 'ARM R', legL: 'LEG L', legR: 'LEG R',
  };
  const FALLBACK_PART_KEYS = ['head', 'torso', 'hip', 'armL', 'armR', 'legL', 'legR'];
  const RIG_REQUIRED = ['head', 'torso', 'hip', 'armL', 'armR', 'legL', 'legR'];

  const HAIR_STYLES = [
    { id: 'default', name: 'SHORT' },
    { id: 'spiky', name: 'SPIKY' },
    { id: 'mohawk', name: 'MOHAWK' },
    { id: 'long', name: 'LONG' },
    { id: 'cap', name: 'BEANIE' },
    { id: 'bald', name: 'BALD' }
  ];

  const DRAG_YAW = 0.012;
  const DAMPING = 0.92;
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 2.5;

  let root = null;
  let previewRenderer = null, previewScene = null, previewCamera = null, previewModel = null;
  let previewCanvas = null;
  let rafId = null;

  let rotY = 0;
  let velY = 0;
  let dragging = false, lastPX = 0;

  let workingAvatar = null;
  let statusEl = null;
  let scaleListEl = null;
  let hairSelectEl = null;
  let warnedNoPartNames = false;

  let undoStack = [];
  let snapshot = null;

  function H() { return global.ARiveHooks || {}; }

  function partKeys() {
    const A = global.ARiveAvatar;
    return (A && Array.isArray(A.SCALE_KEYS)) ? A.SCALE_KEYS : FALLBACK_PART_KEYS;
  }
  function scaleMin() {
    const A = global.ARiveAvatar;
    return (A && typeof A.SCALE_MIN === 'number') ? A.SCALE_MIN : 0.5;
  }
  function scaleMax() {
    const A = global.ARiveAvatar;
    return (A && typeof A.SCALE_MAX === 'number') ? A.SCALE_MAX : 2.5;
  }
  function labelFor(k) { return PART_LABELS[k] || String(k).toUpperCase(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------- Undo Logic ---------------- */
  function takeSnapshot() {
    if (!workingAvatar) return;
    snapshot = JSON.parse(JSON.stringify(workingAvatar));
  }

  function commitUndo() {
    if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(workingAvatar)) {
      undoStack.push(snapshot);
      if (undoStack.length > 50) undoStack.shift();
    }
    snapshot = null;
  }

  function performUndo() {
    if (undoStack.length === 0) {
      setStatus('NOTHING TO UNDO');
      return;
    }
    workingAvatar = undoStack.pop();
    ensureScales(workingAvatar);
    renderSettings();
    renderScaleRows();
    rebuildPreviewModel();
    setStatus('UNDO  ·  ' + undoStack.length + ' STEPS LEFT');
  }

  /* ---------------- Styles ---------------- */
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
  position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.av-preview canvas { display:block; cursor:grab; touch-action:none;
  -webkit-user-select:none; user-select:none; }
.av-preview canvas.grabbing { cursor:grabbing; }
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
.av-select { flex:1 1 auto; background:#05070a; color:#e8c86a; font:bold 10px 'Courier New',monospace; border:2px solid #2b333f; padding:5px; cursor:pointer; outline:none; }
.av-select:hover { border-color:#e8c86a; }

.av-scale-list { display:flex; flex-direction:column; gap:6px; }
.av-scale-row { display:flex; align-items:center; gap:8px; padding:7px 10px;
  background:#12161d; border:1px solid #2b333f; }
.av-scale-name { flex:0 0 56px; font:bold 10px 'Courier New',monospace;
  letter-spacing:1px; color:#a89a84; }
.av-scale-axes { flex:1 1 auto; display:flex; gap:8px; min-width:0; }
.av-axis { flex:1 1 0; display:flex; align-items:center; gap:3px; min-width:0; }
.av-axis-lbl { flex:0 0 12px; font:bold 9px 'Courier New',monospace;
  color:#6a5a44; letter-spacing:1px; }
.av-range-sm { -webkit-appearance:none; appearance:none; flex:1 1 auto;
  min-width:20px; height:14px; margin:0; background:transparent; cursor:ew-resize; }
.av-range-sm:focus { outline:none; }
.av-range-sm::-webkit-slider-runnable-track { height:6px; border:1px solid #2b333f;
  background:linear-gradient(to right,#e8c86a var(--fill,50%),#05070a var(--fill,50%)); }
.av-range-sm::-webkit-slider-thumb { -webkit-appearance:none; appearance:none;
  width:8px; height:14px; margin-top:-5px; background:#e8c86a; border:1px solid #0d1016; }
.av-range-sm:hover::-webkit-slider-thumb { background:#f6dd8b; }
.av-range-sm:focus::-webkit-slider-thumb { box-shadow:0 0 0 2px rgba(232,200,106,.35); }
.av-range-sm::-moz-range-track { height:6px; border:1px solid #2b333f; background:#05070a; }
.av-range-sm::-moz-range-progress { height:6px; background:#e8c86a; }
.av-range-sm::-moz-range-thumb { width:8px; height:14px; background:#e8c86a;
  border:1px solid #0d1016; border-radius:0; }
.av-axis-val { flex:0 0 32px; text-align:right; font:9px 'Courier New',monospace;
  color:#e8c86a; letter-spacing:0; }
.av-scale-reset { flex:0 0 auto; background:transparent; border:1px solid #2b333f;
  color:#6a5a44; font:bold 10px 'Courier New',monospace; padding:2px 6px; cursor:pointer; }
.av-scale-reset:hover { color:#e8c86a; border-color:#e8c86a; }

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

    bindPreviewInteraction();
    return true;
  }

  /* ---------------- Drag + Zoom ---------------- */
  function bindPreviewInteraction() {
    if (!previewCanvas) return;

    previewCanvas.addEventListener('pointerdown', (e) => {
      if (!previewModel) return;
      e.preventDefault();
      dragging = true;
      lastPX = e.clientX;
      velY = 0;
      previewCanvas.classList.add('grabbing');
      try { previewCanvas.setPointerCapture(e.pointerId); } catch (_) { }
    });

    previewCanvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastPX;
      lastPX = e.clientX;
      rotY += dx * DRAG_YAW;
      velY = dx * DRAG_YAW;
      applyRotation();
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      previewCanvas.classList.remove('grabbing');
      try { previewCanvas.releasePointerCapture(e.pointerId); } catch (_) { }
    };
    previewCanvas.addEventListener('pointerup', endDrag);
    previewCanvas.addEventListener('pointercancel', endDrag);

    previewCanvas.addEventListener('dblclick', () => {
      rotY = 0; velY = 0;
      applyRotation();
    });

    previewCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.08 : 0.92;
      const z = clamp(previewCamera.zoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (z !== previewCamera.zoom) {
        previewCamera.zoom = z;
        previewCamera.updateProjectionMatrix();
      }
    }, { passive: false });
  }

  function applyRotation() {
    if (previewModel) previewModel.rotation.set(0, rotY, 0);
  }

  /* ---------------- Part Classification & Rigging ---------------- */
  function normName(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function keyMatch(raw) {
    const n = normName(raw);
    if (!n) return null;

    if (n === 'leftarm' || n === 'arml') return 'armL';
    if (n === 'rightarm' || n === 'armr') return 'armR';
    if (n === 'leftleg' || n === 'legl') return 'legL';
    if (n === 'rightleg' || n === 'legr') return 'legR';
    if (n === 'body' || n === 'chest' || n === 'torso') return 'torso';
    if (n === 'pelvis' || n === 'waist' || n === 'hip') return 'hip';
    if (n === 'head') return 'head';

    const keys = partKeys();
    for (let i = 0; i < keys.length; i++) {
      if (normName(keys[i]) === n) return keys[i];
    }
    return null;
  }

  function partKeyOf(obj) {
    const n = keyMatch(obj.name);
    if (n) return n;
    const ud = obj.userData;
    if (ud) return keyMatch(ud.part || ud.bodyPart || ud.id || ud.name);
    return null;
  }

  function classifyParts() {
    if (!previewModel) return 0;
    const found = {};

    previewModel.traverse(o => {
      if (o.userData.__partKey && !found[o.userData.__partKey]) {
        found[o.userData.__partKey] = o;
      } else {
        const key = partKeyOf(o);
        if (key && !found[key]) {
          o.userData.__partKey = key;
          found[key] = o;
        }
      }
    });

    return Object.keys(found).length;
  }

  function computeVisibleBoundingBox(obj) {
    const THREE = window.THREE || (H() && H().THREE);
    if (!THREE) return new THREE.Box3();

    const box = new THREE.Box3();
    box.makeEmpty();

    obj.updateMatrixWorld(true);

    obj.traverse((child) => {
      if (child.isMesh && child.visible) {
        let visible = true;
        let p = child;
        while (p && p !== obj.parent) {
          if (p.visible === false) { visible = false; break; }
          p = p.parent;
        }
        if (visible) {
          if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
          const tempBox = new THREE.Box3().copy(child.geometry.boundingBox).applyMatrix4(child.matrixWorld);
          box.union(tempBox);
        }
      }
    });
    return box;
  }

  function getRigInfo() {
    if (!previewModel) return null;
    if (previewModel.userData.__rigInfo) return previewModel.userData.__rigInfo;

    const THREE = window.THREE || (H() && H().THREE);
    if (!THREE) return null;

    classifyParts();

    const parts = {};
    previewModel.traverse(c => {
      const k = c.userData.__partKey;
      if (k && !parts[k]) parts[k] = c;
    });

    RIG_REQUIRED.forEach(k => {
      const p = parts[k];
      if (p && p.parent !== previewModel) {
        previewModel.add(p);
      }
    });

    const info = { allPartsFound: false };

    for (const k in parts) {
      const obj = parts[k];
      const savedPos = obj.position.clone();
      const savedRot = obj.rotation.clone();
      const savedScale = obj.scale.clone();

      obj.position.set(0, 0, 0);
      obj.rotation.set(0, 0, 0);
      obj.scale.set(1, 1, 1);
      obj.updateMatrixWorld(true);

      const box = computeVisibleBoundingBox(obj);

      info[k] = {
        key: k,
        obj,
        basePos: savedPos,
        baseScale: savedScale,
        gMin: {
          x: box.min.x, y: box.min.y, z: box.min.z,
        },
        gMax: {
          x: box.max.x, y: box.max.y, z: box.max.z,
        },
      };

      obj.position.copy(savedPos);
      obj.rotation.copy(savedRot);
      obj.scale.copy(savedScale);
      obj.updateMatrixWorld(true);
    }

    info.allPartsFound = RIG_REQUIRED.every(k => !!info[k]);
    previewModel.userData.__rigInfo = info;
    return info;
  }

  function readScale(key) {
    const s = workingAvatar && workingAvatar.scales;
    const v = s ? s[key] : null;
    if (!v || typeof v !== 'object') return { x: 1, y: 1, z: 1 };
    return {
      x: (typeof v.x === 'number' && isFinite(v.x)) ? v.x : 1,
      y: (typeof v.y === 'number' && isFinite(v.y)) ? v.y : 1,
      z: (typeof v.z === 'number' && isFinite(v.z)) ? v.z : 1,
    };
  }

  function applyRigLayout() {
    if (!previewModel || !workingAvatar) return false;

    const info = getRigInfo();
    if (!info || !info.allPartsFound) return false;

    const hip = info.hip, torso = info.torso, head = info.head;
    const armL = info.armL, armR = info.armR, legL = info.legL, legR = info.legR;

    const sHip = readScale('hip');
    const sTorso = readScale('torso');
    const sHead = readScale('head');
    const sArmL = readScale('armL');
    const sArmR = readScale('armR');
    const sLegL = readScale('legL');
    const sLegR = readScale('legR');

    // HIP
    if (hip) hip.obj.position.copy(hip.basePos);

    let torsoNewY = torso ? torso.basePos.y : 0;
    let torsoTopY = 0, torsoLeftX = 0, torsoRightX = 0, torsoBaseTopY = 0, torsoBottomY = 0;

    // TORSO
    if (torso) {
      let hipTopY = hip ? hip.basePos.y : 0;
      if (hip && (hip.gMax.y - hip.gMin.y) > 0.001) {
        hipTopY = hip.basePos.y + hip.gMax.y * sHip.y;
      }
      torsoNewY = hipTopY - torso.gMin.y * sTorso.y;
      torso.obj.position.set(torso.basePos.x, torsoNewY, torso.basePos.z);

      torsoTopY = torsoNewY + torso.gMax.y * sTorso.y;
      torsoBottomY = torsoNewY + torso.gMin.y * sTorso.y;
      torsoLeftX = torso.basePos.x + torso.gMin.x * sTorso.x;
      torsoRightX = torso.basePos.x + torso.gMax.x * sTorso.x;
      torsoBaseTopY = torso.basePos.y + torso.gMax.y;
    }

    // HEAD
    if (head && torso) {
      const headNewY = torsoTopY - head.gMin.y * sHead.y;
      head.obj.position.set(torso.basePos.x, headNewY, torso.basePos.z);
    } else if (head) {
      head.obj.position.copy(head.basePos);
    }

    // ARM L
    if (armL && torso) {
      const armLTopY = torsoTopY + ((armL.basePos.y + armL.gMax.y) - torsoBaseTopY);
      const torsoLeftDeltaX = torsoLeftX - (torso.basePos.x + torso.gMin.x);
      armL.obj.position.set(
        armL.basePos.x + torsoLeftDeltaX,
        armLTopY - armL.gMax.y * sArmL.y,
        armL.basePos.z
      );
    } else if (armL) {
      armL.obj.position.copy(armL.basePos);
    }

    // ARM R
    if (armR && torso) {
      const armRTopY = torsoTopY + ((armR.basePos.y + armR.gMax.y) - torsoBaseTopY);
      const torsoRightDeltaX = torsoRightX - (torso.basePos.x + torso.gMax.x);
      armR.obj.position.set(
        armR.basePos.x + torsoRightDeltaX,
        armRTopY - armR.gMax.y * sArmR.y,
        armR.basePos.z
      );
    } else if (armR) {
      armR.obj.position.copy(armR.basePos);
    }

    // LEGS
    let legBottomY = torsoBottomY;
    if (hip && (hip.gMax.y - hip.gMin.y) > 0.001) {
      legBottomY = hip.basePos.y + hip.gMin.y * sHip.y;
    } else if (hip) {
      legBottomY = hip.basePos.y;
    } else {
      legBottomY = torso.basePos.y + torso.gMin.y * sTorso.y;
    }

    if (legL) {
      legL.obj.position.set(legL.basePos.x, legBottomY - legL.gMax.y * sLegL.y, legL.basePos.z);
    }
    if (legR) {
      legR.obj.position.set(legR.basePos.x, legBottomY - legR.gMax.y * sLegR.y, legR.basePos.z);
    }

    // Apply scales
    const apply = (p, sc) => {
      if (!p || !p.obj) return;
      p.obj.scale.set(p.baseScale.x * sc.x, p.baseScale.y * sc.y, p.baseScale.z * sc.z);
    };
    apply(hip, sHip); apply(torso, sTorso); apply(head, sHead);
    apply(armL, sArmL); apply(armR, sArmR);
    apply(legL, sLegL); apply(legR, sLegR);

    previewModel.updateMatrixWorld(true);
    return true;
  }

  function applySimpleScales() {
    if (!previewModel || !workingAvatar) return;
    previewModel.traverse((o) => {
      const k = o.userData.__partKey;
      if (!k) return;
      const sc = readScale(k);
      if (!o.userData.__baseScale) o.userData.__baseScale = o.scale.clone();
      const b = o.userData.__baseScale;
      o.scale.set(b.x * sc.x, b.y * sc.y, b.z * sc.z);
    });
  }

  function applyScalesToPreview() {
    if (!previewModel || !workingAvatar || !workingAvatar.scales) return;
    if (applyRigLayout()) return;

    applySimpleScales();
    if (!warnedNoPartNames) {
      warnedNoPartNames = true;
      const names = [];
      previewModel.traverse(o => { if (o.name) names.push(o.name); });
      console.warn('[Avatar] Could not identify all 7 body parts. Sliders will ' +
        'change sizes but parts may not stay connected.');
    }
  }

  /* ---------------- Preview model ---------------- */
  function rebuildPreviewModel() {
    if (!previewRenderer) return;
    if (previewModel) {
      previewScene.remove(previewModel);
      previewModel = null;
    }
    const Hk = global.ARiveHooks;
    if (!Hk || !Hk.buildRemotePlayerMesh) return;
    if (!global.ARiveAvatar) return;

    const data = global.ARiveAvatar.toRemoteModelData(workingAvatar);
    if (data && data.scales) data.scales = {};

    const model = Hk.buildRemotePlayerMesh(data);
    previewModel = (model && model.group) ? model.group : model;
    if (!previewModel) return;

    applyRotation();
    previewScene.add(previewModel);
    applyScalesToPreview();
  }

  /* ---------------- Render loop ---------------- */
  function startLoop() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function tick() {
    if (!root || !root.classList.contains('open')) { rafId = null; return; }

    if (!dragging && velY !== 0) {
      rotY += velY;
      velY *= DAMPING;
      if (Math.abs(velY) < 0.0005) velY = 0;
      applyRotation();
    }

    try {
      previewRenderer.render(previewScene, previewCamera);
    } catch (e) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  /* ---------------- Scale row ---------------- */
  function buildScaleRow(key) {
    const min = scaleMin();
    const max = scaleMax();

    const row = document.createElement('div');
    row.className = 'av-scale-row';

    const name = document.createElement('span');
    name.className = 'av-scale-name';
    name.textContent = labelFor(key);
    row.appendChild(name);

    const axes = document.createElement('div');
    axes.className = 'av-scale-axes';
    row.appendChild(axes);

    const refs = {};

    [['x', 'W', 'Width'], ['y', 'H', 'Height'], ['z', 'D', 'Depth']].forEach(([axis, short, full]) => {
      const wrap = document.createElement('label');
      wrap.className = 'av-axis';
      wrap.title = full + ' (' + axis.toUpperCase() + ')';

      const lbl = document.createElement('span');
      lbl.className = 'av-axis-lbl';
      lbl.textContent = short;
      wrap.appendChild(lbl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'av-range-sm';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '0.01';
      wrap.appendChild(slider);

      const val = document.createElement('span');
      val.className = 'av-axis-val';
      wrap.appendChild(val);

      axes.appendChild(wrap);
      refs[axis] = { slider, val };

      slider.addEventListener('pointerdown', takeSnapshot);
      slider.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) takeSnapshot(); });
      slider.addEventListener('change', commitUndo);
    });

    const reset = document.createElement('button');
    reset.className = 'av-scale-reset';
    reset.textContent = '↺';
    row.appendChild(reset);

    function paint() {
      const sc = readScale(key);
      ['x', 'y', 'z'].forEach(axis => {
        const v = sc[axis];
        const pct = ((v - min) / (max - min)) * 100;
        const ref = refs[axis];
        ref.slider.value = String(v);
        ref.slider.style.setProperty('--fill', pct.toFixed(1) + '%');
        ref.val.textContent = v.toFixed(2);
      });
    }

    function commit(axis, v) {
      if (!workingAvatar.scales[key] || typeof workingAvatar.scales[key] !== 'object') {
        workingAvatar.scales[key] = { x: 1, y: 1, z: 1 };
      }
      workingAvatar.scales[key][axis] = clamp(v, min, max);
      paint();
      applyScalesToPreview();
    }

    ['x', 'y', 'z'].forEach(axis => {
      refs[axis].slider.addEventListener('input', () => {
        let v = parseFloat(refs[axis].slider.value);
        if (!isFinite(v)) v = 1;
        commit(axis, v);
      });
    });

    reset.addEventListener('click', () => {
      takeSnapshot();
      workingAvatar.scales[key] = { x: 1, y: 1, z: 1 };
      paint();
      applyScalesToPreview();
      commitUndo();
    });

    paint();
    return row;
  }

  function ensureScales(av) {
    if (!av.scales || typeof av.scales !== 'object') av.scales = {};
    partKeys().forEach(k => {
      const v = av.scales[k];
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        av.scales[k] = { x: 1, y: 1, z: 1 };
      } else {
        if (typeof v.x !== 'number' || !isFinite(v.x)) v.x = 1;
        if (typeof v.y !== 'number' || !isFinite(v.y)) v.y = 1;
        if (typeof v.z !== 'number' || !isFinite(v.z)) v.z = 1;
      }
    });
  }

  function renderScaleRows() {
    if (!scaleListEl) return;
    scaleListEl.innerHTML = '';
    partKeys().filter(k => k !== 'hip').forEach(k => scaleListEl.appendChild(buildScaleRow(k)));
  }

  function renderSettings() {
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
    if (hairSelectEl) {
      hairSelectEl.value = workingAvatar.hairStyle || 'default';
    }
  }

  /* ---------------- Apply to player ---------------- */
  function broadcastAvatarToPeers() {
    if (!global.ARiveMP || typeof global.ARiveMP.onLocalAvatarChanged !== 'function') return;
    try {
      const raw = global.ARiveAvatar.normalize(workingAvatar);
      global.ARiveMP.onLocalAvatarChanged(raw);
    } catch (e) {
      console.warn('[Avatar] broadcast failed:', e);
    }
  }

  function applyToPlayer() {
    const Hk = global.ARiveHooks;
    if (!Hk || !Hk.applyAvatar) return;
    try {
      Hk.applyAvatar(
        global.ARiveAvatar.toFpvModelData(workingAvatar),
        global.ARiveAvatar.toRemoteModelData(workingAvatar)
      );
      broadcastAvatarToPeers();
    } catch (e) { console.warn('[Avatar] apply failed:', e); }
  }

  /* ---------------- UI ---------------- */
  function buildUI() {
    root = document.createElement('div');
    root.id = 'avRoot';

    const win = document.createElement('div');
    win.id = 'avWindow';
    root.appendChild(win);

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
    hint.textContent = 'DRAG ROTATE · SCROLL ZOOM · DBL-CLICK RESET';
    previewWrap.appendChild(hint);
    body.appendChild(previewWrap);

    const controls = document.createElement('div');
    controls.className = 'av-controls';
    body.appendChild(controls);

    // colors
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

      inp.addEventListener('pointerdown', takeSnapshot);
      inp.addEventListener('input', () => {
        workingAvatar.colors[k] = inp.value;
        const hex = row.querySelector('.av-hex');
        if (hex) hex.textContent = inp.value;
        rebuildPreviewModel();
      });
      inp.addEventListener('change', commitUndo);

      row.appendChild(inp);
      const hex = document.createElement('span');
      hex.className = 'av-hex';
      row.appendChild(hex);
      controls.appendChild(row);
    });

    // hair style
    const hairT = document.createElement('div');
    hairT.className = 'av-section-title';
    hairT.textContent = 'HAIR STYLE';
    controls.appendChild(hairT);

    const hairRow = document.createElement('div');
    hairRow.className = 'av-color-row';
    const hairLbl = document.createElement('label');
    hairLbl.textContent = 'STYLE';
    hairRow.appendChild(hairLbl);

    hairSelectEl = document.createElement('select');
    hairSelectEl.className = 'av-select';
    HAIR_STYLES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      hairSelectEl.appendChild(opt);
    });

    hairSelectEl.addEventListener('pointerdown', takeSnapshot);
    hairSelectEl.addEventListener('change', () => {
      workingAvatar.hairStyle = hairSelectEl.value;
      rebuildPreviewModel();
      commitUndo();
    });

    hairRow.appendChild(hairSelectEl);
    controls.appendChild(hairRow);

    // body size
    const sizeT = document.createElement('div');
    sizeT.className = 'av-section-title';
    sizeT.textContent = 'BODY SIZE  ·  W (WIDTH) / H (HEIGHT) / D (DEPTH)';
    controls.appendChild(sizeT);

    scaleListEl = document.createElement('div');
    scaleListEl.className = 'av-scale-list';
    controls.appendChild(scaleListEl);

    const footer = document.createElement('div');
    footer.className = 'av-footer';
    win.appendChild(footer);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'av-btn';
    resetBtn.textContent = 'RESET';
    resetBtn.addEventListener('click', () => {
      takeSnapshot();
      workingAvatar = global.ARiveAvatar.getDefault();
      ensureScales(workingAvatar);
      rotY = 0;
      velY = 0;
      if (previewCamera) {
        previewCamera.zoom = 1;
        previewCamera.updateProjectionMatrix();
      }
      renderSettings();
      renderScaleRows();
      rebuildPreviewModel();
      setStatus('RESET  ·  NOT SAVED YET');
      commitUndo();
    });
    footer.appendChild(resetBtn);

    const undoBtn = document.createElement('button');
    undoBtn.className = 'av-btn';
    undoBtn.textContent = '↶ UNDO';
    undoBtn.addEventListener('click', performUndo);
    footer.appendChild(undoBtn);

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
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); performUndo(); }
    });

    document.body.appendChild(root);
  }

  function setStatus(text) { if (statusEl) statusEl.textContent = text || ''; }

  async function open() {
    injectStyles();
    if (!initPreview()) { console.warn('[Avatar] THREE unavailable'); return; }
    if (!root) buildUI();

    undoStack = [];
    snapshot = null;
    rotY = 0;
    velY = 0;
    if (previewCamera) {
      previewCamera.zoom = 1;
      previewCamera.updateProjectionMatrix();
    }

    workingAvatar = await global.ARiveAvatar.load();
    ensureScales(workingAvatar);

    renderSettings();
    renderScaleRows();
    rebuildPreviewModel();

    const signedIn = !!(global.ARiveAuth && global.ARiveAuth.isSignedIn && global.ARiveAuth.isSignedIn());
    setStatus(signedIn ? 'SIGNED IN  ·  will save to Google account' : 'GUEST  ·  will save locally');

    root.classList.add('open');
    startLoop();
  }

  function close() {
    if (root) root.classList.remove('open');
    dragging = false;
    velY = 0;
    stopLoop();
  }

  function toggle() { root && root.classList.contains('open') ? close() : open(); }

  global.AvatarCustomizer = { open, close, toggle };
})(window);