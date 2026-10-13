/* =========================================================================
   ARive — fine‑voxel voxel survival (Teardown‑esque)
   -------------------------------------------------------------------------

   • 0.10 m voxels · 256 × 96 × 256 grid = 6,291,456 voxels
   • Naive meshing with per-vertex ambient occlusion (kills the block look)
   • Procedural white-noise texture applied with world-space UVs
   • Warm sun + cool ambient + hemisphere light for depth
   • Robust pointer-lock handling (no silent pause on failure)
   ========================================================================= */
(function () {
  "use strict";
  const Minimap = window.Minimap;

  /* =========================================================================
       1. HELPERS
       ========================================================================= */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash3(x, y, z) {
    let h =
      Math.imul(x | 0, 374761393) ^
      Math.imul(y | 0, 668265263) ^
      Math.imul(z | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* =========================================================================
       2. WORLD CONSTANTS  — 0.10 m voxels
       ========================================================================= */
  const VOXEL = 0.1;
  const SX = 1536,
    SY = 96,
    SZ = 1536; // 226 MB — 4× the area

  const CHUNK = 32;
  const CHUNKS_X = SX / CHUNK; // 8
  const CHUNKS_Y = Math.ceil(SY / CHUNK); // 3
  const CHUNKS_Z = SZ / CHUNK; // 8
  const WORLD_W = SX * VOXEL; // 25.6 m
  const WORLD_H = SY * VOXEL; // 9.6 m
  const WORLD_D = SZ * VOXEL; // 25.6 m

  /* ---- Edge-of-world atmospheric fade ---- */
  const EDGE_MARGIN = 8; // metres from the edge where the fade starts
  const EDGE_FOG_NEAR_MIN = 1.5; // fog near-plane at the very edge
  const EDGE_FOG_FAR_MIN = 8; // fog far-plane at the very edge

  const GRAVITY = 22;
  const EPS = 1e-4;

  const UV_SCALE = 0.4; // texture tile = 2.5 m → at 0.1 m voxel, ~4 texels/voxel
  const CHARGE_RADIUS = 1.5; // metres — change this one number

  /* ============================================================
   SANDBOX BOUNDS
   ============================================================ */
  const SANDBOX_HALF_CHUNKS = 8;
  const SANDBOX_CX0 = (CHUNKS_X >> 1) - SANDBOX_HALF_CHUNKS;
  const SANDBOX_CX1 = (CHUNKS_X >> 1) + SANDBOX_HALF_CHUNKS;
  const SANDBOX_CZ0 = (CHUNKS_Z >> 1) - SANDBOX_HALF_CHUNKS;
  const SANDBOX_CZ1 = (CHUNKS_Z >> 1) + SANDBOX_HALF_CHUNKS;
  const SANDBOX_MIN_X = SANDBOX_CX0 * CHUNK * VOXEL;
  const SANDBOX_MAX_X = SANDBOX_CX1 * CHUNK * VOXEL;
  const SANDBOX_MIN_Z = SANDBOX_CZ0 * CHUNK * VOXEL;
  const SANDBOX_MAX_Z = SANDBOX_CZ1 * CHUNK * VOXEL;

  /* ============================================================
   PLAYER SIZE
   ============================================================ */
  const PLAYER_SCALE = 0.85;

  /* ============================================================
   CROUCH (C)
   ============================================================ */
  const CROUCH_MUL = 0.55;
  const CROUCH_SPEED_MUL = 0.45;

  /* =========================================================================
   SETTINGS  (persisted to localStorage)
   ========================================================================= */
  const SETTINGS_KEY = "arive-settings-v1";
  const settings = Object.assign(
    {
      sensitivity: 1.0,
      viewChunks: 6,
      masterVolume: 1.0,
      seVolume: 1.0,
    },
    (() => {
      try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
      } catch (e) {
        return {};
      }
    })(),
  );

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { }
  }

  /* =========================================================================
       3. VOXEL STORAGE
       ========================================================================= */
  const voxels = new Uint8Array(SX * SY * SZ);
  const chunkCounts = new Uint32Array(CHUNKS_X * CHUNKS_Y * CHUNKS_Z);
  const vIdx = (x, y, z) => x + SX * (z + SZ * y);
  const cIdx = (cx, cy, cz) => cx + cy * CHUNKS_X + cz * CHUNKS_X * CHUNKS_Y;

  function getV(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return 0;
    return voxels[vIdx(x, y, z)];
  }
  function setVRaw(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return;
    const i = vIdx(x, y, z);
    const old = voxels[i];
    if (old === v) return;
    voxels[i] = v;
    const ci = cIdx((x / CHUNK) | 0, (y / CHUNK) | 0, (z / CHUNK) | 0);
    if (v === 0) chunkCounts[ci]--;
    else if (old === 0) chunkCounts[ci]++;
  }

  /* =========================================================================
       4. BLOCK TYPES
       ========================================================================= */
  const BLOCKS = {
    1: { name: "Asphalt", color: 0x35353b, strength: 1 },
    2: { name: "Concrete", color: 0x9a9a92, strength: 3 },
    3: { name: "Brick", color: 0x8c4637, strength: 2 },
    4: { name: "Glass", color: 0x7ab8cc, strength: 1, transparent: 1 },
    5: { name: "Plaster", color: 0xc0c0b8, strength: 1 },
    6: { name: "Wood", color: 0x6a4824, strength: 1, flammable: 1 },
    7: { name: "Metal", color: 0x7a8088, strength: 4 },
    8: { name: "Dirt", color: 0x54412f, strength: 1 },
    9: { name: "Grass", color: 0x46632e, strength: 1, flammable: 1 },
    10: { name: "Rubble", color: 0x60564b, strength: 1 },
    11: { name: "Rust", color: 0x8a5634, strength: 2 },
    12: { name: "Sand", color: 0xa89468, strength: 1 },
    13: { name: "Barrel", color: 0xb03024, strength: 2, explosive: 1 },
    14: { name: "Plank", color: 0x5a3e20, strength: 1, flammable: 1 },
    15: { name: "Tar", color: 0x202024, strength: 2 },

    16: { name: "Paint Red", color: 0xa83030, strength: 1 },
    17: { name: "Paint Blue", color: 0x2a4a9a, strength: 1 },
    18: { name: "Paint Yellow", color: 0xd0a030, strength: 1 },
    19: { name: "Paint Green", color: 0x3a7a3a, strength: 1 },
    20: { name: "Paint White", color: 0xe8e8e0, strength: 1 },
    21: { name: "Paint Black", color: 0x1a1a1c, strength: 1 },

    22: { name: "Cobblestone", color: 0x6a6a66, strength: 3 },
    23: { name: "Stone Brick", color: 0x8a8a80, strength: 3 },
    24: { name: "Marble", color: 0xd8d4c8, strength: 3 },

    25: { name: "Dark Wood", color: 0x3a2418, strength: 1, flammable: 1 },
    26: { name: "Steel", color: 0xa0a8b0, strength: 4 },
    27: { name: "Copper", color: 0x6a8a70, strength: 2 },
    28: { name: "Terracotta", color: 0xb06040, strength: 2 },

    29: { name: "Roof Shingle", color: 0x4a3a2a, strength: 1, flammable: 1 },
    30: { name: "Tile Floor", color: 0xb8b8b0, strength: 2 },
    31: { name: "Carpet Red", color: 0x8a2a2a, strength: 1, flammable: 1 },
    32: { name: "Carpet Blue", color: 0x2a3a7a, strength: 1, flammable: 1 },

    33: { name: "Hedge", color: 0x2a5a2a, strength: 1, flammable: 1 },
    34: { name: "Sandstone", color: 0xc8b488, strength: 2 },

    35: { name: "Neon Cyan", color: 0x40e0e0, strength: 1 },
    36: { name: "Neon Magenta", color: 0xe040a0, strength: 1 },
  };

  /* =========================================================================
       5. NOISE TEXTURE
       ========================================================================= */
  function makeNoiseTexture() {
    const SIZE = 128;
    const cv = document.createElement("canvas");
    cv.width = SIZE;
    cv.height = SIZE;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(SIZE, SIZE);
    const rng = mulberry32(0xabcd);

    const fine = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < fine.length; i++) fine[i] = rng();

    const CG = 16;
    const coarse = new Float32Array(CG * CG);
    for (let i = 0; i < coarse.length; i++) coarse[i] = rng();

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const fx = (x / SIZE) * CG;
        const fy = (y / SIZE) * CG;
        const ix = Math.floor(fx),
          iy = Math.floor(fy);
        const tx = fx - ix,
          ty = fy - iy;
        const x0 = ix % CG,
          x1 = (ix + 1) % CG;
        const y0 = iy % CG,
          y1 = (iy + 1) % CG;
        const v00 = coarse[y0 * CG + x0],
          v10 = coarse[y0 * CG + x1];
        const v01 = coarse[y1 * CG + x0],
          v11 = coarse[y1 * CG + x1];
        const c =
          v00 * (1 - tx) * (1 - ty) +
          v10 * tx * (1 - ty) +
          v01 * (1 - tx) * ty +
          v11 * tx * ty;
        const f = fine[y * SIZE + x];
        const v = c * 0.55 + f * 0.45;
        const b = Math.floor(150 + v * 105);
        const i = (y * SIZE + x) * 4;
        img.data[i] = b;
        img.data[i + 1] = b;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  /* =========================================================================
       6. FACE DEFINITIONS
       ========================================================================= */
  const FACES = [
    { n: [1, 0, 0], shade: 0.86, c: [[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1]] },
    { n: [-1, 0, 0], shade: 0.86, c: [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]] },
    { n: [0, 1, 0], shade: 1.0, c: [[0, 1, 0], [0, 1, 1], [1, 1, 0], [1, 1, 1]] },
    { n: [0, -1, 0], shade: 0.55, c: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] },
    { n: [0, 0, 1], shade: 0.74, c: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] },
    { n: [0, 0, -1], shade: 0.74, c: [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0]] },
  ];

  /* =========================================================================
       7. AMBIENT OCCLUSION
       ========================================================================= */
  function computeFaceAO(vx, vy, vz, faceIdx, out) {
    const face = FACES[faceIdx];
    const n = face.n;
    const ox = vx + n[0],
      oy = vy + n[1],
      oz = vz + n[2];

    let a1, a2;
    if (n[0] !== 0) {
      a1 = 1;
      a2 = 2;
    } else if (n[1] !== 0) {
      a1 = 0;
      a2 = 2;
    } else {
      a1 = 0;
      a2 = 1;
    }

    for (let k = 0; k < 4; k++) {
      const cnr = face.c[k];
      const c1 = cnr[a1],
        c2 = cnr[a2];
      const s1 = c1 === 0 ? -1 : 1;
      const s2 = c2 === 0 ? -1 : 1;

      const nb1 = [0, 0, 0];
      nb1[a1] = s1;
      const nb2 = [0, 0, 0];
      nb2[a2] = s2;
      const nb3 = [0, 0, 0];
      nb3[a1] = s1;
      nb3[a2] = s2;

      const side1 = getV(ox + nb1[0], oy + nb1[1], oz + nb1[2]) ? 1 : 0;
      const side2 = getV(ox + nb2[0], oy + nb2[1], oz + nb2[2]) ? 1 : 0;
      const corner = getV(ox + nb3[0], oy + nb3[1], oz + nb3[2]) ? 1 : 0;

      const ao = side1 && side2 ? 0 : 3 - (side1 + side2 + corner);
      out[k] = ao / 3;
    }
  }

  /* =========================================================================
       8. THREE.JS SETUP
       ========================================================================= */
  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });
  const RES_SCALE = 0.62;

  const scene = new THREE.Scene();
  const SKY = 0xa08060;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 14, 42);

  const camera = new THREE.PerspectiveCamera(76, 1, 0.04, 200);
  camera.rotation.order = "YXZ";

  /* =========================================================================
       8.1  FIRST-PERSON VIEW MODEL
       ========================================================================= */

  const FP_MODEL = window.PLAYER_MODEL_DATA || {
    colors: {
      skin: 0xd4a686,
      pants: 0x2a3a4a,
      boot: 0x18181a,
      sleeve: 0x3a4a30,
    },

    body: {
      hipY: 0.53,
      legLen: 0.42,
      legW: 0.12,
      legD: 0.15,
      legSpread: 0.1,

      bootW: 0.17,
      bootH: 0.095,
      bootD: 0.24,
      bootOffZ: -0.025,

      torsoW: 0.38,
      torsoH: 0.72,
      torsoD: 0.17,
      torsoY: 0.86,

      eyeX: 0.01,
      eyeY: 1.27,
      eyeZ: -0.15,
    },

    hands: {
      L: { x: -0.32, y: -0.3, z: -0.34, rx: -0.22, ry: 0, rz: 0.16 },
      R: { x: 0.28, y: -0.28, z: -0.32, rx: -0.26, ry: 0, rz: -0.14 },

      sleeveW: 0.11,
      sleeveH: 0.11,
      sleeveL: 0.3,

      palmW: 0.12,
      palmH: 0.13,
      palmD: 0.14,

      thumbW: 0.04,
      thumbH: 0.05,
      thumbD: 0.07,
      thumbX: -0.07,
      thumbY: 0.02,
      thumbZ: 0.0,
    },

    anim: {
      legAmpWalk: 0.64,
      legAmpSprint: 0.46,
      legSway: 0.3,

      handBob: 2.65,
      handBobX: 0,

      swayStrength: 0,
      swayK: 20,
      swayC: 5,

      sprintLean: 0.04,
      breath: 0,
    },
  };

  const VIEW_CONE_DEG = 90;
  const VIEW_CONE_HALF = (VIEW_CONE_DEG * 0.5 * Math.PI) / 180;

  const VIEW_CONE_BODY_TURN_RATE = 18;
  const BODY_WALK_ALIGN_RATE = 12;

  scene.add(camera);

  const SKIN_MAT = new THREE.MeshLambertMaterial({
    color: FP_MODEL.colors.skin,
    fog: true,
  });
  const PANTS_MAT = new THREE.MeshLambertMaterial({
    color: FP_MODEL.colors.pants,
    fog: true,
  });
  const BOOT_MAT = new THREE.MeshLambertMaterial({
    color: FP_MODEL.colors.boot,
    fog: true,
  });
  const SLEEVE_MAT = new THREE.MeshLambertMaterial({
    color: FP_MODEL.colors.sleeve,
    fog: true,
  });

  const playerBody = new THREE.Group();
  scene.add(playerBody);

  function buildLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(FP_MODEL.body.legSpread * side, FP_MODEL.body.hipY, 0);

    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(
        FP_MODEL.body.legW,
        FP_MODEL.body.legLen,
        FP_MODEL.body.legD,
      ),
      PANTS_MAT,
    );
    leg.position.set(0, -FP_MODEL.body.legLen * 0.5, 0);
    pivot.add(leg);

    const boot = new THREE.Mesh(
      new THREE.BoxGeometry(
        FP_MODEL.body.bootW,
        FP_MODEL.body.bootH,
        FP_MODEL.body.bootD,
      ),
      BOOT_MAT,
    );
    boot.position.set(
      0,
      -FP_MODEL.body.legLen * 0.5 - FP_MODEL.body.bootH * 0.5 - 0.01,
      FP_MODEL.body.bootOffZ,
    );
    leg.add(boot);

    return pivot;
  }

  const legLPivot = buildLeg(-1);
  const legRPivot = buildLeg(+1);
  playerBody.add(legLPivot);
  playerBody.add(legRPivot);

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(
      FP_MODEL.body.torsoW,
      FP_MODEL.body.torsoH,
      FP_MODEL.body.torsoD,
    ),
    PANTS_MAT,
  );
  torso.position.set(0, FP_MODEL.body.torsoY, 0);

  playerBody.add(torso);

  const fpRoot = new THREE.Group();
  fpRoot.rotation.order = "YXZ";
  fpRoot.position.set(
    FP_MODEL.body.eyeX,
    FP_MODEL.body.eyeY,
    FP_MODEL.body.eyeZ,
  );
  playerBody.add(fpRoot);

  const SHOULDER_POS = {
    L: new THREE.Vector3(
      FP_MODEL.body.shoulderLX ?? -0.18,
      FP_MODEL.body.shoulderLY ?? -0.06,
      FP_MODEL.body.shoulderLZ ?? 0.04,
    ),
    R: new THREE.Vector3(
      FP_MODEL.body.shoulderRX ?? 0.18,
      FP_MODEL.body.shoulderRY ?? -0.06,
      FP_MODEL.body.shoulderRZ ?? 0.04,
    ),
  };
  const UPPER_ARM_BASE_LEN = FP_MODEL.body.armUpperLen ?? 0.26;
  const FOREARM_BASE_LEN = FP_MODEL.body.armForeLen ?? 0.28;
  const ARM_SEG_W = FP_MODEL.body.armSegW ?? 0.115;
  const ELBOW_OUT = FP_MODEL.body.elbowOut ?? 0.075;
  const ELBOW_DOWN = FP_MODEL.body.elbowDown ?? 0.09;
  const ELBOW_BACK = FP_MODEL.body.elbowBack ?? 0.09;

  function buildHand(side) {
    const group = new THREE.Group();

    const palm = new THREE.Mesh(
      new THREE.BoxGeometry(
        FP_MODEL.hands.palmW,
        FP_MODEL.hands.palmH,
        FP_MODEL.hands.palmD,
      ),
      SKIN_MAT,
    );
    palm.position.set(0, 0, -FP_MODEL.hands.palmD * 0.5);
    group.add(palm);

    const thumb = new THREE.Mesh(
      new THREE.BoxGeometry(
        FP_MODEL.hands.thumbW,
        FP_MODEL.hands.thumbH,
        FP_MODEL.hands.thumbD,
      ),
      SKIN_MAT,
    );
    thumb.position.set(
      FP_MODEL.hands.thumbX * side,
      FP_MODEL.hands.thumbY,
      FP_MODEL.hands.thumbZ - FP_MODEL.hands.palmD * 0.5,
    );
    group.add(thumb);

    return group;
  }

  function buildArmBones() {
    const upper = new THREE.Mesh(
      new THREE.BoxGeometry(ARM_SEG_W, UPPER_ARM_BASE_LEN, ARM_SEG_W),
      SLEEVE_MAT,
    );
    const fore = new THREE.Mesh(
      new THREE.BoxGeometry(ARM_SEG_W, FOREARM_BASE_LEN, ARM_SEG_W),
      SLEEVE_MAT,
    );
    fpRoot.add(upper);
    fpRoot.add(fore);
    return { upper, fore };
  }

  const handL = buildHand(-1);
  const handR = buildHand(+1);
  fpRoot.add(handL);
  fpRoot.add(handR);

  const armBonesL = buildArmBones(-1);
  const armBonesR = buildArmBones(+1);

  const HAND_REST = {
    L: FP_MODEL.hands.L,
    R: FP_MODEL.hands.R,
  };

  const _armMid = new THREE.Vector3();
  const _armElbow = new THREE.Vector3();
  const _armDir = new THREE.Vector3();
  const _armUp = new THREE.Vector3(0, 1, 0);

  function updateArmBones(side, hand) {
    const bones = side < 0 ? armBonesL : armBonesR;
    const shoulder = side < 0 ? SHOULDER_POS.L : SHOULDER_POS.R;

    _armMid.copy(shoulder).add(hand.position).multiplyScalar(0.5);
    _armElbow.set(
      _armMid.x + side * ELBOW_OUT,
      _armMid.y - ELBOW_DOWN,
      _armMid.z + ELBOW_BACK,
    );

    _armDir.copy(_armElbow).sub(shoulder);
    const upLen = _armDir.length();
    bones.upper.position.copy(shoulder).add(_armElbow).multiplyScalar(0.5);
    bones.upper.quaternion.setFromUnitVectors(_armUp, _armDir.normalize());
    bones.upper.scale.set(1, upLen / UPPER_ARM_BASE_LEN, 1);

    _armDir.copy(hand.position).sub(_armElbow);
    const foreLen = _armDir.length();
    bones.fore.position.copy(_armElbow).add(hand.position).multiplyScalar(0.5);
    bones.fore.quaternion.setFromUnitVectors(_armUp, _armDir.normalize());
    bones.fore.scale.set(1, foreLen / FOREARM_BASE_LEN, 1);
  }

  let swayYaw = 0,
    swayPitch = 0;
  let swayYawVel = 0,
    swayPitchVel = 0;

  let weaponDrivesHands = false;
  function setWeaponDrivesHands(v) {
    weaponDrivesHands = v;
  }

  const noiseTex = makeNoiseTexture();
  const chunkMat = new THREE.MeshLambertMaterial({
    map: noiseTex,
    vertexColors: true,
    fog: true,
  });

  const GLASS_OPACITY = 0.2;
  const glassMat = new THREE.MeshLambertMaterial({
    map: noiseTex,
    vertexColors: true,
    fog: true,
    transparent: true,
    opacity: GLASS_OPACITY,
    depthWrite: false,
  });

  const sun = new THREE.DirectionalLight(0xffe0b0, 0.75);
  sun.position.set(0.55, 1.0, 0.35);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8090a8, 0.55));
  scene.add(new THREE.HemisphereLight(0xa8b8c8, 0x403020, 0.35));

  function resizeRenderer() {
    const w = window.innerWidth,
      h = window.innerHeight;
    renderer.setPixelRatio(1);
    renderer.setSize(
      Math.max(320, Math.floor(w * RES_SCALE)),
      Math.max(240, Math.floor(h * RES_SCALE)),
      false,
    );
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resizeRenderer);

  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(
      new THREE.BoxGeometry(VOXEL * 1.02, VOXEL * 1.02, VOXEL * 1.02),
    ),
    new THREE.LineBasicMaterial({
      color: 0x0b0d11,
      transparent: true,
      opacity: 0.75,
    }),
  );
  highlight.visible = false;
  scene.add(highlight);

  /* =========================================================================
       9. CHUNK MESHING
       ========================================================================= */
  const chunkMeshes = new Map();
  const rebuildQueue = [];
  const dirtyChunks = new Set();
  let quietGeneration = false;

  function buildChunkGeometry(cx, cy, cz) {
    const ci = cIdx(cx, cy, cz);
    if (chunkCounts[ci] === 0) return null;

    const ox = cx * CHUNK,
      oy = cy * CHUNK,
      oz = cz * CHUNK;

    const positions = [],
      normals = [],
      uvs = [],
      colors = [],
      indices = [];
    const gPositions = [],
      gNormals = [],
      gUvs = [],
      gColors = [],
      gIndices = [];
    let v = 0;
    let gv = 0;
    const ao = [0, 0, 0, 0];

    for (let ly = 0; ly < CHUNK; ly++) {
      const wy = oy + ly;
      if (wy >= SY) break;
      for (let lz = 0; lz < CHUNK; lz++) {
        const wz = oz + lz;
        if (wz >= SZ) break;
        for (let lx = 0; lx < CHUNK; lx++) {
          const wx = ox + lx;
          if (wx >= SX) break;
          const b = voxels[vIdx(wx, wy, wz)];
          if (b === 0 || !BLOCKS[b]) continue;
          const def = BLOCKS[b];
          const isGlass = !!def.transparent;

          const dPos = isGlass ? gPositions : positions;
          const dNor = isGlass ? gNormals : normals;
          const dUv = isGlass ? gUvs : uvs;
          const dCol = isGlass ? gColors : colors;
          const dIdx = isGlass ? gIndices : indices;
          let base = isGlass ? gv : v;

          const jit = ((hash3(wx, wy, wz) % 20) / 20 - 0.5) * 0.13;
          const cr = (((def.color >> 16) & 255) / 255) * (1 + jit);
          const cg = (((def.color >> 8) & 255) / 255) * (1 + jit);
          const cb = ((def.color & 255) / 255) * (1 + jit);

          for (let f = 0; f < 6; f++) {
            const face = FACES[f];
            const nb = getV(wx + face.n[0], wy + face.n[1], wz + face.n[2]);

            if (nb !== 0) {
              if (isGlass) continue;
              if (!BLOCKS[nb] || !BLOCKS[nb].transparent) continue;
            }

            computeFaceAO(wx, wy, wz, f, ao);

            let ua, va;
            if (face.n[0] !== 0) {
              ua = 2;
              va = 1;
            } else if (face.n[1] !== 0) {
              ua = 0;
              va = 2;
            } else {
              ua = 0;
              va = 1;
            }

            for (let k = 0; k < 4; k++) {
              const cnr = face.c[k];
              const px = (lx + cnr[0]) * VOXEL;
              const py = (ly + cnr[1]) * VOXEL;
              const pz = (lz + cnr[2]) * VOXEL;

              dPos.push(px, py, pz);
              dNor.push(face.n[0], face.n[1], face.n[2]);

              const cw = [wx + cnr[0], wy + cnr[1], wz + cnr[2]];
              dUv.push(cw[ua] * VOXEL * UV_SCALE, cw[va] * VOXEL * UV_SCALE);

              const aoMul = 0.55 + 0.45 * ao[k];
              dCol.push(cr * aoMul, cg * aoMul, cb * aoMul);
            }
            dIdx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
            base += 4;
          }

          if (isGlass) gv = base;
          else v = base;
        }
      }
    }

    if (v === 0 && gv === 0) return null;

    function pack(pos, nor, uv, col, idx) {
      if (pos.length === 0) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      return g;
    }

    return {
      opaque: pack(positions, normals, uvs, colors, indices),
      glass: pack(gPositions, gNormals, gUvs, gColors, gIndices),
    };
  }

  function rebuildChunk(cx, cy, cz) {
    if (
      cx < 0 ||
      cy < 0 ||
      cz < 0 ||
      cx >= CHUNKS_X ||
      cy >= CHUNKS_Y ||
      cz >= CHUNKS_Z
    )
      return;
    const key = cx + "," + cy + "," + cz;
    const old = chunkMeshes.get(key);
    if (old) {
      if (old.opaque) {
        scene.remove(old.opaque);
        old.opaque.geometry.dispose();
      }
      if (old.glass) {
        scene.remove(old.glass);
        old.glass.geometry.dispose();
      }
      chunkMeshes.delete(key);
    }
    const geo = buildChunkGeometry(cx, cy, cz);
    if (!geo) return;

    const px = cx * CHUNK * VOXEL;
    const py = cy * CHUNK * VOXEL;
    const pz = cz * CHUNK * VOXEL;

    let opaqueMesh = null,
      glassMesh = null;

    if (geo.opaque) {
      opaqueMesh = new THREE.Mesh(geo.opaque, chunkMat);
      opaqueMesh.position.set(px, py, pz);
      opaqueMesh.matrixAutoUpdate = false;
      opaqueMesh.updateMatrix();
      scene.add(opaqueMesh);
    }
    if (geo.glass) {
      glassMesh = new THREE.Mesh(geo.glass, glassMat);
      glassMesh.position.set(px, py, pz);
      glassMesh.matrixAutoUpdate = false;
      glassMesh.updateMatrix();
      glassMesh.renderOrder = 10;
      scene.add(glassMesh);
    }

    if (opaqueMesh || glassMesh) {
      chunkMeshes.set(key, { opaque: opaqueMesh, glass: glassMesh });
    }
  }

  function markDirty(x, y, z) {
    const cx = (x / CHUNK) | 0,
      cy = (y / CHUNK) | 0,
      cz = (z / CHUNK) | 0;
    const lx = x % CHUNK,
      ly = y % CHUNK,
      lz = z % CHUNK;
    const push = (a, b, c) => {
      if (
        a < 0 ||
        b < 0 ||
        c < 0 ||
        a >= CHUNKS_X ||
        b >= CHUNKS_Y ||
        c >= CHUNKS_Z
      )
        return;
      const k = a + "," + b + "," + c;
      if (!dirtyChunks.has(k)) {
        dirtyChunks.add(k);
        rebuildQueue.push([a, b, c]);
      }
    };
    push(cx, cy, cz);
    if (lx === 0) push(cx - 1, cy, cz);
    if (lx === CHUNK - 1) push(cx + 1, cy, cz);
    if (ly === 0) push(cx, cy - 1, cz);
    if (ly === CHUNK - 1) push(cx, cy + 1, cz);
    if (lz === 0) push(cx, cy, cz - 1);
    if (lz === CHUNK - 1) push(cx, cy, cz + 1);
  }

  function flushRebuilds() {
    let n = 0;
    while (rebuildQueue.length && n < 2) {
      const [cx, cy, cz] = rebuildQueue.shift();
      dirtyChunks.delete(cx + "," + cy + "," + cz);
      rebuildChunk(cx, cy, cz);
      n++;
    }
  }

  /* =========================================================================
       10. DESTRUCTION + DEBRIS + FIRE + EXPLOSIONS
       ========================================================================= */
  const MAX_DEBRIS = 400;
  const debrisGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  {
    const cnt = debrisGeo.attributes.position.count;
    const arr = new Float32Array(cnt * 3).fill(1);
    debrisGeo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  }
  const debrisMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    fog: true,
  });
  const debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, MAX_DEBRIS);
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.frustumCulled = false;
  scene.add(debrisMesh);

  const debrisList = [];
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3(1, 1, 1);
  const _v3 = new THREE.Vector3();

  for (let i = 0; i < MAX_DEBRIS; i++) {
    debrisMesh.setColorAt(i, new THREE.Color(0));
    debrisMesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(0, -9999, 0));
  }
  debrisMesh.instanceMatrix.needsUpdate = true;

  function spawnDebris(vx, vy, vz, hexColor, count) {
    count = count || 1;
    const col = new THREE.Color(hexColor);
    for (let i = 0; i < count; i++) {
      if (debrisList.length >= MAX_DEBRIS) debrisList.shift();
      const spd = 1.5 + Math.random() * 3.5;
      debrisList.push({
        x: (vx + 0.5) * VOXEL,
        y: (vy + 0.5) * VOXEL,
        z: (vz + 0.5) * VOXEL,
        vx: (Math.random() - 0.5) * spd,
        vy: Math.random() * spd * 0.8 + 0.8,
        vz: (Math.random() - 0.5) * spd,
        life: 1.8 + Math.random() * 1.6,
        r: col.r,
        g: col.g,
        b: col.b,
        rot: Math.random() * 6.28,
        rv: (Math.random() - 0.5) * 12,
        sc: 0.6 + Math.random() * 0.9,
      });
    }
  }

  function updateDebris(dt) {
    for (let i = debrisList.length - 1; i >= 0; i--) {
      const d = debrisList[i];
      d.life -= dt;
      if (d.life <= 0) {
        debrisList.splice(i, 1);
        continue;
      }
      d.vy -= GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.rot += d.rv * dt;
      const gx = Math.floor(d.x / VOXEL),
        gy = Math.floor(d.y / VOXEL),
        gz = Math.floor(d.z / VOXEL);
      if (getV(gx, gy, gz) !== 0) {
        d.y = (gy + 1) * VOXEL + 0.01;
        d.vy = Math.abs(d.vy) * 0.22;
        d.vx *= 0.6;
        d.vz *= 0.6;
        d.rv *= 0.6;
      }
      if (d.y < -2) debrisList.splice(i, 1);
    }
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const d = debrisList[i];
      if (d) {
        const fade = clamp(d.life / 0.6, 0, 1);
        _v3.set(d.x, d.y, d.z);
        _q.setFromAxisAngle(new THREE.Vector3(0.6, 1, 0.4).normalize(), d.rot);
        _s.set(d.sc, d.sc, d.sc);
        _m4.compose(_v3, _q, _s);
        debrisMesh.setMatrixAt(i, _m4);
        debrisMesh.setColorAt(
          i,
          new THREE.Color(d.r * fade, d.g * fade, d.b * fade),
        );
      } else {
        _m4.makeTranslation(0, -9999, 0);
        debrisMesh.setMatrixAt(i, _m4);
      }
    }
    debrisMesh.instanceMatrix.needsUpdate = true;
    if (debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
  }

  const burning = new Map();

  const FIRE_LIFE_MIN = 2.5;
  const FIRE_LIFE_MAX = 5.0;

  function ignite(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return;
    const b = getV(x, y, z);
    if (b === 0) return;
    const def = BLOCKS[b];
    if (!def || !def.flammable) return;

    const k = x + "," + y + "," + z;
    if (burning.has(k)) return;

    burning.set(k, {
      x, y, z,
      t: 0,
      life: FIRE_LIFE_MIN + Math.random() * (FIRE_LIFE_MAX - FIRE_LIFE_MIN),
    });
  }

  const MAX_FIRE = 800;
  const fireGeo = new THREE.BufferGeometry();
  const firePos = new Float32Array(MAX_FIRE * 3);
  for (let i = 0; i < MAX_FIRE; i++) firePos[i * 3 + 1] = -9999;
  fireGeo.setAttribute("position", new THREE.BufferAttribute(firePos, 3));
  const firePoints = new THREE.Points(
    fireGeo,
    new THREE.PointsMaterial({
      color: 0xff8030,
      size: 0.16,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }),
  );
  firePoints.frustumCulled = false;
  scene.add(firePoints);

  const MAX_EXP_PARTS = 300;
  const expGeo = new THREE.BufferGeometry();
  const expPos = new Float32Array(MAX_EXP_PARTS * 3);
  const expCol = new Float32Array(MAX_EXP_PARTS * 3);
  for (let i = 0; i < MAX_EXP_PARTS; i++) expPos[i * 3 + 1] = -9999;
  expGeo.setAttribute("position", new THREE.BufferAttribute(expPos, 3));
  expGeo.setAttribute("color", new THREE.BufferAttribute(expCol, 3));
  const expPoints = new THREE.Points(
    expGeo,
    new THREE.PointsMaterial({
      size: 0.22,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }),
  );
  expPoints.frustumCulled = false;
  scene.add(expPoints);

  const explosionParts = [];

  function spawnExplosionBurst(vx, vy, vz, radiusMeters) {
    const wx = (vx + 0.5) * VOXEL;
    const wy = (vy + 0.5) * VOXEL;
    const wz = (vz + 0.5) * VOXEL;

    const count = Math.min(48, Math.floor(18 + radiusMeters * 12));

    for (let i = 0; i < count; i++) {
      if (explosionParts.length >= MAX_EXP_PARTS) explosionParts.shift();

      const a = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.35) * Math.PI * 0.55;
      const speed = 3.5 + Math.random() * 6.5;
      const cosEl = Math.cos(el);

      explosionParts.push({
        x: wx,
        y: wy,
        z: wz,
        vx: Math.cos(a) * cosEl * speed,
        vy: Math.sin(el) * speed * 0.9 + 2.2,
        vz: Math.sin(a) * cosEl * speed,
        life: 0.55 + Math.random() * 0.55,
        maxLife: 1.0,
        r: 1.0,
        g: 0.35 + Math.random() * 0.45,
        b: 0.05 + Math.random() * 0.18,
      });
    }

    for (let i = 0; i < 8; i++) {
      if (explosionParts.length >= MAX_EXP_PARTS) explosionParts.shift();
      const a = Math.random() * Math.PI * 2;
      const speed = 8 + Math.random() * 5;
      explosionParts.push({
        x: wx,
        y: wy,
        z: wz,
        vx: Math.cos(a) * speed * 0.4,
        vy: 3 + Math.random() * 3,
        vz: Math.sin(a) * speed * 0.4,
        life: 0.18 + Math.random() * 0.12,
        maxLife: 0.3,
        r: 1.0,
        g: 1.0,
        b: 0.85,
      });
    }
  }

  function updateExplosionParts(dt) {
    for (let i = explosionParts.length - 1; i >= 0; i--) {
      const p = explosionParts[i];
      p.life -= dt;
      if (p.life <= 0) {
        explosionParts.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy -= GRAVITY * 0.35 * dt;
      const drag = Math.pow(0.3, dt);
      p.vx *= drag;
      p.vz *= drag;
    }

    let n = 0;
    for (const p of explosionParts) {
      if (n >= MAX_EXP_PARTS) break;
      const f = clamp(p.life / 0.55, 0, 1);
      const hot = Math.min(1, p.life / 0.5);
      expPos[n * 3] = p.x;
      expPos[n * 3 + 1] = p.y;
      expPos[n * 3 + 2] = p.z;
      expCol[n * 3] = p.r * f;
      expCol[n * 3 + 1] = p.g * hot * f;
      expCol[n * 3 + 2] = p.b * hot * hot * f;
      n++;
    }
    for (let j = n; j < MAX_EXP_PARTS; j++) expPos[j * 3 + 1] = -9999;

    expGeo.attributes.position.needsUpdate = true;
    expGeo.attributes.color.needsUpdate = true;
    expGeo.setDrawRange(0, n);
  }

  const MAX_BLOOD = 400;
  const bloodGeo = new THREE.BufferGeometry();
  const bloodPos = new Float32Array(MAX_BLOOD * 3);
  const bloodCol = new Float32Array(MAX_BLOOD * 3);
  for (let i = 0; i < MAX_BLOOD; i++) bloodPos[i * 3 + 1] = -9999;
  bloodGeo.setAttribute("position", new THREE.BufferAttribute(bloodPos, 3));
  bloodGeo.setAttribute("color", new THREE.BufferAttribute(bloodCol, 3));
  const bloodPoints = new THREE.Points(
    bloodGeo,
    new THREE.PointsMaterial({
      size: 0.11,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      fog: true,
    }),
  );
  bloodPoints.frustumCulled = false;
  scene.add(bloodPoints);

  const bloodParts = [];

  function spawnBloodBurst(wx, wy, wz, count, tint) {
    count = count || 10;
    const r = tint && tint.r !== undefined ? tint.r : 0.72;
    const g = tint && tint.g !== undefined ? tint.g : 0.06;
    const b = tint && tint.b !== undefined ? tint.b : 0.06;
    for (let i = 0; i < count; i++) {
      if (bloodParts.length >= MAX_BLOOD) bloodParts.shift();
      const a = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI * 0.6 - 0.2;
      const spd = 1.5 + Math.random() * 3.5;
      const cosEl = Math.cos(el);
      bloodParts.push({
        x: wx,
        y: wy,
        z: wz,
        vx: Math.cos(a) * cosEl * spd,
        vy: Math.sin(el) * spd + 1.2,
        vz: Math.sin(a) * cosEl * spd,
        life: 0.7 + Math.random() * 0.6,
        maxLife: 1.3,
        r,
        g,
        b,
      });
    }
  }

  function updateBloodParticles(dt) {
    for (let i = bloodParts.length - 1; i >= 0; i--) {
      const p = bloodParts[i];
      p.life -= dt;
      if (p.life <= 0) {
        bloodParts.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy -= GRAVITY * 0.6 * dt;
      const drag = Math.pow(0.55, dt);
      p.vx *= drag;
      p.vz *= drag;
      const gx = Math.floor(p.x / VOXEL);
      const gy = Math.floor(p.y / VOXEL);
      const gz = Math.floor(p.z / VOXEL);
      if (getV(gx, gy, gz) !== 0) p.life = 0;
    }

    let n = 0;
    for (const p of bloodParts) {
      if (n >= MAX_BLOOD) break;
      const f = clamp(p.life / p.maxLife, 0, 1);
      bloodPos[n * 3] = p.x;
      bloodPos[n * 3 + 1] = p.y;
      bloodPos[n * 3 + 2] = p.z;
      bloodCol[n * 3] = p.r * f;
      bloodCol[n * 3 + 1] = p.g * f;
      bloodCol[n * 3 + 2] = p.b * f;
      n++;
    }
    for (let j = n; j < MAX_BLOOD; j++) bloodPos[j * 3 + 1] = -9999;
    bloodGeo.attributes.position.needsUpdate = true;
    bloodGeo.attributes.color.needsUpdate = true;
    bloodGeo.setDrawRange(0, n);
  }

  function destroyVoxel(x, y, z, opts) {
    const b = getV(x, y, z);
    if (b === 0) return false;
    const def = BLOCKS[b];
    if (!def) return false;
    if (opts && opts.maxStrength && def.strength > opts.maxStrength)
      return false;
    if (def.explosive) pendingExplosions.push({ x, y, z, radius: 2.0 });
    if (opts && opts.ignite && def.flammable && Math.random() < 0.55)
      ignite(x, y, z);
    setVRaw(x, y, z, 0);
    markDirty(x, y, z);
    if (
      Math.random() <
      (opts && opts.debrisChance !== undefined ? opts.debrisChance : 0.05)
    )
      spawnDebris(x, y, z, def.color, 1);
    return true;
  }

  function carveSphere(vcx, vcy, vcz, rVox, opts) {
    opts = opts || {};
    const R = Math.ceil(rVox);
    const r2 = rVox * rVox;
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          destroyVoxel(
            Math.round(vcx) + dx,
            Math.round(vcy) + dy,
            Math.round(vcz) + dz,
            opts,
          );
        }
  }

  const pendingExplosions = [];
  const processedExplosions = new Set();

  function processExplosions() {
    let safety = 24;
    while (pendingExplosions.length && safety-- > 0) {
      const e = pendingExplosions.shift();
      const k = e.x + "," + e.y + "," + e.z;
      if (processedExplosions.has(k)) continue;
      processedExplosions.add(k);
      explodeAt(e.x, e.y, e.z, e.radius);
    }
    if (processedExplosions.size > 500) processedExplosions.clear();
  }

  function explodeAt(vx, vy, vz, radiusMeters, silent) {
    if (window.Sfx) Sfx.play("explosion");
    const rv = radiusMeters / VOXEL;
    spawnExplosionBurst(vx, vy, vz, radiusMeters);

    carveSphere(vx, vy, vz, rv, { ignite: true, debrisChance: 0.1 });
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * rv;
      ignite(
        Math.round(vx + Math.cos(a) * d),
        Math.round(vy + (Math.random() - 0.3) * 2),
        Math.round(vz + Math.sin(a) * d),
      );
    }
    const wx = vx * VOXEL,
      wy = vy * VOXEL,
      wz = vz * VOXEL;
    const pd = Math.hypot(
      player.pos.x - wx,
      player.pos.y + 0.9 - wy,
      player.pos.z - wz,
    );
    if (pd < radiusMeters * 1.6) {
      damagePlayer(40 * (1 - pd / (radiusMeters * 1.6)));
      shakeCamera(0.35);
    }
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - wx, e.pos.y + 0.8 - wy, e.pos.z - wz);
      if (d < radiusMeters * 1.6)
        hurtEnemy(e, 100 * (1 - d / (radiusMeters * 1.6)));
    }

    if (!silent && typeof net !== "undefined" && net.sendExplosion) {
      net.sendExplosion(vx, vy, vz, radiusMeters);
    }
  }

  function updateFire(dt) {
    const dirs = [
      [1, 0, 0], [-1, 0, 0],
      [0, 1, 0], [0, -1, 0],
      [0, 0, 1], [0, 0, -1],
    ];
    const del = [];
    for (const [k, f] of burning) {
      f.t += dt;
      if (f.t > f.life) {
        del.push(k);
        const b = getV(f.x, f.y, f.z);
        if (b) {
          setVRaw(f.x, f.y, f.z, 0);
          markDirty(f.x, f.y, f.z);
          if (Math.random() < 0.4) spawnDebris(f.x, f.y, f.z, 0x2a1a12, 1);
        }
        continue;
      }
      if (Math.random() < dt * 2.0) {
        const d = dirs[(Math.random() * 6) | 0];
        const nb = getV(f.x + d[0], f.y + d[1], f.z + d[2]);
        if (nb && BLOCKS[nb] && BLOCKS[nb].flammable && Math.random() < 0.5)
          ignite(f.x + d[0], f.y + d[1], f.z + d[2]);
      }
    }
    for (const k of del) burning.delete(k);

    let i = 0;
    for (const f of burning.values()) {
      if (i >= MAX_FIRE) break;
      firePos[i * 3] = (f.x + 0.5) * VOXEL + (Math.random() - 0.5) * 0.1;
      firePos[i * 3 + 1] = (f.y + 0.5) * VOXEL + Math.random() * 0.1;
      firePos[i * 3 + 2] = (f.z + 0.5) * VOXEL + (Math.random() - 0.5) * 0.1;
      i++;
    }
    for (let j = i; j < MAX_FIRE; j++) firePos[j * 3 + 1] = -9999;
    fireGeo.attributes.position.needsUpdate = true;
    fireGeo.setDrawRange(0, i);
  }

  /* =========================================================================
   11. CITY GENERATION
   ========================================================================= */
  const GROUND_Y = 8;
  const ROAD_WIDTH = 22;
  const ROAD_HALF = ROAD_WIDTH >> 1;
  const ROAD_MIN_GAP = 90;
  const ROAD_MARGIN = 30;

  const PLOT_EDGE_PAD = 3;
  const PLOT_PLOT_PAD = 4;

  let LOAD_RADIUS = 6;
  let UNLOAD_RADIUS = 9;

  (function applyViewChunksSetting() {
    const v = settings.viewChunks;
    if (typeof v === "number") {
      LOAD_RADIUS = clamp(Math.round(v), 3, 12);
      UNLOAD_RADIUS = LOAD_RADIUS + 3;
    }
  })();

  const MAX_CHUNK_GENS_PER_FRAME = 1;

  let cityLayout = null;
  const generatedChunks = new Set();
  const meshedChunks = new Set();
  let lastStreamedCx = -99999,
    lastStreamedCz = -99999;

  function fillGroundVoxels() {
    for (let x = 0; x < SX; x++) {
      for (let z = 0; z < SZ; z++) {
        for (let y = 0; y < GROUND_Y - 1; y++) setVRaw(x, y, z, 8);
        setVRaw(x, GROUND_Y - 1, z, 9);
      }
    }
  }

  function generateRoadAxis(rnd, minCount, maxCount, size) {
    const positions = [];
    const wanted = minCount + ((rnd() * (maxCount - minCount + 1)) | 0);
    let attempts = 0;
    while (positions.length < wanted && attempts++ < 2000) {
      const p = ROAD_MARGIN + ((rnd() * (size - ROAD_MARGIN * 2)) | 0);
      let ok = true;
      for (const q of positions) {
        if (Math.abs(p - q) < ROAD_MIN_GAP) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(p);
    }
    positions.sort((a, b) => a - b);
    return positions;
  }

  function carveRoadH(z) {
    const zLo = Math.max(0, z - ROAD_HALF);
    const zHi = Math.min(SZ - 1, z + ROAD_HALF);
    const y = GROUND_Y - 1;
    for (let px = 0; px < SX; px++)
      for (let pz = zLo; pz <= zHi; pz++) setVRaw(px, y, pz, 1);
  }
  function carveRoadV(x) {
    const xLo = Math.max(0, x - ROAD_HALF);
    const xHi = Math.min(SX - 1, x + ROAD_HALF);
    const y = GROUND_Y - 1;
    for (let pz = 0; pz < SZ; pz++)
      for (let px = xLo; px <= xHi; px++) setVRaw(px, y, pz, 1);
  }

  function enumerateBlocks(roadXs, roadZs) {
    const xSegs = [];
    let prev = 0;
    for (const rx of roadXs) {
      const left = rx - ROAD_HALF;
      if (left > prev) xSegs.push([prev, left]);
      prev = rx + ROAD_HALF;
    }
    if (prev < SX) xSegs.push([prev, SX]);

    const zSegs = [];
    prev = 0;
    for (const rz of roadZs) {
      const left = rz - ROAD_HALF;
      if (left > prev) zSegs.push([prev, left]);
      prev = rz + ROAD_HALF;
    }
    if (prev < SZ) zSegs.push([prev, SZ]);

    const blocks = [];
    for (const [x0, x1] of xSegs)
      for (const [z0, z1] of zSegs)
        blocks.push({ x: x0, z: z0, w: x1 - x0, d: z1 - z0 });
    return blocks;
  }

  function rectOverlaps(ax, az, aw, ad, bx, bz, bw, bd, pad) {
    return !(
      ax + aw + pad <= bx ||
      bx + bw + pad <= ax ||
      az + ad + pad <= bz ||
      bz + bd + pad <= az
    );
  }

  function chooseStructure(rnd, pool, blockW, blockD) {
    if (!pool.length) return null;
    const fits = [];
    for (const s of pool) {
      const [W, , D] = s.size;
      if (W + PLOT_EDGE_PAD * 2 <= blockW && D + PLOT_EDGE_PAD * 2 <= blockD)
        fits.push(s);
    }
    if (!fits.length) return null;

    let best = fits[(rnd() * fits.length) | 0];
    const tries = Math.min(6, fits.length);
    for (let i = 1; i < tries; i++) {
      const cand = fits[(rnd() * fits.length) | 0];
      if (cand.size[0] * cand.size[2] > best.size[0] * best.size[2])
        best = cand;
    }
    return best;
  }

  function placeStructuresInBlock(rnd, block, pool) {
    const plots = [];
    if (block.w < 12 || block.d < 12) return plots;

    const capW = Math.max(1, Math.floor((block.w - PLOT_EDGE_PAD * 2) / 30));
    const capD = Math.max(1, Math.floor((block.d - PLOT_EDGE_PAD * 2) / 30));
    const maxN = Math.min(3, capW * capD);
    const wantN = 1 + ((rnd() * maxN) | 0);

    let attempts = 0;
    while (plots.length < wantN && attempts++ < wantN * 40) {
      const s = chooseStructure(rnd, pool, block.w, block.d);
      if (!s) break;
      const [W, , D] = s.size;

      const pad = PLOT_EDGE_PAD;
      const availW = block.w - W - pad * 2;
      const availD = block.d - D - pad * 2;
      if (availW < 0 || availD < 0) continue;

      const px = block.x + pad + ((rnd() * (availW + 1)) | 0);
      const pz = block.z + pad + ((rnd() * (availD + 1)) | 0);

      let ok = true;
      for (const o of plots) {
        if (rectOverlaps(px, pz, W, D, o.x, o.z, o.w, o.d, PLOT_PLOT_PAD)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      plots.push({ x: px, z: pz, w: W, d: D, struct: s });
    }
    return plots;
  }

  function scatterRoadProps(rnd) {
    for (let i = 0; i < 3000; i++) {
      const x = (rnd() * SX) | 0;
      const z = (rnd() * SZ) | 0;
      if (getV(x, GROUND_Y - 1, z) !== 1) continue;
      if (rnd() < 0.55) setVRaw(x, GROUND_Y, z, 10);
    }
    for (let i = 0; i < 220; i++) {
      const x = 3 + ((rnd() * (SX - 6)) | 0);
      const z = 3 + ((rnd() * (SZ - 6)) | 0);
      if (getV(x, GROUND_Y - 1, z) !== 1) continue;
      if (getV(x, GROUND_Y, z) !== 0) continue;
      for (let k = 0; k < 5; k++) setVRaw(x, GROUND_Y + k, z, 13);
    }
  }

  function carveSphereRaw(cx, cy, cz, r) {
    const R = Math.ceil(r);
    const r2 = r * r;
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          setVRaw(
            Math.round(cx) + dx,
            Math.round(cy) + dy,
            Math.round(cz) + dz,
            0,
          );
        }
  }

  function buildBuildingBlocks(x0, z0, w, d, y0, height, seed) {
    const rnd = mulberry32(seed);
    const blocks = [];
    const walls = [2, 3, 5, 11];
    const wallMat = walls[(rnd() * walls.length) | 0];
    const WT = 3;
    const y1 = Math.min(SY - 2, y0 + height);

    for (let y = y0; y < y1; y++) {
      const relY = y - y0;
      for (let x = x0; x < x0 + w; x++) {
        for (let z = z0; z < z0 + d; z++) {
          const eX = x < x0 + WT || x >= x0 + w - WT;
          const eZ = z < z0 + WT || z >= z0 + d - WT;
          if (!eX && !eZ) {
            if (relY % 16 === 0) blocks.push([x, y, z, 2]);
            continue;
          }
          const band = relY % 16;
          const inBand = band >= 4 && band <= 11 && relY > 6;
          const isWindow = inBand && (x + z) % 7 < 4 && rnd() < 0.75;
          blocks.push([x, y, z, isWindow ? 4 : wallMat]);
        }
      }
    }
    for (let x = x0; x < x0 + w; x++)
      for (let z = z0; z < z0 + d; z++) blocks.push([x, y1, z, wallMat]);

    const emitCarve = (cx, cy, cz, r) => {
      const R = Math.ceil(r),
        r2 = r * r;
      for (let dy = -R; dy <= R; dy++)
        for (let dz = -R; dz <= R; dz++)
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            blocks.push([
              Math.round(cx) + dx,
              Math.round(cy) + dy,
              Math.round(cz) + dz,
              0,
            ]);
          }
    };
    const holes = 1 + ((rnd() * 6) | 0);
    for (let i = 0; i < holes; i++) {
      emitCarve(
        x0 + 3 + rnd() * Math.max(1, w - 6),
        y0 + 3 + rnd() * Math.max(1, y1 - y0 - 3),
        z0 + 3 + rnd() * Math.max(1, d - 6),
        3 + rnd() * 7,
      );
    }
    if (rnd() < 0.4) {
      emitCarve(x0 + w * 0.5, y0 + 4, z0 + rnd() * d, 5 + rnd() * 5);
    }
    return blocks;
  }

  function stampStructure(struct, ox, oy, oz, rotY) {
    const [W, H, D] = struct.size || [1, 1, 1];
    const cos = Math.cos(rotY || 0),
      sin = Math.sin(rotY || 0);

    for (const [x, y, z, id] of struct.blocks) {
      let tx = x,
        tz = z;
      if (rotY) {
        const cx = (W - 1) * 0.5,
          cz = (D - 1) * 0.5;
        const dx = x - cx,
          dz = z - cz;
        tx = Math.round(cx + dx * cos - dz * sin);
        tz = Math.round(cz + dx * sin + dz * cos);
      }
      const wx = ox + tx,
        wy = oy + y,
        wz = oz + tz;
      if (wx < 0 || wy < 0 || wz < 0 || wx >= SX || wy >= SY || wz >= SZ)
        continue;
      setVRaw(wx, wy, wz, id);
      markDirty(wx, wy, wz);
    }

    if (
      Array.isArray(struct.furniture) &&
      struct.furniture.length &&
      window.ARIVE_FURNITURE &&
      window.ARIVE_FURNITURE.length
    ) {
      const bySize = { small: [], medium: [], large: [] };
      for (const f of window.ARIVE_FURNITURE) {
        if (bySize[f.size]) bySize[f.size].push(f);
      }

      for (const fb of struct.furniture) {
        if (!fb || !fb.size) continue;

        let tx = fb.x,
          tz = fb.z;
        if (rotY) {
          const cx = (W - 1) * 0.5,
            cz = (D - 1) * 0.5;
          const dx = fb.x - cx,
            dz = fb.z - cz;
          tx = Math.round(cx + dx * cos - dz * sin);
          tz = Math.round(cz + dx * sin + dz * cos);
        }

        const wx = ox + tx;
        const wy = oy + fb.y;
        const wz = oz + tz;
        if (wx < 0 || wy < 0 || wz < 0 || wx >= SX || wy >= SY || wz >= SZ)
          continue;

        const pool = bySize[fb.size];
        if (!pool || !pool.length) continue;

        const pick = pool[(Math.random() * pool.length) | 0];

        const hasDir = typeof fb.dir === "number";
        const baseYaw = hasDir ? fb.dir : Math.random() * Math.PI * 2;
        const yaw = baseYaw + (rotY || 0);

        const worldPos = new THREE.Vector3(
          (wx + 0.5) * VOXEL,
          (wy + 1.0) * VOXEL + 0.02,
          (wz + 0.5) * VOXEL,
        );

        const spawned = spawnPickup(
          {
            name: pick.name,
            iconImage: pick.iconImage,
            iconImageRotated: pick.iconImageRotated,
            w: pick.w,
            h: pick.h,
            color: pick.color,
            meta: pick.meta,
            furnitureKey: pick.key,
            size: pick.size,
          },
          worldPos,
          null,
          yaw,
        );

        if (spawned && hasDir) {
          spawned.vx = spawned.vy = spawned.vz = 0;
          spawned.avx = spawned.avy = spawned.avz = 0;
        }
      }
    }
  }

  function plotBlocks(p) {
    if (p._blocks) return p._blocks;

    if (p.procedural) {
      p._blocks = buildBuildingBlocks(
        p.x,
        p.z,
        p.w,
        p.d,
        GROUND_Y,
        p.procedural.h,
        p.procedural.seed,
      );
    } else if (p.struct) {
      const arr = [];
      for (const [x, y, z, id] of p.struct.blocks) {
        arr.push([p.x + x, GROUND_Y + y, p.z + z, id]);
      }
      p._blocks = arr;
    } else {
      p._blocks = [];
    }
    return p._blocks;
  }

  function writePlotBlocksInChunk(p, cx0, cx1, cz0, cz1) {
    const blocks = plotBlocks(p);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b[0] < cx0 || b[0] >= cx1) continue;
      if (b[2] < cz0 || b[2] >= cz1) continue;
      setVRaw(b[0], b[1], b[2], b[3]);
    }
  }

  function spawnPlotFurnitureInChunk(p, cx0, cx1, cz0, cz1) {
    if (!p._furnitureSpawned) p._furnitureSpawned = new Set();
    if (!Array.isArray(p.struct.furniture) || !p.struct.furniture.length)
      return;
    if (!window.ARIVE_FURNITURE || !window.ARIVE_FURNITURE.length) return;

    const bySize = { small: [], medium: [], large: [] };
    for (const f of window.ARIVE_FURNITURE) {
      if (bySize[f.size]) bySize[f.size].push(f);
    }

    const markers = p.struct.furniture;
    for (let i = 0; i < markers.length; i++) {
      if (p._furnitureSpawned.has(i)) continue;

      const fb = markers[i];
      if (!fb || !fb.size) {
        p._furnitureSpawned.add(i);
        continue;
      }

      const wx = p.x + fb.x;
      const wz = p.z + fb.z;

      if (wx < cx0 || wx >= cx1) continue;
      if (wz < cz0 || wz >= cz1) continue;

      const wy = GROUND_Y + fb.y;
      if (wx < 0 || wy < 0 || wz < 0 || wx >= SX || wy >= SY || wz >= SZ) {
        p._furnitureSpawned.add(i);
        continue;
      }

      const pool = bySize[fb.size];
      if (!pool || !pool.length) {
        p._furnitureSpawned.add(i);
        continue;
      }

      const pick = pool[(Math.random() * pool.length) | 0];

      const spawnY = (wy + 1.0) * VOXEL + 0.02;

      const hasDir = typeof fb.dir === "number";
      const yaw = hasDir ? fb.dir : Math.random() * Math.PI * 2;

      const spawned = spawnPickup(
        {
          name: pick.name,
          iconImage: pick.iconImage,
          iconImageRotated: pick.iconImageRotated,
          w: pick.w,
          h: pick.h,
          color: pick.color,
          meta: pick.meta,
          furnitureKey: pick.key,
          size: pick.size,
        },
        new THREE.Vector3((wx + 0.5) * VOXEL, spawnY, (wz + 0.5) * VOXEL),
        null,
        yaw,
      );

      if (spawned && hasDir) {
        spawned.vx = spawned.vy = spawned.vz = 0;
        spawned.avx = spawned.avy = spawned.avz = 0;
      }

      p._furnitureSpawned.add(i);
    }
  }

  const LOOT_TABLE = [
    { key: "ammo_9mm", weight: 18, count: [8, 20] },
    { key: "ammo_556", weight: 14, count: [6, 16] },
    { key: "ammo_shell", weight: 10, count: [5, 12] },

    { key: "medkit", weight: 8 },
    { key: "bandage", weight: 14 },
    { key: "ration", weight: 16 },
    { key: "water", weight: 16 },
    { key: "canned", weight: 10 },

    { key: "battery", weight: 6 },
    { key: "wire", weight: 6 },
    { key: "canister", weight: 4 },
  ];

  const LOOT_DENSITY = 0.04;
  const LOOT_MIN = 1;
  const LOOT_MAX = 5;

  function pickWeightedLoot(rnd) {
    let total = 0;
    for (let i = 0; i < LOOT_TABLE.length; i++) total += LOOT_TABLE[i].weight;
    let r = rnd() * total;
    for (let i = 0; i < LOOT_TABLE.length; i++) {
      r -= LOOT_TABLE[i].weight;
      if (r <= 0) return LOOT_TABLE[i];
    }
    return LOOT_TABLE[LOOT_TABLE.length - 1];
  }

  function computePlotLoot(p) {
    if (p._lootSpots) return p._lootSpots;
    p._lootSpots = [];

    const blocks = plotBlocks(p);
    if (!blocks || !blocks.length) return p._lootSpots;

    const solid = new Set();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b[3] === 0) continue;
      solid.add(b[0] + "," + b[1] + "," + b[2]);
    }
    const isSolid = (x, y, z) => solid.has(x + "," + y + "," + z);

    const candidates = [];

    for (let dx = 1; dx < p.w - 1; dx++) {
      for (let dz = 1; dz < p.d - 1; dz++) {
        const wx = p.x + dx;
        const wz = p.z + dz;

        let yFloor = -1;
        for (let y = GROUND_Y; y <= GROUND_Y + 8; y++) {
          if (isSolid(wx, y, wz)) { yFloor = y; break; }
        }
        if (yFloor < 0) yFloor = GROUND_Y - 1;

        if (isSolid(wx, yFloor + 1, wz)) continue;
        if (isSolid(wx, yFloor + 2, wz)) continue;

        let hasCeiling = false;
        for (let y = yFloor + 3; y < SY; y++) {
          if (isSolid(wx, y, wz)) { hasCeiling = true; break; }
        }
        if (!hasCeiling) continue;

        candidates.push({ x: wx, y: yFloor, z: wz });
      }
    }

    if (!candidates.length) return p._lootSpots;

    const seed = hash3(p.x, p.z, ((p.w << 8) ^ p.d) >>> 0);
    const rnd = mulberry32(seed);

    for (let i = candidates.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = candidates[i];
      candidates[i] = candidates[j];
      candidates[j] = t;
    }

    const want = clamp(
      Math.round(candidates.length * LOOT_DENSITY),
      LOOT_MIN,
      LOOT_MAX,
    );

    for (let i = 0; i < want && i < candidates.length; i++) {
      const spot = candidates[i];
      const entry = pickWeightedLoot(rnd);
      const def = ITEM_DEFS.find((d) => d.key === entry.key);
      if (!def) continue;
      p._lootSpots.push({ x: spot.x, y: spot.y, z: spot.z, entry, def });
    }
    return p._lootSpots;
  }

  function spawnPlotLootInChunk(p, cx0, cx1, cz0, cz1) {
    const spots = computePlotLoot(p);
    if (!spots.length) return;
    if (!p._lootSpawned) p._lootSpawned = new Set();

    for (let i = 0; i < spots.length; i++) {
      if (p._lootSpawned.has(i)) continue;
      const s = spots[i];
      if (s.x < cx0 || s.x >= cx1) continue;
      if (s.z < cz0 || s.z >= cz1) continue;

      p._lootSpawned.add(i);

      let count;
      if (s.def.isAmmo && s.entry.count) {
        const lo = s.entry.count[0];
        const hi = s.entry.count[1];
        count = lo + ((Math.random() * (hi - lo + 1)) | 0);
      }

      spawnPickup(
        {
          name: s.def.name,
          iconImage: s.def.iconImage,
          iconImageRotated: s.def.iconImageRotated,
          w: s.def.w,
          h: s.def.h,
          color: s.def.color,
          meta: s.def.meta,
          size: s.def.size,
          furnitureKey: s.def.furnitureKey,
          count: count,
          maxStack: s.def.maxStack,
          isAmmo: !!s.def.isAmmo,
          ammoType: s.def.ammoType,
        },
        new THREE.Vector3(
          (s.x + 0.5) * VOXEL,
          (s.y + 1.5) * VOXEL,
          (s.z + 0.5) * VOXEL,
        ),
      );
    }
  }

  const STRUCTURE_BLOCKLIST = [];

  function isStructureBlocked(name) {
    if (!name) return false;
    const lower = String(name).toLowerCase();
    for (let i = 0; i < STRUCTURE_BLOCKLIST.length; i++) {
      if (String(STRUCTURE_BLOCKLIST[i]).toLowerCase() === lower) return true;
    }
    return false;
  }

  function generateCityLayout(seed) {
    const rnd = mulberry32(seed);

    const roadXs = generateRoadAxis(rnd, 4, 6, SX);
    const roadZs = generateRoadAxis(rnd, 4, 6, SZ);
    const blocks = enumerateBlocks(roadXs, roadZs);

    const pool = (window.ARIVE_STRUCTURES || []).filter(
      (s) =>
        s &&
        Array.isArray(s.blocks) &&
        Array.isArray(s.size) &&
        s.size[0] >= 4 &&
        s.size[2] >= 4 &&
        !isStructureBlocked(s.name),
    );

    if (pool.length) {
      console.log(
        "[ARive] spawnable structures: " +
        pool.map((s) => s.name).join(", "),
      );
    }

    console.log(
      "[ARive] Layout · " +
      SX +
      "×" +
      SZ +
      " · roads " +
      roadXs.length +
      "×" +
      roadZs.length +
      " · blocks " +
      blocks.length +
      " · struct types " +
      pool.length,
    );

    const plots = [];
    if (pool.length > 0) {
      for (const block of blocks) {
        for (const p of placeStructuresInBlock(rnd, block, pool)) plots.push(p);
      }
    } else {
      for (const block of blocks) {
        if (block.w < 24 || block.d < 24) continue;
        if (rnd() > 0.75) continue;
        const W = 12 + ((rnd() * Math.min(24, block.w - 8)) | 0);
        const D = 12 + ((rnd() * Math.min(24, block.d - 8)) | 0);
        const H = 20 + ((rnd() * 60) | 0);
        const pad = PLOT_EDGE_PAD;
        const px =
          block.x + pad + ((rnd() * Math.max(1, block.w - W - pad * 2)) | 0);
        const pz =
          block.z + pad + ((rnd() * Math.max(1, block.d - D - pad * 2)) | 0);
        plots.push({
          x: px,
          z: pz,
          w: W,
          d: D,
          procedural: { h: H, seed: (rnd() * 1e9) | 0 },
        });
      }
    }

    const sx = roadXs[0] ?? SX >> 1;
    const sz = roadZs[0] ?? SZ >> 1;
    window.__ariveBigStructureSpot = { x: sx, z: sz };

    return { seed, roadXs, roadZs, blocks, plots };
  }

  function scatterPropsInChunk(cx, cz) {
    const seed =
      (cityLayout.seed ^
        Math.imul(cx, 0x9e3779b1) ^
        Math.imul(cz, 0x85ebca6b)) >>>
      0;
    const rnd = mulberry32(seed);

    const x0 = cx * CHUNK,
      x1 = x0 + CHUNK;
    const z0 = cz * CHUNK,
      z1 = z0 + CHUNK;

    for (let x = x0; x < x1; x++) {
      for (let z = z0; z < z1; z++) {
        if (getV(x, GROUND_Y - 1, z) !== 1) continue;
        if (rnd() < 0.012) setVRaw(x, GROUND_Y, z, 10);
      }
    }
    for (let x = x0 + 1; x < x1 - 1; x++) {
      for (let z = z0 + 1; z < z1 - 1; z++) {
        if (getV(x, GROUND_Y - 1, z) !== 1) continue;
        if (getV(x, GROUND_Y, z) !== 0) continue;
        if (rnd() < 0.0008) {
          for (let k = 0; k < 5; k++) setVRaw(x, GROUND_Y + k, z, 13);
        }
      }
    }
  }

  /* =========================================================================
   STREAMING CORE
   ========================================================================= */
  function generateChunkColumn(cx, cz) {
    const key = cx + "," + cz;

    if (!generatedChunks.has(key)) {
      const x0 = cx * CHUNK,
        x1 = x0 + CHUNK;
      const z0 = cz * CHUNK,
        z1 = z0 + CHUNK;

      for (let x = x0; x < x1; x++) {
        for (let z = z0; z < z1; z++) {
          for (let y = 0; y < GROUND_Y - 1; y++) setVRaw(x, y, z, 8);
          setVRaw(x, GROUND_Y - 1, z, 9);
        }
      }

      for (const rx of cityLayout.roadXs) {
        const lo = Math.max(x0, rx - ROAD_HALF);
        const hi = Math.min(x1 - 1, rx + ROAD_HALF);
        for (let x = lo; x <= hi; x++)
          for (let z = z0; z < z1; z++) setVRaw(x, GROUND_Y - 1, z, 1);
      }
      for (const rz of cityLayout.roadZs) {
        const lo = Math.max(z0, rz - ROAD_HALF);
        const hi = Math.min(z1 - 1, rz + ROAD_HALF);
        for (let z = lo; z <= hi; z++)
          for (let x = x0; x < x1; x++) setVRaw(x, GROUND_Y - 1, z, 1);
      }

      for (const p of cityLayout.plots) {
        if (p.x >= x1 || p.x + p.w <= x0) continue;
        if (p.z >= z1 || p.z + p.d <= z0) continue;
        writePlotBlocksInChunk(p, x0, x1, z0, z1);
      }

      for (const p of cityLayout.plots) {
        if (!p.struct) continue;
        if (p.x >= x1 || p.x + p.w <= x0) continue;
        if (p.z >= z1 || p.z + p.d <= z0) continue;
        spawnPlotFurnitureInChunk(p, x0, x1, z0, z1);
      }

      for (const p of cityLayout.plots) {
        if (p.x >= x1 || p.x + p.w <= x0) continue;
        if (p.z >= z1 || p.z + p.d <= z0) continue;
        spawnPlotLootInChunk(p, x0, x1, z0, z1);
      }

      scatterPropsInChunk(cx, cz);

      generatedChunks.add(key);

      if (Minimap && Minimap.markExplored) Minimap.markExplored(cx, cz);
    }

    if (!meshedChunks.has(key)) {
      for (let cy = 0; cy < CHUNKS_Y; cy++) rebuildChunk(cx, cy, cz);
      meshedChunks.add(key);
      remeshNeighborColumns(cx, cz);
    }
  }

  function remeshNeighborColumns(cx, cz) {
    const nbrs = [
      [cx - 1, cz],
      [cx + 1, cz],
      [cx, cz - 1],
      [cx, cz + 1],
    ];
    for (const [nx, nz] of nbrs) {
      if (nx < 0 || nz < 0 || nx >= CHUNKS_X || nz >= CHUNKS_Z) continue;
      if (!meshedChunks.has(nx + "," + nz)) continue;
      for (let cy = 0; cy < CHUNKS_Y; cy++) rebuildChunk(nx, cy, nz);
    }
  }

  function streamChunks(px, pz, force) {
    if (!cityLayout || currentMapType !== "city") return;

    const pcx = Math.floor(px / (CHUNK * VOXEL));
    const pcz = Math.floor(pz / (CHUNK * VOXEL));
    const R = LOAD_RADIUS,
      R2 = R * R;

    const want = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const cx = pcx + dx,
          cz = pcz + dz;
        if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) continue;
        const key = cx + "," + cz;
        if (meshedChunks.has(key) && generatedChunks.has(key)) continue;
        want.push({ cx, cz, d2 });
      }
    }
    if (!want.length) return;
    want.sort((a, b) => a.d2 - b.d2);

    const budget = force ? want.length : MAX_CHUNK_GENS_PER_FRAME;
    for (let i = 0; i < budget && i < want.length; i++) {
      generateChunkColumn(want[i].cx, want[i].cz);
    }
  }

  function unloadFarChunks(px, pz) {
    if (!cityLayout || currentMapType !== "city") return;

    const pcx = Math.floor(px / (CHUNK * VOXEL));
    const pcz = Math.floor(pz / (CHUNK * VOXEL));
    const R = UNLOAD_RADIUS,
      R2 = R * R;

    const toUnload = [];
    for (const key of meshedChunks) {
      const [cx, cz] = key.split(",").map(Number);
      const dx = cx - pcx,
        dz = cz - pcz;
      if (dx * dx + dz * dz > R2) toUnload.push(key);
    }
    for (const key of toUnload) {
      const [cx, cz] = key.split(",").map(Number);
      for (let cy = 0; cy < CHUNKS_Y; cy++) {
        const mk = cx + "," + cy + "," + cz;
        const entry = chunkMeshes.get(mk);
        if (!entry) continue;
        if (entry.opaque) {
          scene.remove(entry.opaque);
          entry.opaque.geometry.dispose();
        }
        if (entry.glass) {
          scene.remove(entry.glass);
          entry.glass.geometry.dispose();
        }
        chunkMeshes.delete(mk);
      }
      meshedChunks.delete(key);
    }
  }

  function fillInitialRing(px, pz, radius) {
    const pcx = Math.floor(px / (CHUNK * VOXEL));
    const pcz = Math.floor(pz / (CHUNK * VOXEL));
    const R = radius,
      R2 = R * R;
    const list = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const cx = pcx + dx,
          cz = pcz + dz;
        if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) continue;
        list.push({ cx, cz, d2 });
      }
    }
    list.sort((a, b) => a.d2 - b.d2);
    for (const { cx, cz } of list) generateChunkColumn(cx, cz);
  }

  function updateChunkStreaming() {
    if (!cityLayout || currentMapType !== "city") return;
    if (!player.alive) return;

    const px = player.pos.x,
      pz = player.pos.z;
    const pcx = Math.floor(px / (CHUNK * VOXEL));
    const pcz = Math.floor(pz / (CHUNK * VOXEL));

    streamChunks(px, pz, false);

    if (pcx !== lastStreamedCx || pcz !== lastStreamedCz) {
      lastStreamedCx = pcx;
      lastStreamedCz = pcz;
      unloadFarChunks(px, pz);
    }
  }

  /* =========================================================================
       12. PLAYER
       ========================================================================= */
  window.ARiveSandboxFlags = window.ARiveSandboxFlags || {
    infiniteAmmo: false,
    infiniteEnemyHealth: false,
    enemyLoop: false,
  };

  let creativeMode = false;

  const player = {
    pos: new THREE.Vector3(WORLD_W * 0.5, 4, WORLD_D * 0.5),
    vel: new THREE.Vector3(),

    targetYaw: 0,
    yaw: 0,
    baseYaw: 0,
    pitch: 0,

    onGround: false,
    halfW: 0.2 * PLAYER_SCALE,
    height: 1.62 * PLAYER_SCALE,
    eye: 1.54 * PLAYER_SCALE,
    walk: 4.5,
    sprint: 7.4,
    jump: 8.2,
    health: 100,
    hunger: 100,
    thirst: 100,
    alive: true,
    bob: 0,
    invuln: 0,

    crouching: false,
    crouchT: 0,

    smoothY: 0,
  };

  let _stepAccum = 0;
  const STEP_DISTANCE = 2.0;

  function surfaceAtPlayer() {
    const vx = Math.floor(player.pos.x / VOXEL);
    const vy = Math.floor((player.pos.y - 0.05) / VOXEL);
    const vz = Math.floor(player.pos.z / VOXEL);
    const b = getV(vx, vy, vz);
    if (!b) return "grass";
    if (b === 6 || b === 14 || b === 25 || b === 29) return "wood";
    if (b === 8 || b === 9 || b === 12 || b === 33 || b === 34) return "grass";
    return "stone";
  }

  const STEP_HEIGHT = 0.5;

  function tryStepUp(pos, hw, h, maxStep, testFn) {
    testFn = testFn || collidesAABB;
    const y0 = pos.y;
    const maxSteps = Math.ceil(maxStep / VOXEL) + 1;
    for (let s = 1; s <= maxSteps; s++) {
      pos.y = y0 + s * VOXEL;
      if (testFn(pos, hw, h)) continue;
      let by = pos.y;
      while (by - VOXEL >= y0 - 1e-6) {
        pos.y = by - VOXEL;
        if (testFn(pos, hw, h)) break;
        by -= VOXEL;
      }
      pos.y = by;
      return true;
    }
    pos.y = y0;
    return false;
  }

  function collidesAABB(pos, hw, h) {
    const x0 = Math.floor((pos.x - hw) / VOXEL + EPS);
    const x1 = Math.floor((pos.x + hw) / VOXEL - EPS);
    const y0 = Math.floor(pos.y / VOXEL + EPS);
    const y1 = Math.floor((pos.y + h) / VOXEL - EPS);
    const z0 = Math.floor((pos.z - hw) / VOXEL + EPS);
    const z1 = Math.floor((pos.z + hw) / VOXEL - EPS);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) if (getV(x, y, z) !== 0) return true;
    return false;
  }

  function playerHitsFurniture(pos, hw, h) {
    const plMinX = pos.x - hw,
      plMaxX = pos.x + hw;
    const plMinY = pos.y,
      plMaxY = pos.y + h;
    const plMinZ = pos.z - hw,
      plMaxZ = pos.z + hw;

    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (!p.mesh.visible) continue;
      if (!p.isFurniture) continue;
      if (!p.locked) continue;
      if (p.carriedBy) continue;
      if (furnMode && p === furnMode.p) continue;

      const bdx = p.mesh.position.x - pos.x;
      const bdz = p.mesh.position.z - pos.z;
      if (bdx * bdx + bdz * bdz > 4.0) continue;

      const minX = p.mesh.position.x + p.rotMin.x;
      const maxX = p.mesh.position.x + p.rotMax.x;
      const minY = p.mesh.position.y + p.rotMin.y;
      const maxY = p.mesh.position.y + p.rotMax.y;
      const minZ = p.mesh.position.z + p.rotMin.z;
      const maxZ = p.mesh.position.z + p.rotMax.z;

      if (plMaxX <= minX || plMinX >= maxX) continue;
      if (plMaxY <= minY || plMinY >= maxY) continue;
      if (plMaxZ <= minZ || plMinZ >= maxZ) continue;
      return true;
    }
    return false;
  }

  function collidesPlayer(pos, hw, h) {
    return collidesAABB(pos, hw, h) || playerHitsFurniture(pos, hw, h);
  }

  function placePlayerOnGround(wx, wz) {
    const vx = clamp(Math.floor(wx / VOXEL), 0, SX - 1);
    const vz = clamp(Math.floor(wz / VOXEL), 0, SZ - 1);
    player.pos.set((vx + 0.5) * VOXEL, (SY - 1) * VOXEL, (vz + 0.5) * VOXEL);
    for (let y = SY - 1; y > 0; y--) {
      if (getV(vx, y, vz) !== 0) {
        player.pos.y = (y + 1) * VOXEL + 0.02;
        break;
      }
    }
    player.smoothY = player.pos.y;
  }

  /* =========================================================================
   12.5  ITEM DEFINITIONS + 3D MODELS + THUMBNAILS
   ========================================================================= */
  const ITEM_DEFS = window.ITEM_DEFS_DATA || [
    {
      key: "sledge", name: "SLEDGE", w: 3, h: 1, color: "#7a5a2a",
      meta: {
        model: [
          { p: [0.0, 0.35, 0.0], s: [0.05, 0.7, 0.05], c: 0x5a3a18 },
          { p: [0.12, 0.68, 0.0], s: [0.32, 0.14, 0.1], c: 0x808890 },
        ],
        mass: 3.2,
      },
    },
    {
      key: "charge", name: "CHARGE", w: 2, h: 1, color: "#8a2a1a",
      meta: {
        model: [
          { p: [0, 0.12, 0], s: [0.2, 0.24, 0.2], c: 0xa04028 },
          { p: [0, 0.27, 0], s: [0.06, 0.07, 0.06], c: 0x404040 },
        ],
        mass: 1.8,
      },
    },
    {
      key: "medkit", name: "MEDKIT", w: 2, h: 2, color: "#a03a48",
      meta: {
        model: [
          { p: [0, 0.13, 0], s: [0.26, 0.26, 0.18], c: 0xd0d0c8 },
          { p: [0, 0.13, 0.1], s: [0.14, 0.05, 0.02], c: 0xc02020 },
          { p: [0, 0.13, 0.1], s: [0.05, 0.14, 0.02], c: 0xc02020 },
        ],
        mass: 0.6,
      },
    },
    {
      key: "ration", name: "RATION", w: 2, h: 2, color: "#4a6a2a",
      meta: {
        model: [
          { p: [0, 0.11, 0], s: [0.22, 0.22, 0.14], c: 0x6a7a4a },
          { p: [0, 0.23, 0], s: [0.22, 0.02, 0.14], c: 0x4a5a2a },
        ],
        mass: 0.8,
      },
    },
    {
      key: "water", name: "WATER", w: 1, h: 2, color: "#2a5a9a",
      meta: {
        model: [
          { p: [0, 0.18, 0], s: [0.13, 0.36, 0.13], c: 0x3a7ab0 },
          { p: [0, 0.38, 0], s: [0.07, 0.05, 0.07], c: 0x203040 },
        ],
        mass: 1.4,
      },
    },
    {
      key: "bandage", name: "BANDAGE", w: 1, h: 1, color: "#a06a6a",
      meta: {
        model: [
          { p: [0, 0.09, 0], s: [0.18, 0.18, 0.18], c: 0xd0c8b8 },
          { p: [0, 0.18, 0], s: [0.1, 0.02, 0.1], c: 0xb0a898 },
        ],
        mass: 0.45,
      },
    },
    {
      key: "battery", name: "BATTERY", w: 1, h: 1, color: "#5a5a2a",
      meta: {
        model: [
          { p: [0, 0.1, 0], s: [0.11, 0.2, 0.11], c: 0x404040 },
          { p: [0, 0.21, 0], s: [0.05, 0.03, 0.05], c: 0xb0a040 },
        ],
        mass: 2.0,
      },
    },
    {
      key: "wire", name: "WIRE", w: 2, h: 1, color: "#6a5a4a",
      meta: {
        model: [
          { p: [0, 0.07, 0], s: [0.2, 0.14, 0.2], c: 0x4a3a2a },
          { p: [0, 0.07, 0], s: [0.05, 0.16, 0.05], c: 0x808080 },
        ],
        mass: 1.1,
      },
    },
    {
      key: "canned", name: "CANNED", w: 1, h: 1, color: "#7a6a3a",
      meta: {
        model: [
          { p: [0, 0.1, 0], s: [0.16, 0.2, 0.16], c: 0x808890 },
          { p: [0, 0.21, 0], s: [0.16, 0.02, 0.16], c: 0xa0a8b0 },
        ],
        mass: 1.5,
      },
    },
    {
      key: "canister", name: "CANISTER", w: 2, h: 2, color: "#5a6a5a",
      meta: {
        model: [
          { p: [0, 0.22, 0], s: [0.28, 0.44, 0.28], c: 0x5a7a5a },
          { p: [0, 0.46, 0], s: [0.1, 0.05, 0.1], c: 0x404040 },
        ],
        mass: 3.5,
      },
    },
  ];

  const AMMO_MAX_STACK = 200;

  const AMMO_DEFS = [
    {
      key: "ammo_9mm", name: "9MM", w: 1, h: 1, color: "#b09040",
      isAmmo: true, ammoType: "9mm", maxStack: AMMO_MAX_STACK,
      meta: {
        mass: 0.35, isAmmo: true, ammoType: "9mm",
        model: [
          { p: [0, 0.05, 0], s: [0.22, 0.1, 0.15], c: 0x8a7030 },
          { p: [0, 0.11, 0], s: [0.22, 0.02, 0.15], c: 0x605020 },
          { p: [-0.06, 0.13, 0], s: [0.03, 0.03, 0.03], c: 0xd0a040 },
          { p: [0.0, 0.13, 0], s: [0.03, 0.03, 0.03], c: 0xd0a040 },
          { p: [0.06, 0.13, 0], s: [0.03, 0.03, 0.03], c: 0xd0a040 },
        ],
      },
    },
    {
      key: "ammo_556", name: "5.56", w: 1, h: 1, color: "#a0803a",
      isAmmo: true, ammoType: "5.56", maxStack: AMMO_MAX_STACK,
      meta: {
        mass: 0.45, isAmmo: true, ammoType: "5.56",
        model: [
          { p: [0, 0.06, 0], s: [0.24, 0.12, 0.16], c: 0x7a6830 },
          { p: [0, 0.13, 0], s: [0.24, 0.02, 0.16], c: 0x504018 },
          { p: [-0.07, 0.15, 0], s: [0.03, 0.04, 0.03], c: 0xc09030 },
          { p: [0.0, 0.15, 0], s: [0.03, 0.04, 0.03], c: 0xc09030 },
          { p: [0.07, 0.15, 0], s: [0.03, 0.04, 0.03], c: 0xc09030 },
        ],
      },
    },
    {
      key: "ammo_shell", name: "SHELL", w: 1, h: 1, color: "#b04030",
      isAmmo: true, ammoType: "shell", maxStack: AMMO_MAX_STACK,
      meta: {
        mass: 0.55, isAmmo: true, ammoType: "shell",
        model: [
          { p: [0, 0.06, 0], s: [0.24, 0.12, 0.14], c: 0x8a2a20 },
          { p: [0, 0.13, 0], s: [0.24, 0.02, 0.14], c: 0x5a1812 },
          { p: [-0.07, 0.15, 0], s: [0.04, 0.05, 0.04], c: 0xd0a040 },
          { p: [0.0, 0.15, 0], s: [0.04, 0.05, 0.04], c: 0xd0a040 },
          { p: [0.07, 0.15, 0], s: [0.04, 0.05, 0.04], c: 0xd0a040 },
        ],
      },
    },
  ];

  const _AMMO_KEYS = new Set(AMMO_DEFS.map((a) => a.key));
  const _AMMO_NAMES = new Set(
    AMMO_DEFS.map((a) => String(a.name).toUpperCase()),
  );
  const _AMMO_TYPES = new Set(
    AMMO_DEFS.map((a) => String(a.ammoType).toLowerCase()),
  );

  for (let i = ITEM_DEFS.length - 1; i >= 0; i--) {
    const d = ITEM_DEFS[i];
    if (!d) continue;

    const collides =
      (d.key && _AMMO_KEYS.has(d.key)) ||
      (d.ammoType && _AMMO_TYPES.has(String(d.ammoType).toLowerCase())) ||
      (d.name && _AMMO_NAMES.has(String(d.name).toUpperCase()));

    if (collides && !d.isAmmo) {
      console.warn(
        "[ARive] dropping duplicate ammo def from ITEM_DEFS_DATA:",
        d.key || d.name,
      );
      ITEM_DEFS.splice(i, 1);
    }
  }

  for (const a of AMMO_DEFS) {
    if (!ITEM_DEFS.some((d) => d.key === a.key)) ITEM_DEFS.push(a);
  }

  for (const d of ITEM_DEFS) {
    if (!d) continue;
    if (!d.model && d.meta && Array.isArray(d.meta.model)) {
      d.model = d.meta.model;
    }
    if (d.model && (!d.meta || !d.meta.model)) {
      if (!d.meta) d.meta = {};
      d.meta.model = d.model;
    }
  }

  const AMMO_BY_TYPE = Object.create(null);
  for (const a of AMMO_DEFS) AMMO_BY_TYPE[a.ammoType] = a;

  function buildItemMesh(model) {
    const g = new THREE.Group();
    for (const b of model) {
      const geo = new THREE.BoxGeometry(b.s[0], b.s[1], b.s[2]);

      const matOpts = { color: b.c, fog: true };
      if (b.e) {
        matOpts.emissive = b.e;
        matOpts.emissiveIntensity = 1.0;
      }
      const mat = new THREE.MeshLambertMaterial(matOpts);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(b.p[0], b.p[1], b.p[2]);
      if (b.r) m.rotation.set(b.r[0], b.r[1], b.r[2]);
      g.add(m);

      if (b.e) {
        const haloMat = new THREE.MeshBasicMaterial({
          color: b.e,
          transparent: true,
          opacity: 0.35,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        });
        const halo = new THREE.Mesh(
          new THREE.BoxGeometry(b.s[0] * 1.18, b.s[1] * 1.18, b.s[2] * 1.18),
          haloMat,
        );
        halo.renderOrder = 5;
        m.add(halo);
      }
    }
    return g;
  }

  let _thumbRenderer = null,
    _thumbScene = null,
    _thumbCamera = null;
  function _initThumbRenderer() {
    if (_thumbRenderer) return;
    _thumbRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    _thumbRenderer.setSize(128, 128);
    _thumbRenderer.setClearColor(0x000000, 0);
    _thumbRenderer.setPixelRatio(1);

    _thumbScene = new THREE.Scene();
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(1.2, 2.0, 1.5);
    _thumbScene.add(key);
    const fill = new THREE.DirectionalLight(0x8899bb, 0.55);
    fill.position.set(-1.5, 0.5, -1.0);
    _thumbScene.add(fill);
    _thumbScene.add(new THREE.AmbientLight(0xffffff, 0.55));

    _thumbCamera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);
    _thumbCamera.position.set(0.62, 0.55, 0.62);
    _thumbCamera.lookAt(0, 0.18, 0);
  }

  function _fitCameraToModel(camera, mesh, aspect, padding) {
    mesh.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      return;
    }

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const dir = new THREE.Vector3(0.62, 0.55, 0.62).normalize();
    const dist = size.length() * 2 + 0.2;

    camera.position.copy(center).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    let maxTanX = 0,
      maxTanY = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      );
      v.applyMatrix4(camera.matrixWorldInverse);
      const depth = -v.z;
      if (depth <= 1e-3) continue;
      const tx = Math.abs(v.x) / depth;
      const ty = Math.abs(v.y) / depth;
      if (tx > maxTanX) maxTanX = tx;
      if (ty > maxTanY) maxTanY = ty;
    }

    const needTan = Math.max(maxTanY, maxTanX / aspect);
    const vFOV = 2 * Math.atan(needTan * padding);

    camera.fov = (vFOV * 180) / Math.PI;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  function _thumbModelCentre(model) {
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    for (const b of model) {
      if (b.p[0] - b.s[0] * 0.5 < mnX) mnX = b.p[0] - b.s[0] * 0.5;
      if (b.p[0] + b.s[0] * 0.5 > mxX) mxX = b.p[0] + b.s[0] * 0.5;
      if (b.p[1] - b.s[1] * 0.5 < mnY) mnY = b.p[1] - b.s[1] * 0.5;
      if (b.p[1] + b.s[1] * 0.5 > mxY) mxY = b.p[1] + b.s[1] * 0.5;
      if (b.p[2] - b.s[2] * 0.5 < mnZ) mnZ = b.p[2] - b.s[2] * 0.5;
      if (b.p[2] + b.s[2] * 0.5 > mxZ) mxZ = b.p[2] + b.s[2] * 0.5;
    }
    return { x: (mnX + mxX) * 0.5, y: (mnY + mxY) * 0.5, z: (mnZ + mxZ) * 0.5 };
  }

  function _modelSize(model) {
    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    for (const b of model) {
      const hx = b.s[0] * 0.5, hy = b.s[1] * 0.5, hz = b.s[2] * 0.5;
      if (b.p[0] - hx < mnX) mnX = b.p[0] - hx;
      if (b.p[0] + hx > mxX) mxX = b.p[0] + hx;
      if (b.p[1] - hy < mnY) mnY = b.p[1] - hy;
      if (b.p[1] + hy > mxY) mxY = b.p[1] + hy;
      if (b.p[2] - hz < mnZ) mnZ = b.p[2] - hz;
      if (b.p[2] + hz > mxZ) mxZ = b.p[2] + hz;
    }
    return { x: mxX - mnX, y: mxY - mnY, z: mxZ - mnZ };
  }

  function _autoIconRot(model, tileAspect) {
    const s = _modelSize(model);

    let dominant = "x";
    let maxLen = s.x;
    if (s.y > maxLen) { dominant = "y"; maxLen = s.y; }
    if (s.z > maxLen) { dominant = "z"; maxLen = s.z; }

    if (tileAspect > 1.1) {
      if (dominant === "y") return [0, 0, Math.PI / 2];
      if (dominant === "z") return [0, Math.PI / 2, 0];
      return [0, 0, 0];
    }
    if (tileAspect < 0.9) {
      if (dominant === "x") return [0, 0, Math.PI / 2];
      if (dominant === "z") return [Math.PI / 2, 0, 0];
      return [0, 0, 0];
    }
    return [0, 0, 0];
  }

  function _resolveIconTxForAspect(def, tileAspect) {
    const baseR = def.iconR || [0, 0, 0];
    const baseP = def.iconP || [0, 0, 0];
    const baseS =
      typeof def.iconScale === "number" && def.iconScale > 0
        ? def.iconScale
        : 1;

    const W = def.w,
      H = def.h;

    if (W === H) {
      return { r: baseR, p: baseP, s: baseS, auto: Math.abs(baseR[2]) < 0.01 };
    }

    const itemIsWide = W > H;
    const tileIsWide = tileAspect > 1.1;
    const tileIsTall = tileAspect < 0.9;
    const sameOrientation =
      (itemIsWide && tileIsWide) ||
      (!itemIsWide && tileIsTall) ||
      (!tileIsWide && !tileIsTall);

    if (sameOrientation) {
      return { r: baseR, p: baseP, s: baseS, auto: Math.abs(baseR[2]) < 0.01 };
    }

    if (tileIsWide && def.iconLandscape) {
      const t = def.iconLandscape;
      return { r: t.r, p: t.p, s: t.s, auto: false };
    }
    if (tileIsTall && def.iconPortrait) {
      const t = def.iconPortrait;
      return { r: t.r, p: t.p, s: t.s, auto: false };
    }

    return { r: [0, 0, 0], p: baseP, s: baseS, auto: true };
  }

  function buildThumbnailMesh(def, tileAspect) {
    const c = _thumbModelCentre(def.model);

    const inner = buildItemMesh(def.model);
    inner.position.set(-c.x, -c.y, -c.z);

    const pivot = new THREE.Group();
    pivot.add(inner);

    const tx = _resolveIconTxForAspect(def, tileAspect);
    const autoR = tx.auto ? _autoIconRot(def.model, tileAspect) : [0, 0, 0];

    pivot.rotation.set(
      tx.r[0] + autoR[0],
      tx.r[1] + autoR[1],
      tx.r[2] + autoR[2],
    );

    pivot.position.set(tx.p[0], tx.p[1], tx.p[2]);
    pivot.scale.setScalar(tx.s);

    const g = new THREE.Group();
    g.add(pivot);
    return g;
  }

  function renderItemThumbnail(def, targetW, targetH) {
    targetW = targetW || def.w;
    targetH = targetH || def.h;

    _initThumbRenderer();

    const CELL = 44;
    const INSET_X = 4;
    const INSET_TOP = 4;
    const INSET_BOTTOM = 14;

    const innerW = Math.max(8, targetW * CELL - 2 * INSET_X);
    const innerH = Math.max(8, targetH * CELL - INSET_TOP - INSET_BOTTOM);
    const aspect = innerW / innerH;

    const LONG = 160;
    let rw, rh;
    if (aspect >= 1) {
      rw = LONG;
      rh = Math.max(1, Math.round(LONG / aspect));
    } else {
      rh = LONG;
      rw = Math.max(1, Math.round(LONG * aspect));
    }

    _thumbRenderer.setSize(rw, rh, false);
    _thumbRenderer.domElement.width = rw;
    _thumbRenderer.domElement.height = rh;

    const mesh = buildThumbnailMesh(def, aspect);
    _thumbScene.add(mesh);

    const tx = _resolveIconTxForAspect(def, aspect);
    const piv = mesh.children[0];

    const savedPos = piv.position.clone();
    piv.position.set(0, 0, 0);
    piv.scale.setScalar(1);
    _fitCameraToModel(_thumbCamera, mesh, aspect, 1.06);
    piv.position.copy(savedPos);
    piv.scale.setScalar(tx.s);

    _thumbRenderer.render(_thumbScene, _thumbCamera);

    const url = _thumbRenderer.domElement.toDataURL("image/png");

    _thumbScene.remove(mesh);
    mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    return url;
  }

  const FURNITURE_BASE = "assets/model/furnitureModel/";

  function _resolveHexColor(v) {
    if (typeof v === "number") return v | 0;
    if (typeof v !== "string") return 0xff00ff;
    const s = v.trim().replace(/^#/, "").replace(/^0x/i, "");
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n : 0xff00ff;
  }

  function _normalizeFurniture(f) {
    if (!f || !f.meta || !Array.isArray(f.meta.model)) return null;
    for (const part of f.meta.model) {
      if ("c" in part) part.c = _resolveHexColor(part.c);
      if ("e" in part) part.e = _resolveHexColor(part.e);
    }
    if (!f.model) f.model = f.meta.model;
    return f;
  }

  async function loadFurnitureFromFolder() {
    window.ARIVE_FURNITURE = window.ARIVE_FURNITURE || [];

    let names = window.ARIVE_FURNITURE_FILES || null;

    if (!names || !names.length) {
      const listing = await fetchDirectoryListing(FURNITURE_BASE);
      if (listing !== null) names = extractJsonNames(listing);
    }

    if (!names || !names.length) {
      console.log(
        "[ARive] No furniture files listed — " +
        "using whatever ARIVE_FURNITURE already holds.",
      );
      return;
    }

    console.log(
      "[ARive] Loading " + names.length + " furniture file(s):",
      names.join(", "),
    );

    const loaded = await Promise.all(
      names.map(async (name) => {
        try {
          const r = await fetch(FURNITURE_BASE + name, { cache: "no-cache" });
          if (!r.ok) {
            console.warn("[ARive] ✗", name, r.status);
            return null;
          }
          return _normalizeFurniture(await r.json());
        } catch (e) {
          console.warn("[ARive] ✗", name, e.message);
          return null;
        }
      }),
    );

    for (const f of loaded) {
      if (!f || !f.key) continue;
      const idx = window.ARIVE_FURNITURE.findIndex((x) => x.key === f.key);
      if (idx >= 0) window.ARIVE_FURNITURE[idx] = f;
      else window.ARIVE_FURNITURE.push(f);
      console.log(
        "[ARive] ✓ furniture",
        f.key,
        "(" + f.size + ", " + f.meta.model.length + " parts)",
      );
    }
  }

  const STUB_INVENTORY = {
    isOpen: false,
    open() { },
    close() { },
    toggle() { },
    addItem() {
      return false;
    },
    addToIncoming() { },
  };

  let inventory = STUB_INVENTORY;
  let itemsInitialized = false;

  async function initItemsAndInventory() {
    if (itemsInitialized) return;
    itemsInitialized = true;

    try {
      await loadFurnitureFromFolder();

      if (window.ARIVE_FURNITURE && Array.isArray(window.ARIVE_FURNITURE)) {
        for (const f of window.ARIVE_FURNITURE) {
          if (!f.meta) f.meta = {};
          if (!f.model && Array.isArray(f.meta.model)) f.model = f.meta.model;
          if (!f.meta.model && Array.isArray(f.model)) f.meta.model = f.model;
          ITEM_DEFS.push(f);
        }
        console.log(
          "[ARive] merged " +
          window.ARIVE_FURNITURE.length +
          " furniture item(s) into ITEM_DEFS",
        );
      }

      for (const def of ITEM_DEFS) {
        def.iconImage = renderItemThumbnail(def, def.w, def.h);
        if (def.w !== def.h) {
          def.iconImageRotated = renderItemThumbnail(def, def.h, def.w);
        }
      }

      inventory = new GridInventory({
        cols: 10,
        rows: 6,
        onOpen: () => {
          mouseDown = false;
          throwCharging = false;
          if (typeof heldPickup !== "undefined" && heldPickup) releasePickup(0);
          document.exitPointerLock();
        },
        onClose: () => {
          if (gameRunning && player.alive) {
            requestPointerLockSafely();
          }
        },
        onDropOutside: (item) => {
          dropItemInWorld(item);
        },
      });

      if (window.Weapons && window.Weapons.setSlotChangeHandler) {
        window.Weapons.setSlotChangeHandler(() => {
          try {
            inventory.syncWeaponSlots();
          } catch (err) {
            console.error("[ARive] weapon slot sync failed:", err);
          }
        });
      }

      for (const def of ITEM_DEFS) {
        if (def.isAmmo) continue;
        if (def.key && String(def.key).startsWith("ammo_")) continue;
        if (_AMMO_NAMES.has(String(def.name || "").toUpperCase())) continue;

        const isFurnitureItem =
          def.size === "small" || def.size === "medium" || def.size === "large";

        inventory.addItem({
          name: def.name,
          iconImage: def.iconImage,
          iconImageRotated: def.iconImageRotated,
          w: def.w,
          h: def.h,
          color: def.color,
          meta: { model: def.model },
          size: isFurnitureItem ? def.size : undefined,
          furnitureKey: isFurnitureItem ? def.key : undefined,
        });
      }
    } catch (e) {
      console.error(
        "[ARive] item / inventory init FAILED — the game " +
        "will keep running with a stub inventory.  See the error below:",
      );
      console.error(e);
      inventory = STUB_INVENTORY;
    }
  }

  /* =========================================================================
   12.6  WORLD PICKUPS
   ========================================================================= */
  const pickups = [];
  const PICKUP_GRAVITY = 22;

  const DROP_DISTANCE = 2.2;
  const PICKUP_RANGE = 3.0;

  const PICKUP_BOUNCE = 0.1;
  const PICKUP_SETTLE_SPEED = 2.2;
  const KICK_FORCE = 0.45;

  const HAND_RANGE = 3.0;
  const HAND_HOLD_DISTANCE = 1.15;

  const THROW_MIN_FORCE = 0;
  const THROW_MAX_FORCE = 18;
  const THROW_CHARGE_TIME = 1.2;

  let throwCharging = false;
  let throwChargeStart = 0;

  let currentPickupTarget = null;
  let heldPickup = null;

  const _qSpin = new THREE.Quaternion();
  const _spinAxis = new THREE.Vector3();
  const _handTarget = new THREE.Vector3();
  const _handOffset = new THREE.Vector3(0, -0.18, -HAND_HOLD_DISTANCE);

  const _qAlign = new THREE.Quaternion();
  const _qDelta = new THREE.Quaternion();

  const ALIGN_K_GROUND = 260;
  const ALIGN_C_GROUND = 32;
  const ALIGN_K_AIR = 55;
  const ALIGN_C_AIR = 9;

  const pickupOutline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  );
  pickupOutline.renderOrder = 999;
  pickupOutline.matrixAutoUpdate = true;
  pickupOutline.visible = false;
  scene.add(pickupOutline);

  const _outlineCenter = new THREE.Vector3();
  const _outlineSize = new THREE.Vector3();

  const pickupPromptEl = (function () {
    let el = document.getElementById("pickupPrompt");
    if (!el) {
      el = document.createElement("div");
      el.id = "pickupPrompt";
      el.style.cssText =
        "position:fixed;left:50%;top:calc(50% + 34px);" +
        "transform:translateX(-50%);z-index:6;" +
        'font:bold 13px "Courier New",monospace;letter-spacing:2px;' +
        "color:#e8c86a;text-shadow:2px 2px 0 #000,0 0 12px rgba(232,200,106,.5);" +
        "pointer-events:none;opacity:0;transition:opacity .1s;white-space:nowrap;";
      document.body.appendChild(el);
    }
    return el;
  })();

  const throwChargeBarEl = (function () {
    let el = document.getElementById("throwCharge");
    if (!el) {
      el = document.createElement("div");
      el.id = "throwCharge";
      el.style.cssText =
        "position:fixed;left:50%;bottom:150px;transform:translateX(-50%);" +
        "width:200px;height:14px;background:#12161d;border:2px solid #2b333f;" +
        "box-shadow:inset 0 0 0 1px #05070a,0 0 12px rgba(0,0,0,.6);" +
        "z-index:6;pointer-events:none;opacity:0;transition:opacity .12s;";

      const fill = document.createElement("div");
      fill.id = "throwChargeFill";
      fill.style.cssText =
        "height:100%;width:0%;" +
        "background:linear-gradient(to right,#80a050,#e8c86a,#d04030);" +
        "transition:width .03s linear;";
      el.appendChild(fill);

      const label = document.createElement("div");
      label.textContent = "THROW POWER";
      label.style.cssText =
        "position:absolute;left:50%;top:-16px;transform:translateX(-50%);" +
        'font:bold 10px "Courier New",monospace;letter-spacing:2px;' +
        "color:#e8c86a;text-shadow:1px 1px 0 #000;white-space:nowrap;";
      el.appendChild(label);

      document.body.appendChild(el);
    }
    return el;
  })();

  const eHoldBarEl = (function () {
    let el = document.getElementById("eHoldBar");
    if (!el) {
      el = document.createElement("div");
      el.id = "eHoldBar";
      el.style.cssText =
        "position:fixed;left:50%;bottom:186px;transform:translateX(-50%);" +
        "width:220px;height:16px;background:#12161d;border:2px solid #e8c86a;" +
        "box-shadow:inset 0 0 0 1px #05070a,0 0 14px rgba(232,200,106,.35);" +
        "z-index:6;pointer-events:none;opacity:0;transition:opacity .12s;";

      const fill = document.createElement("div");
      fill.id = "eHoldBarFill";
      fill.style.cssText =
        "height:100%;width:0%;" +
        "background:linear-gradient(to right,#6a9a40,#e8c86a);" +
        "transition:width .03s linear;";
      el.appendChild(fill);

      const label = document.createElement("div");
      label.textContent = "LIFTING";
      label.style.cssText =
        "position:absolute;left:50%;top:-18px;transform:translateX(-50%);" +
        'font:bold 11px "Courier New",monospace;letter-spacing:3px;' +
        "color:#e8c86a;text-shadow:1px 1px 0 #000;white-space:nowrap;";
      el.appendChild(label);

      document.body.appendChild(el);
    }
    return el;
  })();

  let furnMode = null;
  let eHeldFurniture = null;
  let eHeldStart = 0;

  const E_FURN_HOLD_MS = 1000;
  const E_FURN_ROT_GRACE_MS = 300;
  const FURN_PREVIEW_DIST = 2.4;
  const FURN_ROT_STEP = Math.PI / 180;

  let qHeld = false;
  let eHeld = false;
  const FURN_ROT_FAST = Math.PI * 1.2;

  function enterFurnitureCarry(p) {
    if (furnMode) return;
    qHeld = false;
    eHeld = false;

    furnMode = {
      p,
      rotY: 0,
      baseQuat: p.mesh.quaternion.clone(),
      liftedAt: performance.now(),
    };
    p.carriedBy = "local";
    p.locked = false;
    p.settled = false;
    p.vx = p.vy = p.vz = 0;
    p.avx = p.avy = p.avz = 0;
  }

  function rotateFurnitureBy(d) {
    if (!furnMode) return;
    furnMode.rotY += d;
    const TAU = Math.PI * 2;
    furnMode.rotY = ((furnMode.rotY % TAU) + TAU) % TAU;
  }

  function updateFurnitureMode(dt) {
    if (!furnMode) return;
    const p = furnMode.p;

    const origin = camera.position;
    const dir = getLookDir();
    const hit = raycastVoxel(origin, dir, FURN_PREVIEW_DIST + 1.5);

    let tx, ty, tz;
    if (hit && hit.ny === 1) {
      tx = (hit.x + 0.5) * VOXEL;
      ty = (hit.y + 1.0) * VOXEL - p.aabb.min.y;
      tz = (hit.z + 0.5) * VOXEL;
    } else if (hit) {
      tx = (hit.x + 0.5 + hit.nx * 0.5) * VOXEL;
      ty = (hit.y + 0.5 + hit.ny * 0.5) * VOXEL - p.aabb.min.y;
      tz = (hit.z + 0.5 + hit.nz * 0.5) * VOXEL;
    } else {
      tx = origin.x + dir.x * FURN_PREVIEW_DIST;
      ty = origin.y + dir.y * FURN_PREVIEW_DIST - p.aabb.min.y;
      tz = origin.z + dir.z * FURN_PREVIEW_DIST;
    }

    const k = Math.min(1, dt * 20);
    p.mesh.position.x += (tx - p.mesh.position.x) * k;
    p.mesh.position.y += (ty - p.mesh.position.y) * k;
    p.mesh.position.z += (tz - p.mesh.position.z) * k;

    if (qHeld) rotateFurnitureBy(-FURN_ROT_FAST * dt);
    if (eHeld) rotateFurnitureBy(FURN_ROT_FAST * dt);

    const qy = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      furnMode.rotY,
    );
    p.mesh.quaternion.copy(qy).multiply(furnMode.baseQuat);

    computeRotatedAABB(p);
  }

  function placeFurniture() {
    if (!furnMode) return;
    qHeld = false;
    eHeld = false;

    const p = furnMode.p;
    p.carriedBy = null;
    p.vx = p.vy = p.vz = 0;
    p.avx = p.avy = p.avz = 0;
    computeRotatedAABB(p);
    seatOnFloor(p);
    p.settled = true;
    p.locked = true;
    furnMode = null;
    if (
      !p.isRemote &&
      p.pid &&
      window.ARiveMP &&
      window.ARiveMP.connected &&
      window.ARiveMP.onLocalPickupSettled
    ) {
      window.ARiveMP.onLocalPickupSettled(p);
    }
  }

  function storeFurniture() {
    if (!furnMode) return;
    qHeld = false;
    eHeld = false;
    const p = furnMode.p;
    furnMode = null;
    p.carriedBy = null;
    p.vx = p.vy = p.vz = 0;
    p.avx = p.avy = p.avz = 0;

    const result = attemptInventoryAdd(p.def);
    if (result !== "none") {
      scene.remove(p.mesh);
      p.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      const idx = pickups.indexOf(p);
      if (idx >= 0) pickups.splice(idx, 1);
      if (p.pid && window.ARiveMP && window.ARiveMP.connected) {
        window.ARiveMP.onLocalPickupRemove(p);
      }
      if (result === "incoming" || result === "overflow") {
        inventory.open();
      }
    } else {
      computeRotatedAABB(p);
      seatOnFloor(p);
      p.settled = true;
      p.locked = true;
    }
  }

  function attemptInventoryAdd(def) {
    if (inventory.addItem(def)) return "stored";

    if (typeof inventory.addToIncoming === "function") {
      inventory.addToIncoming(def);
      return "incoming";
    }

    if (typeof inventory.showOverflowPanel === "function") {
      inventory.onOverflowDropToFloor = (itemDef) => {
        spawnPickup(
          itemDef,
          new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z),
        );
        showToast("Item dropped to floor");
      };
      inventory.onOverflowSwapComplete = () => {
        showToast("Item swapped into inventory");
      };
      inventory.showOverflowPanel(def);
      inventory.open();
      return "overflow";
    }

    return "none";
  }

  function updateThrowChargeHud() {
    const fill = document.getElementById("throwChargeFill");
    if (!fill) return;

    if (throwCharging && heldPickup) {
      const elapsed = (performance.now() - throwChargeStart) / 1000;
      const t = Math.min(1, elapsed / THROW_CHARGE_TIME);
      fill.style.width = (t * 100).toFixed(1) + "%";
      throwChargeBarEl.style.opacity = "1";
    } else {
      throwChargeBarEl.style.opacity = "0";
      fill.style.width = "0%";
    }
  }

  const _modelAABBCache = new Map();

  function computeModelAABB(model) {
    let cached = _modelAABBCache.get(model);
    if (cached) return cached;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of model) {
      if (b.p[0] - b.s[0] * 0.5 < minX) minX = b.p[0] - b.s[0] * 0.5;
      if (b.p[0] + b.s[0] * 0.5 > maxX) maxX = b.p[0] + b.s[0] * 0.5;
      if (b.p[1] - b.s[1] * 0.5 < minY) minY = b.p[1] - b.s[1] * 0.5;
      if (b.p[1] + b.s[1] * 0.5 > maxY) maxY = b.p[1] + b.s[1] * 0.5;
      if (b.p[2] - b.s[2] * 0.5 < minZ) minZ = b.p[2] - b.s[2] * 0.5;
      if (b.p[2] + b.s[2] * 0.5 > maxZ) maxZ = b.p[2] + b.s[2] * 0.5;
    }
    cached = {
      min: new THREE.Vector3(minX, minY, minZ),
      max: new THREE.Vector3(maxX, maxY, maxZ),
      extent: Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5,
      restY: minY,
    };
    _modelAABBCache.set(model, cached);
    return cached;
  }

  const _aabbCornerScratch = new THREE.Vector3();

  function computeRotatedAABB(p) {
    const a = p.aabb;
    const q = p.mesh.quaternion;

    const mnX = a.min.x, mnY = a.min.y, mnZ = a.min.z;
    const mxX = a.max.x, mxY = a.max.y, mxZ = a.max.z;

    let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
    let rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;

    for (let i = 0; i < 8; i++) {
      _aabbCornerScratch
        .set(i & 1 ? mxX : mnX, i & 2 ? mxY : mnY, i & 4 ? mxZ : mnZ)
        .applyQuaternion(q);

      const cx = _aabbCornerScratch.x;
      const cy = _aabbCornerScratch.y;
      const cz = _aabbCornerScratch.z;

      if (cx < rMinX) rMinX = cx;
      if (cx > rMaxX) rMaxX = cx;
      if (cy < rMinY) rMinY = cy;
      if (cy > rMaxY) rMaxY = cy;
      if (cz < rMinZ) rMinZ = cz;
      if (cz > rMaxZ) rMaxZ = cz;
    }

    p.rotMin.set(rMinX, rMinY, rMinZ);
    p.rotMax.set(rMaxX, rMaxY, rMaxZ);
  }

  const _EQUIL_AXES = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
  const _equilWorldAxis = new THREE.Vector3();
  const _equilUp = new THREE.Vector3(0, 1, 0);
  const _equilCorrection = new THREE.Quaternion();

  function computeEquilibriumQuat(q, out) {
    let bestAxis = _EQUIL_AXES[0];
    let bestDot = -Infinity;
    for (let i = 0; i < 6; i++) {
      _equilWorldAxis.copy(_EQUIL_AXES[i]).applyQuaternion(q);
      if (_equilWorldAxis.y > bestDot) {
        bestDot = _equilWorldAxis.y;
        bestAxis = _EQUIL_AXES[i];
      }
    }
    _equilWorldAxis.copy(bestAxis).applyQuaternion(q);
    _equilCorrection.setFromUnitVectors(_equilWorldAxis, _equilUp);
    out.copy(q).premultiply(_equilCorrection);
    return out;
  }

  function itemHitsVoxels(p) {
    const ox = p.mesh.position.x,
      oy = p.mesh.position.y,
      oz = p.mesh.position.z;
    const minX = ox + p.rotMin.x,
      maxX = ox + p.rotMax.x;
    const minY = oy + p.rotMin.y,
      maxY = oy + p.rotMax.y;
    const minZ = oz + p.rotMin.z,
      maxZ = oz + p.rotMax.z;
    const x0 = Math.floor(minX / VOXEL + EPS);
    const x1 = Math.floor(maxX / VOXEL - EPS);
    const y0 = Math.floor(minY / VOXEL + EPS);
    const y1 = Math.floor(maxY / VOXEL - EPS);
    const z0 = Math.floor(minZ / VOXEL + EPS);
    const z1 = Math.floor(maxZ / VOXEL - EPS);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) if (getV(x, y, z) !== 0) return true;
    return false;
  }

  function seatOnFloor(p) {
    computeRotatedAABB(p);

    if (itemHitsVoxels(p)) {
      resolveVoxelPenetration(p);
      computeRotatedAABB(p);
    }

    let guard = 0;
    while (guard++ < 100) {
      const savedY = p.mesh.position.y;
      p.mesh.position.y = savedY - VOXEL * 0.1;
      if (itemHitsVoxels(p)) {
        p.mesh.position.y = savedY;
        return;
      }
    }
  }

  function resolveVoxelPenetration(p) {
    let guard = 0;
    while (guard++ < 24) {
      computeRotatedAABB(p);

      const ox = p.mesh.position.x,
        oy = p.mesh.position.y,
        oz = p.mesh.position.z;
      const minX = ox + p.rotMin.x,
        maxX = ox + p.rotMax.x;
      const minY = oy + p.rotMin.y,
        maxY = oy + p.rotMax.y;
      const minZ = oz + p.rotMin.z,
        maxZ = oz + p.rotMax.z;

      const x0 = Math.floor(minX / VOXEL + EPS);
      const x1 = Math.floor(maxX / VOXEL - EPS);
      const y0 = Math.floor(minY / VOXEL + EPS);
      const y1 = Math.floor(maxY / VOXEL - EPS);
      const z0 = Math.floor(minZ / VOXEL + EPS);
      const z1 = Math.floor(maxZ / VOXEL - EPS);

      let hit = false;
      let bestDist = Infinity;
      let bestAxis = -1;
      let bestSign = 0;

      for (let vy = y0; vy <= y1; vy++) {
        for (let vz = z0; vz <= z1; vz++) {
          for (let vx = x0; vx <= x1; vx++) {
            if (getV(vx, vy, vz) === 0) continue;
            hit = true;

            const vMinX = vx * VOXEL, vMaxX = vMinX + VOXEL;
            const vMinY = vy * VOXEL, vMaxY = vMinY + VOXEL;
            const vMinZ = vz * VOXEL, vMaxZ = vMinZ + VOXEL;

            const pushNegX = maxX - vMinX;
            const pushPosX = vMaxX - minX;
            const pushNegY = maxY - vMinY;
            const pushPosY = vMaxY - minY;
            const pushNegZ = maxZ - vMinZ;
            const pushPosZ = vMaxZ - minZ;

            let d = pushNegX < pushPosX ? pushNegX : pushPosX;
            let ax = 0;
            let sg = pushNegX < pushPosX ? -1 : 1;

            const dY = pushNegY < pushPosY ? pushNegY : pushPosY;
            if (dY < d) {
              d = dY;
              ax = 1;
              sg = pushNegY < pushPosY ? -1 : 1;
            }

            const dZ = pushNegZ < pushPosZ ? pushNegZ : pushPosZ;
            if (dZ < d) {
              d = dZ;
              ax = 2;
              sg = pushNegZ < pushPosZ ? -1 : 1;
            }

            if (d < bestDist) {
              bestDist = d;
              bestAxis = ax;
              bestSign = sg;
            }
          }
        }
      }

      if (!hit) return;

      const push = bestDist + EPS;
      if (bestAxis === 0) {
        p.mesh.position.x += bestSign * push;
        if (p.vx * bestSign < 0) p.vx = 0;
      } else if (bestAxis === 1) {
        p.mesh.position.y += bestSign * push;
        if (p.vy * bestSign < 0) p.vy = 0;
      } else {
        p.mesh.position.z += bestSign * push;
        if (p.vz * bestSign < 0) p.vz = 0;
      }
    }
  }

  function spawnPickup(item, worldPos, remotePid, initialYaw) {
    const model = item.meta && item.meta.model;
    if (!model) return null;
    const mesh = buildItemMesh(model);
    mesh.position.copy(worldPos);

    mesh.rotation.y =
      typeof initialYaw === "number" ? initialYaw : Math.random() * Math.PI * 2;

    scene.add(mesh);

    const aabb = computeModelAABB(model);

    const p = {
      pid:
        remotePid ||
        "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      isRemote: !!remotePid,
      def: {
        name: item.name,
        iconImage: item.iconImage,
        iconImageRotated: item.iconImageRotated,
        w: item.w,
        h: item.h,
        color: item.color,
        meta: item.meta,
        size: item.size,
        furnitureKey: item.furnitureKey,

        count: item.count,
        maxStack: item.maxStack,
        isAmmo: !!item.isAmmo,
        ammoType: item.ammoType,

        isWeapon: !!item.isWeapon,
        weaponDef: item.weaponDef || null,
      },
      mesh: mesh,
      aabb: aabb,
      restY: aabb.restY,
      rotMin: new THREE.Vector3(),
      rotMax: new THREE.Vector3(),
      vx: (Math.random() - 0.5) * 0.35,
      vy: 0,
      vz: (Math.random() - 0.5) * 0.35,
      avx: (Math.random() - 0.5) * 5,
      avy: (Math.random() - 0.5) * 3,
      avz: (Math.random() - 0.5) * 5,
      settled: false,
      carriedBy: null,
      mass: item.meta && item.meta.mass ? item.meta.mass : 1.0,
      isFurniture:
        item.size === "small" ||
        item.size === "medium" ||
        item.size === "large",
      locked: false,
    };
    pickups.push(p);

    if (!remotePid && window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalPickupSpawn(p);
    }
    return p;
  }

  function dropItemInWorld(item) {
    if (!player.alive) return;
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const px = clamp(player.pos.x + fx * DROP_DISTANCE, 0.4, WORLD_W - 0.4);
    const pz = clamp(player.pos.z + fz * DROP_DISTANCE, 0.4, WORLD_D - 0.4);
    const py = player.pos.y + player.eye - 0.25;
    const p = spawnPickup(item, new THREE.Vector3(px, py, pz));

    if (p && p.isFurniture) {
      if (inventory && inventory.isOpen) inventory.close();
      enterFurnitureCarry(p);
    }
  }

  function grabPickup(p) {
    if (heldPickup) return;
    if (p.isFurniture) return;
    heldPickup = p;
    p.settled = false;
    p.carriedBy = "local";
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.avx = 0; p.avy = 0; p.avz = 0;

    if (p.pid && window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalPickupGrab(p);
    }
  }

  function releasePickup(throwForce) {
    if (!heldPickup) return;
    const p = heldPickup;
    heldPickup = null;
    p.carriedBy = null;

    const f = throwForce || 0;

    if (f <= 0) {
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.avx = 0; p.avy = 0; p.avz = 0;
    } else {
      const dir = getLookDir();
      p.vx = dir.x * f + player.vel.x * 0.5;
      p.vy = dir.y * f * 0.5 + 0.6;
      p.vz = dir.z * f + player.vel.z * 0.5;

      p.avx = (Math.random() - 0.5) * 6;
      p.avy = (Math.random() - 0.5) * 3;
      p.avz = (Math.random() - 0.5) * 6;
    }
    p.settled = false;

    throwCharging = false;

    if (p.pid && window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalPickupRelease(p);
    }
  }

  function rayHitsAABB(
    ox, oy, oz,
    dx, dy, dz,
    minX, minY, minZ,
    maxX, maxY, maxZ,
    maxDist,
  ) {
    let tmin = 0;
    let tmax = maxDist;

    if (Math.abs(dx) < 1e-8) {
      if (ox < minX || ox > maxX) return null;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (Math.abs(dy) < 1e-8) {
      if (oy < minY || oy > maxY) return null;
    } else {
      let t1 = (minY - oy) / dy;
      let t2 = (maxY - oy) / dy;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    if (Math.abs(dz) < 1e-8) {
      if (oz < minZ || oz > maxZ) return null;
    } else {
      let t1 = (minZ - oz) / dz;
      let t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    return tmin;
  }

  const PICKUP_PAD = 0.04;

  function findLookAtPickup(maxDist) {
    const o = camera.position;
    const d = getLookDir();

    let best = null,
      bestT = maxDist;

    for (const p of pickups) {
      if (p === heldPickup) continue;
      if (!p.mesh.visible) continue;

      const minX = p.mesh.position.x + p.rotMin.x - PICKUP_PAD;
      const minY = p.mesh.position.y + p.rotMin.y - PICKUP_PAD;
      const minZ = p.mesh.position.z + p.rotMin.z - PICKUP_PAD;
      const maxX = p.mesh.position.x + p.rotMax.x + PICKUP_PAD;
      const maxY = p.mesh.position.y + p.rotMax.y + PICKUP_PAD;
      const maxZ = p.mesh.position.z + p.rotMax.z + PICKUP_PAD;

      const t = rayHitsAABB(
        o.x, o.y, o.z,
        d.x, d.y, d.z,
        minX, minY, minZ,
        maxX, maxY, maxZ,
        maxDist,
      );
      if (t !== null && t < bestT) {
        bestT = t;
        best = p;
      }
    }

    if (!best) return null;

    const wall = raycastVoxel(o, d, bestT);
    if (wall && wall.t < bestT - 0.01) return null;

    return best;
  }

  function tryPickup() {
    if (heldPickup) return;
    const p = currentPickupTarget || findLookAtPickup(PICKUP_RANGE);
    if (!p) return;

    const result = attemptInventoryAdd(p.def);
    if (result === "none") return;

    if (window.Sfx) Sfx.play("ui_confirm");

    scene.remove(p.mesh);

    p.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    const idx = pickups.indexOf(p);
    if (idx >= 0) pickups.splice(idx, 1);
    currentPickupTarget = null;
    if (p.pid && window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalPickupRemove(p);
    }

    if (result === "incoming" || result === "overflow") {
      inventory.open();
    }
  }

  function pickupCullRadiusM() {
    return (LOAD_RADIUS + 1) * CHUNK * VOXEL;
  }

  let _lastVisX = -1e9,
    _lastVisZ = -1e9,
    _lastVisR2 = -1;

  function refreshPickupVisibility() {
    const px = player.pos.x,
      pz = player.pos.z;
    const R = pickupCullRadiusM();
    const R2 = R * R;

    const dx0 = px - _lastVisX,
      dz0 = pz - _lastVisZ;
    if (dx0 * dx0 + dz0 * dz0 < 0.25 && R2 === _lastVisR2) return;
    _lastVisX = px;
    _lastVisZ = pz;
    _lastVisR2 = R2;

    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (p === heldPickup || (furnMode && p === furnMode.p)) {
        p.mesh.visible = true;
        continue;
      }
      const dx = p.mesh.position.x - px;
      const dz = p.mesh.position.z - pz;
      p.mesh.visible = dx * dx + dz * dz <= R2;
    }
  }

  function updatePickups(dt) {
    refreshPickupVisibility();

    if (furnMode) updateFurnitureMode(dt);

    if (!furnMode && eHeldFurniture && keys["KeyE"]) {
      if (performance.now() - eHeldStart >= E_FURN_HOLD_MS) {
        enterFurnitureCarry(eHeldFurniture);
        eHeldFurniture = null;
      }
    }
    if (!furnMode && eHeldFurniture) {
      const still = findLookAtPickup(PICKUP_RANGE);
      if (still !== eHeldFurniture) eHeldFurniture = null;
    }

    let showEHoldBar = false;
    let eHoldBarT = 0;

    if (furnMode) {
      currentPickupTarget = null;
      updateHeldToolModel();
      pickupPromptEl.textContent =
        "Q / E  ROTATE   ·   LMB  PLACE   ·   RMB  STORE";
      pickupPromptEl.style.opacity = "1";
    } else if (eHeldFurniture && keys["KeyE"]) {
      currentPickupTarget = null;
      updateHeldToolModel();
      eHoldBarT = Math.min(
        1,
        (performance.now() - eHeldStart) / E_FURN_HOLD_MS,
      );
      const pct = Math.round(eHoldBarT * 100);
      pickupPromptEl.textContent = "LIFTING…  " + pct + "%";
      pickupPromptEl.style.opacity = "1";
      showEHoldBar = true;
    } else if (heldPickup) {
      currentPickupTarget = null;
      updateHeldToolModel();
      pickupPromptEl.textContent =
        "[LMB]  DROP   ·   HOLD [RMB]  TO CHARGE THROW";
      pickupPromptEl.style.opacity = "1";
    } else {
      currentPickupTarget =
        gameRunning && player.alive && !inventory.isOpen
          ? findLookAtPickup(PICKUP_RANGE)
          : null;
      updateHeldToolModel();
      if (currentPickupTarget) {
        const isHand = TOOLS[selectedTool].id === "hand";
        const d = currentPickupTarget.def;

        let label = d.name;
        if (d.isAmmo && d.count) label += "  ×" + d.count;

        if (currentPickupTarget.isFurniture) {
          pickupPromptEl.textContent = "HOLD [E]  1s  TO LIFT   ·   " + label;
        } else {
          pickupPromptEl.textContent =
            (isHand ? "[LMB]  HOLD  " : "[E]  PICK UP  ") + label;
        }
        pickupPromptEl.style.opacity = "1";
      } else {
        pickupPromptEl.style.opacity = "0";
      }
    }

    if (showEHoldBar) {
      const fill = document.getElementById("eHoldBarFill");
      if (fill) fill.style.width = (eHoldBarT * 100).toFixed(1) + "%";
      eHoldBarEl.style.opacity = "1";
    } else {
      eHoldBarEl.style.opacity = "0";
    }

    updateThrowChargeHud();

    const outlineTarget =
      currentPickupTarget && !heldPickup ? currentPickupTarget : null;
    if (outlineTarget) {
      const aabb = outlineTarget.aabb;
      _outlineCenter.set(
        (aabb.min.x + aabb.max.x) * 0.5,
        (aabb.min.y + aabb.max.y) * 0.5,
        (aabb.min.z + aabb.max.z) * 0.5,
      );
      _outlineSize.set(
        (aabb.max.x - aabb.min.x) * 1.06,
        (aabb.max.y - aabb.min.y) * 1.06,
        (aabb.max.z - aabb.min.z) * 1.06,
      );
      _outlineCenter.applyQuaternion(outlineTarget.mesh.quaternion);
      pickupOutline.position
        .copy(outlineTarget.mesh.position)
        .add(_outlineCenter);
      pickupOutline.quaternion.copy(outlineTarget.mesh.quaternion);
      pickupOutline.scale.copy(_outlineSize);
      pickupOutline.visible = true;
    } else {
      pickupOutline.visible = false;
    }

    /* ============================================================
           PASS 1 — per‑item physics
           ============================================================ */
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      if (
        !p.mesh.visible &&
        p !== heldPickup &&
        !(furnMode && p === furnMode.p)
      )
        continue;

      if (p.carriedBy && p !== heldPickup) continue;

      if (p === heldPickup) {
        _handTarget
          .copy(_handOffset)
          .applyQuaternion(camera.quaternion)
          .add(camera.position);
        const k = Math.min(1, dt * 22);
        p.mesh.position.x += (_handTarget.x - p.mesh.position.x) * k;
        p.mesh.position.y += (_handTarget.y - p.mesh.position.y) * k;
        p.mesh.position.z += (_handTarget.z - p.mesh.position.z) * k;
        p.avx *= Math.pow(0.02, dt);
        p.avy *= Math.pow(0.02, dt);
        p.avz *= Math.pow(0.02, dt);
        const hw = Math.hypot(p.avx, p.avy, p.avz);
        if (hw > 1e-4) {
          _spinAxis.set(p.avx / hw, p.avy / hw, p.avz / hw);
          _qSpin.setFromAxisAngle(_spinAxis, hw * dt);
          p.mesh.quaternion.premultiply(_qSpin);
        }
        computeRotatedAABB(p);
        continue;
      }

      if (furnMode && p === furnMode.p) {
        computeRotatedAABB(p);
        continue;
      }

      if (p.locked) {
        continue;
      }

      if (gameRunning && player.alive) {
        const plMinX = player.pos.x - player.halfW;
        const plMaxX = player.pos.x + player.halfW;
        const plMinY = player.pos.y;
        const plMaxY = player.pos.y + player.height;
        const plMinZ = player.pos.z - player.halfW;
        const plMaxZ = player.pos.z + player.halfW;
        const itMinX = p.mesh.position.x + p.rotMin.x;
        const itMaxX = p.mesh.position.x + p.rotMax.x;
        const itMinY = p.mesh.position.y + p.rotMin.y;
        const itMaxY = p.mesh.position.y + p.rotMax.y;
        const itMinZ = p.mesh.position.z + p.rotMin.z;
        const itMaxZ = p.mesh.position.z + p.rotMax.z;
        const ovX = Math.min(plMaxX, itMaxX) - Math.max(plMinX, itMinX);
        const ovY = Math.min(plMaxY, itMaxY) - Math.max(plMinY, itMinY);
        const ovZ = Math.min(plMaxZ, itMaxZ) - Math.max(plMinZ, itMinZ);
        if (ovX > 0 && ovY > 0 && ovZ > 0) {
          let nx = 0,
            nz = 0,
            depth;
          if (ovX <= ovZ) {
            nx = p.mesh.position.x < player.pos.x ? -1 : 1;
            depth = ovX;
          } else {
            nz = p.mesh.position.z < player.pos.z ? -1 : 1;
            depth = ovZ;
          }
          const oldX = p.mesh.position.x;
          const oldZ = p.mesh.position.z;
          p.mesh.position.x += nx * depth;
          p.mesh.position.z += nz * depth;
          computeRotatedAABB(p);
          if (itemHitsVoxels(p)) {
            p.mesh.position.x = oldX;
            p.mesh.position.z = oldZ;
            computeRotatedAABB(p);
          } else {
            const impulse = KICK_FORCE / Math.max(0.25, p.mass);
            if (nx !== 0) p.vx += nx * impulse;
            if (nz !== 0) p.vz += nz * impulse;
            const rotImpulse = Math.min(4.5, 8.0 / Math.max(0.25, p.mass));
            p.avx += (Math.random() - 0.5) * rotImpulse;
            p.avy += (Math.random() - 0.5) * rotImpulse;
            p.avz += (Math.random() - 0.5) * rotImpulse;
            p.settled = false;
          }
        }
      }
      if (p.settled) continue;
      p.vy -= PICKUP_GRAVITY * dt;
      if (p.vy < -30) p.vy = -30;

      if (itemHitsVoxels(p)) {
        resolveVoxelPenetration(p);
        computeRotatedAABB(p);
      }

      let onFloor = false;
      const stepY = p.vy * dt;
      if (stepY < 0) {
        const oldY = p.mesh.position.y;
        p.mesh.position.y = oldY + stepY;
        if (itemHitsVoxels(p)) {
          let lo = p.mesh.position.y;
          let hi = oldY;
          for (let k = 0; k < 10; k++) {
            const mid = (lo + hi) * 0.5;
            p.mesh.position.y = mid;
            if (itemHitsVoxels(p)) lo = mid;
            else hi = mid;
          }
          p.mesh.position.y = hi;
          onFloor = true;
          if (Math.abs(p.vy) < PICKUP_SETTLE_SPEED) {
            p.vy = 0;
            p.avx *= 0.4;
            p.avy *= 0.4;
            p.avz *= 0.4;
          } else {
            p.vy = -p.vy * PICKUP_BOUNCE;
            p.avx = p.vz * 1.5;
            p.avz = -p.vx * 1.5;
          }
        }
      } else if (stepY > 0) {
        const oldY = p.mesh.position.y;
        p.mesh.position.y = oldY + stepY;
        if (itemHitsVoxels(p)) {
          p.mesh.position.y = oldY;
          p.vy = 0;
        }
      }
      const stepX = p.vx * dt;
      if (stepX !== 0) {
        const oldX = p.mesh.position.x;
        p.mesh.position.x += stepX;
        computeRotatedAABB(p);
        if (itemHitsVoxels(p)) {
          p.mesh.position.x = oldX;
          p.avx += p.vz * 2.0;
          p.avz -= p.vx * 2.0;
          p.vx = -p.vx * 0.3;
          computeRotatedAABB(p);
        }
      }
      const stepZ = p.vz * dt;
      if (stepZ !== 0) {
        const oldZ = p.mesh.position.z;
        p.mesh.position.z += stepZ;
        computeRotatedAABB(p);
        if (itemHitsVoxels(p)) {
          p.mesh.position.z = oldZ;
          p.avx -= p.vz * 2.0;
          p.avz += p.vx * 2.0;
          p.vz = -p.vz * 0.3;
          computeRotatedAABB(p);
        }
      }
      const hDamp = onFloor ? Math.pow(0.0005, dt) : Math.pow(0.75, dt);
      p.vx *= hDamp;
      p.vz *= hDamp;
      if (Math.abs(p.vx) < 0.03) p.vx = 0;
      if (Math.abs(p.vz) < 0.03) p.vz = 0;
      p.mesh.position.x = clamp(p.mesh.position.x, 0.2, WORLD_W - 0.2);
      p.mesh.position.z = clamp(p.mesh.position.z, 0.2, WORLD_D - 0.2);
      if (onFloor) {
        const speed = Math.hypot(p.vx, p.vz);
        if (speed > 0.15) {
          const ax = -p.vz / speed;
          const az = p.vx / speed;
          const rollRate =
            speed /
            Math.max(
              0.05,
              Math.max(p.rotMax.x - p.rotMin.x, p.rotMax.z - p.rotMin.z) * 0.5,
            );
          p.avx += ax * rollRate * dt * 2;
          p.avz += az * rollRate * dt * 2;
        }
      }
      const flatSpd = Math.hypot(p.vx, p.vz);
      const groundedStill = onFloor && Math.abs(p.vy) < 0.5 && flatSpd < 0.35;
      const airborne = !onFloor;
      let alignSpringActive = false;
      if (groundedStill || airborne) {
        computeEquilibriumQuat(p.mesh.quaternion, _qAlign);
        _qDelta.copy(p.mesh.quaternion).conjugate().premultiply(_qAlign);
        let dw = _qDelta.w;
        let dx = _qDelta.x, dy = _qDelta.y, dz = _qDelta.z;
        if (dw < 0) {
          dw = -dw;
          dx = -dx;
          dy = -dy;
          dz = -dz;
        }
        const ang = 2 * Math.acos(clamp(dw, -1, 1));
        const s = Math.sqrt(Math.max(0, 1 - dw * dw));
        if (s > 1e-4) {
          const ax = dx / s, ay = dy / s, az = dz / s;
          const K = groundedStill ? ALIGN_K_GROUND : ALIGN_K_AIR;
          const C = groundedStill ? ALIGN_C_GROUND : ALIGN_C_AIR;
          p.avx += (K * ang * ax - C * p.avx) * dt;
          p.avy += (K * ang * ay - C * p.avy) * dt;
          p.avz += (K * ang * az - C * p.avz) * dt;
          alignSpringActive = true;
          if (
            groundedStill &&
            ang < 0.035 &&
            Math.abs(p.avx) + Math.abs(p.avy) + Math.abs(p.avz) +
            Math.hypot(p.vx, p.vz) < 0.3
          ) {
            p.mesh.quaternion.copy(_qAlign);
            seatOnFloor(p);
            p.settled = true;
            if (p.isFurniture) p.locked = true;
            if (
              !p.isRemote &&
              p.pid &&
              window.ARiveMP &&
              window.ARiveMP.connected
            ) {
              window.ARiveMP.onLocalPickupSettled(p);
            }
            p.vx = p.vy = p.vz = 0;
            p.avx = p.avy = p.avz = 0;
            continue;
          }
        } else if (groundedStill) {
          p.mesh.quaternion.copy(_qAlign);
          seatOnFloor(p);
          p.settled = true;
          if (p.isFurniture) p.locked = true;
          if (
            !p.isRemote &&
            p.pid &&
            window.ARiveMP &&
            window.ARiveMP.connected
          ) {
            window.ARiveMP.onLocalPickupSettled(p);
          }
          p.vx = p.vy = p.vz = 0;
          p.avx = p.avy = p.avz = 0;
          continue;
        }
      }
      if (!alignSpringActive) {
        const aDamp = onFloor ? Math.pow(0.03, dt) : Math.pow(0.55, dt);
        p.avx *= aDamp;
        p.avy *= aDamp;
        p.avz *= aDamp;
      }
      const w = Math.hypot(p.avx, p.avy, p.avz);
      if (w > 1e-3) {
        _spinAxis.set(p.avx / w, p.avy / w, p.avz / w);
        _qSpin.setFromAxisAngle(_spinAxis, w * dt);
        p.mesh.quaternion.premultiply(_qSpin);
        computeRotatedAABB(p);
      }
      if (alignSpringActive && onFloor) {
        seatOnFloor(p);
      }
      p.vx = clamp(p.vx, -12, 12);
      p.vz = clamp(p.vz, -12, 12);
      p.avx = clamp(p.avx, -25, 25);
      p.avy = clamp(p.avy, -25, 25);
      p.avz = clamp(p.avz, -25, 25);
    }

    /* ============================================================
           PASS 2 — item ↔ item AABB collision
           ============================================================ */
    const N = pickups.length;
    if (N < 2) return;
    for (let iter = 0; iter < 1; iter++) {
      for (let i = 0; i < N; i++) {
        const a = pickups[i];
        if (!a.mesh.visible) continue;
        if (a === heldPickup) continue;
        if (a.carriedBy) continue;
        if (furnMode && a === furnMode.p) continue;
        for (let j = i + 1; j < N; j++) {
          const b = pickups[j];
          if (!b.mesh.visible) continue;
          if (b === heldPickup) continue;
          if (b.carriedBy) continue;
          if (furnMode && b === furnMode.p) continue;
          if (a.settled && b.settled) continue;

          const aMinX = a.mesh.position.x + a.rotMin.x;
          const aMaxX = a.mesh.position.x + a.rotMax.x;
          const bMinX = b.mesh.position.x + b.rotMin.x;
          const bMaxX = b.mesh.position.x + b.rotMax.x;
          if (bMaxX <= aMinX || bMinX >= aMaxX) continue;
          const aMinY = a.mesh.position.y + a.rotMin.y;
          const aMaxY = a.mesh.position.y + a.rotMax.y;
          const bMinY = b.mesh.position.y + b.rotMin.y;
          const bMaxY = b.mesh.position.y + b.rotMax.y;
          if (bMaxY <= aMinY || bMinY >= aMaxY) continue;
          const aMinZ = a.mesh.position.z + a.rotMin.z;
          const aMaxZ = a.mesh.position.z + a.rotMax.z;
          const bMinZ = b.mesh.position.z + b.rotMin.z;
          const bMaxZ = b.mesh.position.z + b.rotMax.z;
          if (bMaxZ <= aMinZ || bMinZ >= aMaxZ) continue;
          const ovX = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
          const ovY = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);
          const ovZ = Math.min(aMaxZ, bMaxZ) - Math.max(aMinZ, bMinZ);
          let nx = 0, ny = 0, nz = 0, depth = 0;
          if (ovX <= ovY && ovX <= ovZ) {
            nx = a.mesh.position.x < b.mesh.position.x ? -1 : 1;
            depth = ovX;
          } else if (ovY <= ovZ) {
            ny = a.mesh.position.y < b.mesh.position.y ? -1 : 1;
            depth = ovY;
          } else {
            nz = a.mesh.position.z < b.mesh.position.z ? -1 : 1;
            depth = ovZ;
          }
          const aImm = a.locked, bImm = b.locked;
          const half = depth * 0.5;
          const aOldX = a.mesh.position.x,
            aOldY = a.mesh.position.y,
            aOldZ = a.mesh.position.z;
          const bOldX = b.mesh.position.x,
            bOldY = b.mesh.position.y,
            bOldZ = b.mesh.position.z;
          if (!aImm) {
            a.mesh.position.x += nx * (bImm ? depth : half);
            a.mesh.position.y += ny * (bImm ? depth : half);
            a.mesh.position.z += nz * (bImm ? depth : half);
          }
          if (!bImm) {
            b.mesh.position.x -= nx * (aImm ? depth : half);
            b.mesh.position.y -= ny * (aImm ? depth : half);
            b.mesh.position.z -= nz * (aImm ? depth : half);
          }

          computeRotatedAABB(a);
          if (!aImm && itemHitsVoxels(a)) {
            a.mesh.position.x = aOldX;
            a.mesh.position.y = aOldY;
            a.mesh.position.z = aOldZ;
            computeRotatedAABB(a);
          }
          computeRotatedAABB(b);
          if (!bImm && itemHitsVoxels(b)) {
            b.mesh.position.x = bOldX;
            b.mesh.position.y = bOldY;
            b.mesh.position.z = bOldZ;
            computeRotatedAABB(b);
          }

          const relV =
            (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
          if (relV < 0) {
            if (aImm && bImm) continue;

            const m1 = aImm ? Infinity : a.mass;
            const m2 = bImm ? Infinity : b.mass;
            const invSum = 1 / m1 + 1 / m2;
            const restitution = 0.22;
            const j = (-(1 + restitution) * relV) / invSum;

            if (!aImm) {
              a.vx -= (nx * j) / m1;
              a.vy -= (ny * j) / m1;
              a.vz -= (nz * j) / m1;
            }
            if (!bImm) {
              b.vx += (nx * j) / m2;
              b.vy += (ny * j) / m2;
              b.vz += (nz * j) / m2;
            }

            const tumble = Math.min(4.0, Math.abs(relV) * 1.8);
            a.avx += ((Math.random() - 0.5) * tumble) / Math.max(0.3, m1);
            a.avz += ((Math.random() - 0.5) * tumble) / Math.max(0.3, m1);
            b.avx += ((Math.random() - 0.5) * tumble) / Math.max(0.3, m2);
            b.avz += ((Math.random() - 0.5) * tumble) / Math.max(0.3, m2);

            a.settled = false;
            b.settled = false;
          }
        }
      }
    }
  }

  /* =========================================================================
       13. INPUT
       ========================================================================= */
  const keys = Object.create(null);
  let pointerLocked = false;
  let gameRunning = false;
  let mouseDown = false;
  let reacquiringLock = false;

  document.addEventListener("keydown", (e) => {
    if (Minimap && Minimap.isOpen()) {
      if (e.code === "KeyM") {
        e.preventDefault();
        Minimap.close();
      }
      return;
    }

    keys[e.code] = true;
    if (e.code === "Space") e.preventDefault();

    if (e.code === "AltLeft" || e.code === "AltRight") {
      e.preventDefault();
      releasePointerForAlt();
      return;
    }

    if (e.code === "Tab") {
      e.preventDefault();
      if (gameRunning && player.alive) {
        inventory.toggle();
        if (window.Sfx) Sfx.play("ui_click");
      }
      return;
    }

    if (e.code === "KeyE") {
      if (e.repeat) return;
      if (!gameRunning || !player.alive || inventory.isOpen)
        return;
      e.preventDefault();

      if (furnMode) {
        if (performance.now() - furnMode.liftedAt > E_FURN_ROT_GRACE_MS) {
          eHeld = true;
          rotateFurnitureBy(FURN_ROT_STEP);
        }
        return;
      }

      const tgt = findLookAtPickup(PICKUP_RANGE);
      if (tgt && tgt.isFurniture) {
        eHeldFurniture = tgt;
        eHeldStart = performance.now();
      } else {
        tryPickup();
      }
      return;
    }

    if (e.code === "KeyQ") {
      if (furnMode) {
        qHeld = true;
        rotateFurnitureBy(-FURN_ROT_STEP);
        e.preventDefault();
      }
      return;
    }

    if (e.code === "KeyG") {
      if (
        gameRunning &&
        player.alive &&
        currentMapType === "sandbox" &&
        !inventory.isOpen
      ) {
        e.preventDefault();
        if (window.SandboxMenu) window.SandboxMenu.toggle();
      }
      return;
    }

    if (e.code === "KeyM") {
      e.preventDefault();
      if (Minimap.isOpen()) {
        Minimap.close();
        if (window.Sfx) Sfx.play("ui_back");
      } else if (
        gameRunning &&
        player.alive &&
        !inventory.isOpen
      ) {
        Minimap.toggle();
        if (window.Sfx) Sfx.play("ui_click");
      }
      return;
    }

    if (gameRunning && !inventory.isOpen && e.code.startsWith("Digit")) {
      const n = parseInt(e.code.slice(5), 10);
      if (n === 1 || n === 2) {
        if (window.Weapons) {
          window.Weapons.selectSlot(n - 1);
          if (heldPickup) releasePickup(0);
          if (window.Sfx) Sfx.play("ui_click");
        }
      } else if (n >= 3 && n - 3 < TOOLS.length) {
        selectedTool = n - 3;
        if (window.Weapons) window.Weapons.selectSlot(-1);
        if (heldPickup && TOOLS[selectedTool].id !== "hand") releasePickup(0);
        renderHotbar();
        if (window.Sfx) Sfx.play("ui_click");
      }
    }

    if (e.code === "KeyR" && !e.repeat) {
      if (window.Weapons && window.Weapons.isActive()) {
        e.preventDefault();
        window.Weapons.onReloadKey();
        return;
      }
    }

    if (e.code === "KeyY" && !e.repeat) {
      if (window.Weapons && window.Weapons.isActive()) {
        e.preventDefault();
        window.Weapons.onInspectKey();
        return;
      }
    }
  });

  document.addEventListener("keyup", (e) => {
    keys[e.code] = false;
    if (e.code === "AltLeft" || e.code === "AltRight") {
      restorePointerFromAlt();
    }
    if (e.code === "KeyE") {
      eHeld = false;
      if (!furnMode && eHeldFurniture) {
        eHeldFurniture = null;
      }
    }
    if (e.code === "KeyQ") {
      qHeld = false;
    }
  });

  document.addEventListener("mousemove", (e) => {
    if (!pointerLocked) return;
    const scopeMul =
      window.Weapons && window.Weapons.getSensitivityMul
        ? window.Weapons.getSensitivityMul()
        : 1;
    const s = 0.002 * settings.sensitivity * scopeMul;

    player.targetYaw -= e.movementX * s;
    player.pitch -= e.movementY * s;

    player.pitch = clamp(player.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    swayYawVel -= e.movementX * FP_MODEL.anim.swayStrength;
    swayPitchVel -= e.movementY * FP_MODEL.anim.swayStrength;
  });

  let hadLock = false;
  let altHeld = false;
  let suppressUnlockPause = false;
  let _suppressPauseTimer = 0;

  document.addEventListener("pointerlockchange", () => {
    const nowLocked = document.pointerLockElement === canvas;
    if (nowLocked) {
      pointerLocked = true;
      hadLock = true;
    } else {
      pointerLocked = false;
      if (suppressUnlockPause) return;

      const inMP = !!(window.ARiveMP && window.ARiveMP.connected);

      if (
        hadLock &&
        gameRunning &&
        !inventory.isOpen &&
        !Minimap.isOpen() &&
        !(window.SandboxMenu && window.SandboxMenu.isOpen()) &&
        !(window.SandboxMenu && window.SandboxMenu.isPlacing && window.SandboxMenu.isPlacing())
      ) {
        if (!inMP) gameRunning = false;
        showOverlay(true);
      }
    }
  });

  document.addEventListener("pointerlockerror", () => {
    console.warn(
      "Pointer lock failed — you can still move with WASD, but mouse look is disabled. Click the canvas to retry.",
    );
    pointerLocked = false;
  });

  function releasePointerForAlt() {
    if (
      !altHeld &&
      gameRunning &&
      player.alive &&
      !inventory.isOpen
    ) {
      altHeld = true;
      suppressUnlockPause = true;
      document.exitPointerLock();
    }
  }

  function restorePointerFromAlt() {
    if (!altHeld) return;
    altHeld = false;
    suppressUnlockPause = false;
    requestPointerLockSafely();
  }

  function requestPointerLockSafely() {
    const shouldLock = () => {
      if (!gameRunning) return false;
      if (document.pointerLockElement === canvas) return false;
      if (inventory && inventory.isOpen) return false;
      if (window.SandboxMenu && window.SandboxMenu.isOpen()) return false;
      if (window.SandboxMenu && window.SandboxMenu.isPlacing && window.SandboxMenu.isPlacing()) return false;
      if (altHeld) return false;
      return true;
    };

    const tryLock = () => {
      if (!shouldLock()) return;
      const p = canvas.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(() => { });
    };

    tryLock();

    [50, 150, 350, 700, 1000, 1100, 1250, 1500, 1800].forEach(function (delay) {
      setTimeout(tryLock, delay);
    });
  }

  window.addEventListener("blur", () => {
    altHeld = false;
    suppressUnlockPause = false;
  });

  canvas.addEventListener("mousedown", (e) => {
    if (!gameRunning) return;

    if (furnMode) {
      if (e.button === 0) {
        e.preventDefault();
        placeFurniture();
      } else if (e.button === 2) {
        e.preventDefault();
        storeFurniture();
      }
      return;
    }

    if (!pointerLocked) {
      if (!altHeld && !inventory.isOpen) {
        const p = canvas.requestPointerLock();
        if (p && typeof p.catch === "function") p.catch(() => { });
      }
      return;
    }

    if (window.Weapons && window.Weapons.isActive()) {
      if (e.button === 0) {
        e.preventDefault();
        window.Weapons.onTriggerDown();
        return;
      }
      if (e.button === 2) {
        e.preventDefault();
        window.Weapons.onScopeDown();
        return;
      }
    }

    if (e.button === 2) {
      if (heldPickup && TOOLS[selectedTool].id === "hand") {
        throwCharging = true;
        throwChargeStart = performance.now();
      }
      return;
    }

    if (e.button !== 0) return;
    mouseDown = true;

    if (TOOLS[selectedTool].id === "hand") {
      if (!heldPickup) {
        const tgt = findLookAtPickup(HAND_RANGE);
        if (tgt && !tgt.isFurniture) grabPickup(tgt);
      }
    } else {
      useTool();
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (reacquiringLock) {
      reacquiringLock = false;
      return;
    }

    if (window.Weapons && window.Weapons.isActive()) {
      if (e.button === 0) {
        window.Weapons.onTriggerUp();
        return;
      }
      if (e.button === 2) {
        window.Weapons.onScopeUp();
        return;
      }
    }

    if (e.button === 2) {
      if (throwCharging && heldPickup) {
        const elapsed = (performance.now() - throwChargeStart) / 1000;
        const t = Math.min(1, elapsed / THROW_CHARGE_TIME);
        const force = THROW_MIN_FORCE + t * (THROW_MAX_FORCE - THROW_MIN_FORCE);
        releasePickup(force);
      }
      throwCharging = false;
      return;
    }

    if (e.button !== 0) return;
    mouseDown = false;

    if (TOOLS[selectedTool].id === "hand" && heldPickup) {
      releasePickup(0);
    }
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!gameRunning) return;
      e.preventDefault();
      if (furnMode) {
        rotateFurnitureBy(e.deltaY > 0 ? FURN_ROT_STEP : -FURN_ROT_STEP);
        return;
      }
      if (window.Weapons && window.Weapons.isActive()) return;
      selectedTool =
        (selectedTool + (e.deltaY > 0 ? 1 : -1) + TOOLS.length) % TOOLS.length;
      if (heldPickup && TOOLS[selectedTool].id !== "hand") releasePickup(0);
      renderHotbar();
    },
    { passive: false },
  );

  /* =========================================================================
       14. VOXEL RAYCAST (DDA)
       ========================================================================= */
  function raycastVoxel(origin, dir, maxDist) {
    const ox = origin.x / VOXEL,
      oy = origin.y / VOXEL,
      oz = origin.z / VOXEL;
    let x = Math.floor(ox),
      y = Math.floor(oy),
      z = Math.floor(oz);
    const sx = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const sy = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const sz = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
    const dxr = Math.abs(dir.x / VOXEL),
      dyr = Math.abs(dir.y / VOXEL),
      dzr = Math.abs(dir.z / VOXEL);
    const tdx = sx !== 0 ? 1 / dxr : Infinity;
    const tdy = sy !== 0 ? 1 / dyr : Infinity;
    const tdz = sz !== 0 ? 1 / dzr : Infinity;
    let tmx = sx !== 0 ? (sx > 0 ? x + 1 - ox : ox - x) / dxr : Infinity;
    let tmy = sy !== 0 ? (sy > 0 ? y + 1 - oy : oy - y) / dyr : Infinity;
    let tmz = sz !== 0 ? (sz > 0 ? z + 1 - oz : oz - z) / dzr : Infinity;
    let nx = 0, ny = 0, nz = 0, t = 0;
    const maxV = maxDist;
    for (let i = 0; i < 2048; i++) {
      if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return null;
      const b = voxels[vIdx(x, y, z)];
      if (b !== 0) return { x, y, z, nx, ny, nz, t, block: b };
      if (tmx < tmy && tmx < tmz) {
        x += sx; t = tmx; tmx += tdx;
        nx = -sx; ny = 0; nz = 0;
      } else if (tmy < tmz) {
        y += sy; t = tmy; tmy += tdy;
        nx = 0; ny = -sy; nz = 0;
      } else {
        z += sz; t = tmz; tmz += tdz;
        nx = 0; ny = 0; nz = -sz;
      }
      if (t > maxV) return null;
    }
    return null;
  }
  function getLookDir() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  }

  /* =========================================================================
       15. TOOLS
       ========================================================================= */
  const TOOLS = [
    { id: "hand", name: "HAND", icon: "✋", color: "#c8b88a", count: Infinity, cd: 0.15 },
    { id: "sledge", name: "SLEDGE", icon: "⚒", color: "#c8a04a", count: Infinity, cd: 0.42 },
    { id: "charge", name: "CHARGE", icon: "◉", color: "#d04030", count: 12, cd: 0.8 },
    { id: "medkit", name: "MEDKIT", icon: "+", color: "#d05060", count: 3, cd: 1.1 },
    { id: "ration", name: "RATION", icon: "◆", color: "#80a050", count: 5, cd: 1.0 },
  ];

  const TOOL_HELD = window.TOOL_HELD_DATA || {
    sledge: {
      pose: { p: [0.0, -0.02, -0.05], r: [0.35, 0.1, 0.05] },
      anim: { swing: 1.15, kick: 0.02 },
      model: [
        { p: [0.0, 0.0, -0.28], s: [0.045, 0.045, 0.6], c: 0x5a3a18 },
        { p: [0.1, 0.0, -0.56], s: [0.3, 0.14, 0.09], c: 0x808890 },
        { p: [0.24, 0.0, -0.56], s: [0.05, 0.1, 0.09], c: 0x9098a0 },
      ],
    },
    charge: {
      pose: { p: [0.0, -0.04, -0.06], r: [0.15, 0.1, 0.05] },
      anim: { swing: 0.45, kick: 0.03 },
      model: [
        { p: [0, 0, -0.16], s: [0.18, 0.2, 0.18], c: 0xa04028 },
        { p: [0, 0.14, -0.16], s: [0.05, 0.06, 0.05], c: 0x404040 },
      ],
    },
    rifle: {
      pose: { p: [0.0, -0.03, -0.08], r: [0.2, 0.05, -0.05] },
      anim: { swing: 0.4, kick: -0.07 },
      model: [
        { p: [0, 0.0, -0.45], s: [0.05, 0.09, 0.9], c: 0x30353a },
        { p: [0, -0.08, -0.1], s: [0.07, 0.14, 0.14], c: 0x4a3820 },
        { p: [0, -0.02, 0.14], s: [0.06, 0.1, 0.22], c: 0x4a3820 },
        { p: [0, 0.07, -0.28], s: [0.04, 0.05, 0.14], c: 0x505860 },
      ],
    },
    flare: {
      pose: { p: [0.0, -0.02, -0.06], r: [0.1, 0.0, 0.0] },
      anim: { swing: 0.3, kick: 0.02 },
      model: [
        { p: [0, 0, -0.14], s: [0.05, 0.05, 0.26], c: 0xd0d0c0 },
        { p: [0, 0, -0.29], s: [0.06, 0.06, 0.06], c: 0xd04020 },
      ],
    },
    medkit: {
      pose: { p: [0.0, -0.06, -0.08], r: [0.15, 0.08, 0.05] },
      anim: { swing: 0.3, kick: 0.02 },
      model: [
        { p: [0, 0, -0.15], s: [0.2, 0.14, 0.18], c: 0xd0d0c8 },
        { p: [0, 0, -0.06], s: [0.05, 0.1, 0.02], c: 0xc02020 },
        { p: [0, 0, -0.06], s: [0.1, 0.05, 0.02], c: 0xc02020 },
      ],
    },
    ration: {
      pose: { p: [0.0, -0.05, -0.08], r: [0.25, 0.1, 0.05] },
      anim: { swing: 0.3, kick: 0.02 },
      model: [
        { p: [0, 0.0, -0.12], s: [0.18, 0.09, 0.16], c: 0x6a7a4a },
        { p: [0, 0.055, -0.12], s: [0.18, 0.02, 0.16], c: 0x4a5a2a },
      ],
    },
  };

  const toolHolders = {};
  const toolPoses = {};

  for (const t of TOOLS) {
    const def = TOOL_HELD[t.id];
    if (!def) continue;

    const holder = new THREE.Group();
    holder.position.set(def.pose.p[0], def.pose.p[1], def.pose.p[2]);
    holder.rotation.set(def.pose.r[0], def.pose.r[1], def.pose.r[2]);
    holder.visible = false;

    const mesh = buildItemMesh(def.model);
    holder.add(mesh);

    handR.add(holder);
    toolHolders[t.id] = holder;
    toolPoses[t.id] = def;
  }

  function updateHeldToolModel() {
    const selId = TOOLS[selectedTool].id;
    const weaponActive = !!(window.Weapons && window.Weapons.isActive());
    const showTool = !heldPickup && !weaponActive;
    for (const id in toolHolders) {
      toolHolders[id].visible = showTool && id === selId;
    }
  }

  let toolUseAnimT = 1;
  function triggerToolAnim() {
    toolUseAnimT = 0;
  }

  function updateHeldToolAnim(dt) {
    if (toolUseAnimT < 1) {
      toolUseAnimT = Math.min(1, toolUseAnimT + dt * 5.5);
    }

    const selId = TOOLS[selectedTool].id;
    const holder = toolHolders[selId];
    if (!holder || !holder.visible) return;

    const def = toolPoses[selId];
    const bell = toolUseAnimT < 1 ? Math.sin(toolUseAnimT * Math.PI) : 0;

    holder.rotation.x = def.pose.r[0] + bell * def.anim.swing;
    holder.rotation.y = def.pose.r[1];
    holder.rotation.z = def.pose.r[2];
    holder.position.z = def.pose.p[2] + bell * def.anim.kick;
  }

  let selectedTool = 0;
  let toolCooldown = 0;
  let scrap = 0;

  updateHeldToolModel();

  const projectiles = [];
  const projGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  const projMat = new THREE.MeshLambertMaterial({ color: 0xd04030, fog: true });

  let shakeTime = 0,
    shakeAmt = 0;
  function shakeCamera(a) {
    shakeAmt = Math.max(shakeAmt, a);
    shakeTime = 0.32;
  }

  let hitFlash = 0;

  let nextProjId = 1;

  function useTool() {
    if (toolCooldown > 0) return;

    triggerToolAnim();

    if (
      window.ARiveMP &&
      window.ARiveMP.connected &&
      window.ARiveMP.onLocalToolUse
    ) {
      window.ARiveMP.onLocalToolUse(TOOLS[selectedTool].id);
    }

    const t = TOOLS[selectedTool];
    const dir = getLookDir();

    if (t.id === "sledge") {
      const hit = raycastVoxel(camera.position, dir, 2.5);
      if (hit) {
        const cx = hit.x + hit.nx,
          cy = hit.y + hit.ny,
          cz = hit.z + hit.nz;
        carveSphere(cx, cy, cz, 2.8, { ignite: false, debrisChance: 0.2 });
        shakeCamera(0.08);
        net.sendCarve(cx, cy, cz, 2.8, false);
        if (window.Sfx) Sfx.play("voxel_break");
      }

      hitEnemiesMelee(2.4, 40);
      toolCooldown = t.cd;
    } else if (t.id === "charge") {
      if (t.count <= 0) {
        toolCooldown = 0.15;
        return;
      }
      t.count--;
      const p = camera.position.clone().addScaledVector(dir, 0.7);
      const v = dir.clone().multiplyScalar(13);
      v.y += 2.4;
      const m = new THREE.Mesh(projGeo, projMat);
      m.position.copy(p);
      scene.add(m);

      const proj = {
        mesh: m,
        pos: p.clone(),
        vel: v,
        life: 2.8,
        projId: "P" + nextProjId++,
        isRemote: false,
      };
      projectiles.push(proj);
      toolCooldown = t.cd;
      renderHotbar();

      if (
        window.ARiveMP &&
        window.ARiveMP.connected &&
        window.ARiveMP.onLocalProjectileSpawn
      ) {
        window.ARiveMP.onLocalProjectileSpawn(proj);
      }
    } else if (t.id === "medkit") {
      if (t.count <= 0 || player.health >= 100) {
        toolCooldown = 0.15;
        return;
      }
      t.count--;
      player.health = Math.min(100, player.health + 40);
      toolCooldown = t.cd;
      renderHotbar();
    } else if (t.id === "ration") {
      if (t.count <= 0) {
        toolCooldown = 0.15;
        return;
      }
      t.count--;
      player.hunger = Math.min(100, player.hunger + 40);
      player.thirst = Math.min(100, player.thirst + 30);
      toolCooldown = t.cd;
      renderHotbar();
    }
  }

  function spawnRemoteProjectile(msg) {
    if (!msg || msg.projId === undefined) return;

    for (const p of projectiles) {
      if (p.projId === msg.projId) return;
    }

    const pos = new THREE.Vector3(msg.px, msg.py, msg.pz);
    const vel = new THREE.Vector3(msg.vx, msg.vy, msg.vz);
    const m = new THREE.Mesh(projGeo, projMat);
    m.position.copy(pos);
    scene.add(m);

    projectiles.push({
      mesh: m,
      pos: pos.clone(),
      vel: vel,
      life: msg.life !== undefined ? msg.life : 2.8,
      projId: msg.projId,
      isRemote: true,
    });
  }

  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.life -= dt;

      if (p.life <= 0) {
        if (!p.isRemote) {
          const vx = Math.round(p.pos.x / VOXEL),
            vy = Math.round(p.pos.y / VOXEL),
            vz = Math.round(p.pos.z / VOXEL);
          explodeAt(vx, vy, vz, CHARGE_RADIUS);
        }
        scene.remove(p.mesh);
        projectiles.splice(i, 1);
        continue;
      }

      p.vel.y -= GRAVITY * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += dt * 12;
      p.mesh.rotation.y += dt * 9;

      const vx = Math.floor(p.pos.x / VOXEL),
        vy = Math.floor(p.pos.y / VOXEL),
        vz = Math.floor(p.pos.z / VOXEL);

      if (getV(vx, vy, vz) !== 0) {
        if (!p.isRemote) explodeAt(vx, vy, vz, CHARGE_RADIUS);
        scene.remove(p.mesh);
        projectiles.splice(i, 1);
        continue;
      }

      if (!p.isRemote) {
        const hitAny = hitEnemyRay(
          p.pos.x,
          p.pos.y,
          p.pos.z,
          100,
          p.vel.x,
          p.vel.y,
          p.vel.z,
        );
        if (hitAny) {
          explodeAt(vx, vy, vz, CHARGE_RADIUS);
          scene.remove(p.mesh);
          projectiles.splice(i, 1);
          continue;
        }
      }
    }
  }

  function hitEnemiesMelee(range, dmg) {
    const dir = getLookDir();
    const o = camera.position;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - o.x,
        dy = e.pos.y + 0.85 - o.y,
        dz = e.pos.z - o.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > range + 0.5) continue;
      const dot = (dx * dir.x + dy * dir.y + dz * dir.z) / Math.max(d, 0.01);
      if (dot > 0.5) hurtEnemy(e, dmg);
    }
  }

  /* =========================================================================
   16. ENEMIES  —  moved to enemy.js
   ========================================================================= */
  const enemies = [];

  function hurtEnemy(e, dmg) {
    if (window.Enemies && window.Enemies.hurt) window.Enemies.hurt(e, dmg);
  }
  function hitEnemyRay(x, y, z, dmg, dx, dy, dz) {
    if (window.Enemies && window.Enemies.hitRay)
      return window.Enemies.hitRay(x, y, z, dmg, dx, dy, dz);
    return false;
  }
  function updateEnemies(dt) {
    if (window.Enemies) window.Enemies.update(dt);
  }

  /* =========================================================================
       17. PLAYER UPDATE
       ========================================================================= */
  function updatePlayer(dt) {
    if (!player.alive) return;
    player.invuln = Math.max(0, player.invuln - dt);

    const inputLocked = !!player._inputLocked;

    const STAND_HEIGHT = 1.62 * PLAYER_SCALE;
    const STAND_EYE = FP_MODEL.body.eyeY;
    const CROUCH_HEIGHT = STAND_HEIGHT * CROUCH_MUL;
    const CROUCH_EYE = STAND_EYE * CROUCH_MUL;

    const wantCrouch = !!keys["KeyC"];
    let targetCrouchT = wantCrouch ? 1 : 0;

    if (
      targetCrouchT < player.crouchT &&
      collidesPlayer(player.pos, player.halfW, STAND_HEIGHT)
    ) {
      targetCrouchT = player.crouchT;
    }

    const cRate = wantCrouch ? 12 : 8;
    if (player.crouchT < targetCrouchT)
      player.crouchT = Math.min(targetCrouchT, player.crouchT + dt * cRate);
    else if (player.crouchT > targetCrouchT)
      player.crouchT = Math.max(targetCrouchT, player.crouchT - dt * cRate);

    player.crouching = player.crouchT > 0.5;

    player.height =
      STAND_HEIGHT + (CROUCH_HEIGHT - STAND_HEIGHT) * player.crouchT;
    player.eye = STAND_EYE + (CROUCH_EYE - STAND_EYE) * player.crouchT;

    let mf = 0, mr = 0;
    if (!inputLocked) {                          // NEW guard
      if (keys["KeyW"] || keys["ArrowUp"]) mf += 1;
      if (keys["KeyS"] || keys["ArrowDown"]) mf -= 1;
      if (keys["KeyD"] || keys["ArrowRight"]) mr += 1;
      if (keys["KeyA"] || keys["ArrowLeft"]) mr -= 1;
      if (mf || mr) {
        const l = Math.hypot(mf, mr);
        mf /= l; mr /= l;
      }
    }

    const sprinting = !inputLocked && (          // NEW guard
      (keys["ShiftLeft"] || keys["ShiftRight"]) &&
      (mf || mr) && player.onGround && player.hunger > 3 && player.crouchT < 0.1
    );

    const crouchMul = 1 - (1 - CROUCH_SPEED_MUL) * player.crouchT;
    const speed = creativeMode
      ? player.sprint * 1.6
      : (sprinting ? player.sprint : player.walk) * crouchMul;

    const sin = Math.sin(player.yaw),
      cos = Math.cos(player.yaw);
    player.vel.x = (-sin * mf + cos * mr) * speed;
    player.vel.z = (-cos * mf - sin * mr) * speed;

    if (creativeMode) {
      let flyY = 0;
      if (!inputLocked) {                        // NEW guard
        if (keys["Space"]) flyY += 1;
        if (keys["ShiftLeft"] || keys["ShiftRight"] ||
          keys["ControlLeft"] || keys["ControlRight"]) flyY -= 1;
      }
      player.vel.y = flyY * player.sprint * 1.4;
    } else {
      if (!inputLocked && keys["Space"] && player.onGround && player.crouchT < 0.1) {
        player.vel.y = player.jump;
        player.onGround = false;
        if (window.Sfx) Sfx.play("jump");
      }
      player.vel.y -= GRAVITY * dt;
      if (player.vel.y < -55) player.vel.y = -55;
    }

    const _wasOnGround = player.onGround;
    const _fallVel = player.vel.y;

    const dy = player.vel.y * dt;
    player.pos.y += dy;
    if (collidesPlayer(player.pos, player.halfW, player.height)) {
      player.pos.y -= dy;
      if (dy < 0) player.onGround = true;
      player.vel.y = 0;
    } else player.onGround = false;

    if (!_wasOnGround && player.onGround && _fallVel < -3 && window.Sfx) {
      Sfx.play("land");
    }

    const hw = player.halfW,
      hh = player.height;

    const dx = player.vel.x * dt;
    if (dx !== 0) {
      player.pos.x += dx;
      if (collidesPlayer(player.pos, hw, hh)) {
        if (
          !(
            player.onGround &&
            tryStepUp(player.pos, hw, hh, STEP_HEIGHT, collidesPlayer)
          )
        ) {
          player.pos.x -= dx;
          player.vel.x = 0;
        }
      }
    }

    const dz = player.vel.z * dt;
    if (dz !== 0) {
      player.pos.z += dz;
      if (collidesPlayer(player.pos, hw, hh)) {
        if (
          !(
            player.onGround &&
            tryStepUp(player.pos, hw, hh, STEP_HEIGHT, collidesPlayer)
          )
        ) {
          player.pos.z -= dz;
          player.vel.z = 0;
        }
      }
    }

    /* --- resolve player vs. detached enemy chunks --- */
    if (window.Enemies && window.Enemies.resolvePlayerDetachedCollisions) {
      window.Enemies.resolvePlayerDetachedCollisions(
        player.pos, player.halfW, player.height,
      );
    }

    if (currentMapType === "sandbox") {
      player.pos.x = clamp(
        player.pos.x,
        SANDBOX_MIN_X + 0.4,
        SANDBOX_MAX_X - 0.4,
      );
      player.pos.z = clamp(
        player.pos.z,
        SANDBOX_MIN_Z + 0.4,
        SANDBOX_MAX_Z - 0.4,
      );
    } else {
      player.pos.x = clamp(player.pos.x, 0.4, WORLD_W - 0.4);
      player.pos.z = clamp(player.pos.z, 0.4, WORLD_D - 0.4);
    }

    if (player.pos.y < -5) {
      const spawnVx = 90,
        spawnVz = 90;
      player.pos.set(spawnVx * VOXEL, 4, spawnVz * VOXEL);
      for (let y = SY - 1; y > 0; y--)
        if (getV(spawnVx, y, spawnVz) !== 0) {
          player.pos.y = (y + 1) * VOXEL + 0.1;
          break;
        }
      damagePlayer(15);
    }

    const _horizSpd = Math.hypot(player.vel.x, player.vel.z);
    if (player.onGround && _horizSpd > 0.6 && player.crouchT < 0.9) {
      _stepAccum += _horizSpd * dt;
      const _stride = STEP_DISTANCE * (sprinting ? 1.15 : 1.0);
      if (_stepAccum >= _stride) {
        _stepAccum = 0;
        if (window.Sfx) {
          Sfx.play("footstep", { variant: surfaceAtPlayer() });
        }
      }
    } else {
      _stepAccum = 0;
    }

    if (mf || mr) player.bob += dt * (sprinting ? 13 : 9);
    else player.bob += dt * 1.4;

    const bobA =
      (mf || mr) && player.onGround
        ? (sprinting ? 0.055 : 0.032) * (1 - 0.4 * player.crouchT)
        : 0.006;

    if (shakeTime > 0) {
      shakeTime -= dt;
      if (shakeTime <= 0) shakeAmt = 0;
    }
    const sx = shakeTime > 0 ? (Math.random() - 0.5) * shakeAmt : 0;
    const sy = shakeTime > 0 ? (Math.random() - 0.5) * shakeAmt : 0;

    const dyv = player.pos.y - player.smoothY;
    if (Math.abs(dyv) > 0.9) player.smoothY = player.pos.y;
    else player.smoothY += dyv * Math.min(1, dt * 16);

    {
      const HALF = VIEW_CONE_HALF;
      const moving = mf !== 0 || mr !== 0;
      const coneMaxStep = VIEW_CONE_BODY_TURN_RATE * dt;

      if (moving) {
        let dev = player.yaw - player.baseYaw;
        while (dev > Math.PI) dev -= Math.PI * 2;
        while (dev < -Math.PI) dev += Math.PI * 2;

        const alignStep = BODY_WALK_ALIGN_RATE * dt;
        if (dev > alignStep) player.baseYaw += alignStep;
        else if (dev < -alignStep) player.baseYaw -= alignStep;
        else player.baseYaw = player.yaw;
      } else {
        let dev = player.targetYaw - player.baseYaw;
        while (dev > Math.PI) dev -= Math.PI * 2;
        while (dev < -Math.PI) dev += Math.PI * 2;

        if (dev > HALF) {
          const targetBase = player.targetYaw - HALF;
          const delta = targetBase - player.baseYaw;
          if (delta > coneMaxStep) player.baseYaw += coneMaxStep;
          else player.baseYaw = targetBase;
        } else if (dev < -HALF) {
          const targetBase = player.targetYaw + HALF;
          const delta = targetBase - player.baseYaw;
          if (delta < -coneMaxStep) player.baseYaw -= coneMaxStep;
          else player.baseYaw = targetBase;
        }
      }

      player.yaw = clamp(
        player.targetYaw,
        player.baseYaw - HALF,
        player.baseYaw + HALF,
      );
    }

    const cosY = Math.cos(player.yaw);
    const sinY = Math.sin(player.yaw);

    const eyeOX = FP_MODEL.body.eyeX;
    const eyeOZ = FP_MODEL.body.eyeZ;

    const eyeWorldX = player.pos.x + eyeOX * cosY + eyeOZ * sinY;
    const eyeWorldZ = player.pos.z - eyeOX * sinY + eyeOZ * cosY;

    let camX = eyeWorldX + sx;
    let camY = player.smoothY + player.eye + Math.cos(player.bob) * bobA + sy;
    let camZ = eyeWorldZ;

    const scopeT =
      window.Weapons && window.Weapons.getScopeT
        ? window.Weapons.getScopeT()
        : 0;

    if (scopeT > 0) {
      const cosB = Math.cos(player.baseYaw);
      const sinB = Math.sin(player.baseYaw);
      const bodyScaleY = 1 - (1 - CROUCH_MUL) * player.crouchT;

      const fpRootWX = player.pos.x + eyeOX * cosB + eyeOZ * sinB;
      const fpRootWY = player.smoothY + FP_MODEL.body.eyeY * bodyScaleY;
      const fpRootWZ = player.pos.z - eyeOX * sinB + eyeOZ * cosB;

      const cp = Math.cos(player.pitch);
      const sp = Math.sin(player.pitch);
      const sightOffX = -0.02 * cp * sinY;
      const sightOffY = 0.02 * sp;
      const sightOffZ = -0.02 * cp * cosY;

      const adsX = fpRootWX + sightOffX;
      const adsY = fpRootWY + sightOffY;
      const adsZ = fpRootWZ + sightOffZ;

      camX += (adsX - camX) * scopeT;
      camY += (adsY - camY) * scopeT;
      camZ += (adsZ - camZ) * scopeT;

      const ADS_SHAKE_KEEP_DEFAULT = 0.10;

      const wActive = (window.Weapons && window.Weapons.getActiveWeapon)
        ? window.Weapons.getActiveWeapon() : null;
      const ADS_SHAKE_KEEP =
        (wActive && typeof wActive.adsShakeKeep === "number")
          ? wActive.adsShakeKeep
          : ADS_SHAKE_KEEP_DEFAULT;

      camX += sx * ADS_SHAKE_KEEP * scopeT;
      camY += sy * ADS_SHAKE_KEEP * scopeT;
    }

    camera.position.set(camX, camY, camZ);
    camera.rotation.set(player.pitch, player.yaw, 0);
    player._sprinting = sprinting;

    updateFpViewModel(dt, mf || mr, sprinting, bobA);

    if (toolCooldown > 0) toolCooldown -= dt;
    if (mouseDown && toolCooldown <= 0 && TOOLS[selectedTool].id !== "hand")
      useTool();
  }

  function updateFpViewModel(dt, moving, sprinting, bobA) {
    playerBody.position.set(player.pos.x, player.smoothY, player.pos.z);
    playerBody.rotation.y = player.baseYaw;

    const bodyScaleY = 1 - (1 - CROUCH_MUL) * player.crouchT;
    playerBody.scale.y = bodyScaleY;
    fpRoot.scale.y = 1 / bodyScaleY;

    let legSwing = 0;
    if (moving) legSwing = Math.sin(player.bob);

    let amp = 0;
    if (moving) {
      amp = sprinting ? FP_MODEL.anim.legAmpSprint : FP_MODEL.anim.legAmpWalk;
      if (!player.onGround) amp *= 0.65;
    }

    legLPivot.rotation.x = legSwing * amp;
    legRPivot.rotation.x = -legSwing * amp;

    const swayAmt = amp * FP_MODEL.anim.legSway;
    legLPivot.rotation.z = -swayAmt * Math.abs(legSwing);
    legRPivot.rotation.z = swayAmt * Math.abs(legSwing);

    if (!player.onGround) {
      const tuck = 0.25;
      legLPivot.rotation.x += tuck;
      legRPivot.rotation.x += tuck;
    }

    const SWAY_K = FP_MODEL.anim.swayK;
    const SWAY_C = FP_MODEL.anim.swayC;

    swayYawVel += (-SWAY_K * swayYaw - SWAY_C * swayYawVel) * dt;
    swayPitchVel += (-SWAY_K * swayPitch - SWAY_C * swayPitchVel) * dt;
    swayYaw += swayYawVel * dt;
    swayPitch += swayPitchVel * dt;
    swayYaw = clamp(swayYaw, -0.22, 0.22);
    swayPitch = clamp(swayPitch, -0.18, 0.18);

    const A = FP_MODEL.anim;

    function resolveHand(block, fallbackPhase) {
      const b = block && typeof block === "object" ? block : {};
      const num = (v, fb) => (typeof v === "number" ? v : fb);
      return {
        bobY: num(b.bobY, num(A.handBob, 1.85)),
        bobX: num(b.bobX, num(A.handBobX, 0.45)),
        bobZ: num(b.bobZ, num(A.handBobZ, 0.3)),
        roll: num(b.roll, num(A.handRoll, 0.05)),
        pitch: num(b.pitch, num(A.handPitch, 0.06)),
        yaw: num(b.yaw, num(A.handYaw, 0.025)),
        phaseOff: num(b.phaseOff, fallbackPhase),
        sprintMul: num(b.sprintMul, num(A.handBobSprintMul, 0.6)),
      };
    }

    const cfgL = resolveHand(A.handL, 0);
    const cfgR = resolveHand(A.handR, Math.PI);

    const bobScale = moving ? 1.0 : 0.0;

    const onGroundSprint = sprinting && moving && player.onGround;
    const cosHalf = Math.cos(player.bob * 0.5);
    const breath = Math.sin(player.bob * 0.35) * A.breath;
    const sprintLean = sprinting && moving ? A.sprintLean : 0;

    if (!weaponDrivesHands) {
      const phL = player.bob + cfgL.phaseOff;
      const sinL = Math.sin(phL);

      handL.position.set(
        HAND_REST.L.x + cosHalf * bobA * cfgL.bobX * bobScale + swayYaw * 0.9,
        HAND_REST.L.y +
        sinL * bobA * cfgL.bobY * bobScale +
        swayPitch * 0.4 +
        breath,
        HAND_REST.L.z + sprintLean,
      );
      handL.rotation.set(
        HAND_REST.L.rx + swayPitch * 1.2,
        HAND_REST.L.ry + swayYaw * 0.8,
        HAND_REST.L.rz + swayYaw * 1.0,
      );

      const phR = player.bob + cfgR.phaseOff;
      const sinR = Math.sin(phR);

      handR.position.set(
        HAND_REST.R.x + cosHalf * bobA * cfgR.bobX * bobScale + swayYaw * 0.9,
        HAND_REST.R.y +
        sinR * bobA * cfgR.bobY * bobScale +
        swayPitch * 0.4 +
        breath,
        HAND_REST.R.z + sprintLean,
      );
      handR.rotation.set(
        HAND_REST.R.rx + swayPitch * 1.2,
        HAND_REST.R.ry + swayYaw * 0.8,
        HAND_REST.R.rz + swayYaw * 1.0,
      );
    }

    updateArmBones(-1, handL);
    updateArmBones(+1, handR);

    fpRoot.rotation.order = "YXZ";

    const scopeT =
      window.Weapons && window.Weapons.getScopeT
        ? window.Weapons.getScopeT()
        : 0;

    const yawFollowBase =
      typeof FP_MODEL.anim.yawFollow === "number"
        ? FP_MODEL.anim.yawFollow
        : 0.35;
    const pitchFollowBase =
      typeof FP_MODEL.anim.pitchFollow === "number"
        ? FP_MODEL.anim.pitchFollow
        : 0.5;

    const yawFollow = yawFollowBase + (1 - yawFollowBase) * scopeT;
    const pitchFollow = pitchFollowBase + (1 - pitchFollowBase) * scopeT;

    const lookYawOffset = player.yaw - player.baseYaw;
    fpRoot.rotation.y = lookYawOffset * yawFollow;
    fpRoot.rotation.x = player.pitch * pitchFollow;

    updateHeldToolAnim(dt);
  }

  function updateStats(dt) {
    if (!player.alive) return;
    if (creativeMode) return;
    if (currentMapType === "sandbox") {
      if (player.health < 100)
        player.health = Math.min(100, player.health + 2 * dt);
      return;
    }
    const mult = player._sprinting ? 2.2 : 1;
    player.hunger = Math.max(0, player.hunger - 0.11 * mult * dt);
    player.thirst = Math.max(0, player.thirst - 0.16 * mult * dt);
    if (player.hunger <= 0 || player.thirst <= 0) {
      damagePlayer(
        ((player.hunger <= 0 ? 1.0 : 0) + (player.thirst <= 0 ? 1.2 : 0)) *
        dt *
        0.55,
        true,
      );
    } else if (
      player.hunger > 50 &&
      player.thirst > 50 &&
      player.health < 100
    ) {
      player.health = Math.min(100, player.health + 0.6 * dt);
    }
  }

  function setCreativeMode(on) {
    creativeMode = !!on;
    if (creativeMode) {
      player.vel.set(0, 0, 0);
      player.crouchT = 0;
      player.crouching = false;
    }
    return creativeMode;
  }

  const _edgeSky = new THREE.Color();
  const EDGE_BASE_SKY = new THREE.Color(SKY);
  const EDGE_BASE_FOG_NEAR = scene.fog.near;
  const EDGE_BASE_FOG_FAR = scene.fog.far;
  let edgeFxT = 0;

  function updateWorldEdgeFx(dt) {
    if (!player.alive) return;

    let minX, maxX, minZ, maxZ;
    if (currentMapType === "sandbox") {
      minX = SANDBOX_MIN_X;
      maxX = SANDBOX_MAX_X;
      minZ = SANDBOX_MIN_Z;
      maxZ = SANDBOX_MAX_Z;
    } else {
      minX = 0;
      maxX = WORLD_W;
      minZ = 0;
      maxZ = WORLD_D;
    }

    const dx = Math.min(player.pos.x - minX, maxX - player.pos.x);
    const dz = Math.min(player.pos.z - minZ, maxZ - player.pos.z);
    const d = Math.min(dx, dz);

    let target = 1 - clamp(d / EDGE_MARGIN, 0, 1);
    target = target * target;

    edgeFxT += (target - edgeFxT) * Math.min(1, dt * 4);
    if (edgeFxT < 1e-4) edgeFxT = 0;

    const k = 1 - edgeFxT;

    _edgeSky.setRGB(
      EDGE_BASE_SKY.r * k,
      EDGE_BASE_SKY.g * k,
      EDGE_BASE_SKY.b * k,
    );
    scene.background.copy(_edgeSky);
    scene.fog.color.copy(_edgeSky);

    scene.fog.near =
      EDGE_BASE_FOG_NEAR + (EDGE_FOG_NEAR_MIN - EDGE_BASE_FOG_NEAR) * edgeFxT;
    scene.fog.far =
      EDGE_BASE_FOG_FAR + (EDGE_FOG_FAR_MIN - EDGE_BASE_FOG_FAR) * edgeFxT;

    if (edgeFxT > 0.15) {
      edgeWarnEl.style.opacity = clamp((edgeFxT - 0.15) / 0.5, 0, 1).toFixed(2);
    } else {
      edgeWarnEl.style.opacity = "0";
    }
  }

  function damagePlayer(amount, continuous) {
    if (!player.alive) return;
    if (creativeMode) return;
    if (!continuous && player.invuln > 0) return;
    player.health -= amount;
    if (!continuous) {
      player.invuln = 0.32;
      hitFlash = 0.5;
      if (window.Sfx) Sfx.play("hurt");
    }
    if (player.health <= 0) {
      player.health = 0;
      die();
    }
  }

  function die() {
    player.alive = false;
    gameRunning = false;
    if (window.Sfx) Sfx.play("death");
    if (inventory.isOpen) inventory.close();
    Minimap.close();
    if (heldPickup) releasePickup(0);
    document.exitPointerLock();
    document.getElementById("deathMsg").textContent =
      player.thirst <= 0
        ? "You died of thirst in the ruins."
        : player.hunger <= 0
          ? "You starved among the rubble."
          : "The creatures dragged you into the dark.";
    document.getElementById("deathScreen").classList.remove("hidden");
    document.getElementById("hud").classList.add("hidden");
  }

  function respawn() {
    const sp = getSpawnPoint();
    placePlayerOnGround(sp.x, sp.z);
    player.vel.set(0, 0, 0);
    player.health = 100;
    player.hunger = 100;
    player.thirst = 100;
    player.alive = true;
    player.yaw = 0;
    player.targetYaw = 0;
    player.baseYaw = 0;
    player.pitch = 0;
    player.invuln = 2;
    player.crouchT = 0;
    player.crouching = false;

    if (window.Enemies) window.Enemies.clear();
    enemies.length = 0;

    document.getElementById("deathScreen").classList.add("hidden");
    document.getElementById("hud").classList.remove("hidden");
    startGame();
  }

  /* =========================================================================
       18. HUD
       ========================================================================= */
  const hotbarEl = document.getElementById("hotbar");
  const hotbarSlots = [];
  function buildHotbarDom() {
    for (let i = 0; i < TOOLS.length; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const key = document.createElement("span");
      key.className = "keynum";
      key.textContent = i + 3;
      const icon = document.createElement("div");
      icon.className = "icon";
      const cnt = document.createElement("span");
      cnt.className = "cnt";
      const nm = document.createElement("span");
      nm.className = "tname";
      nm.textContent = TOOLS[i].name;
      slot.appendChild(key);
      slot.appendChild(icon);
      slot.appendChild(cnt);
      slot.appendChild(nm);
      hotbarEl.appendChild(slot);
      hotbarSlots.push({ slot, icon, cnt });
    }
  }

  function renderHotbar() {
    for (let i = 0; i < TOOLS.length; i++) {
      const t = TOOLS[i],
        el = hotbarSlots[i];
      el.slot.classList.toggle("sel", i === selectedTool);
      el.icon.textContent = t.icon;
      el.icon.style.color = t.color;
      el.cnt.textContent =
        t.count === Infinity ? "" : t.count > 0 ? t.count : "0";
      el.icon.style.opacity = t.count === 0 ? 0.35 : 1;
    }
    updateHeldToolModel();
  }

  const fillHealth = document.getElementById("fillHealth");
  const fillHunger = document.getElementById("fillHunger");
  const fillThirst = document.getElementById("fillThirst");
  const numHealth = document.getElementById("numHealth");
  const numHunger = document.getElementById("numHunger");
  const numThirst = document.getElementById("numThirst");
  const scrapCount = document.getElementById("scrapCount");
  const fpsEl = document.getElementById("fps");
  const threatsEl = document.getElementById("threats");
  const peersEl = document.getElementById("peers");

  let hudTimer = 0;
  function updateHud(dt) {
    hudTimer += dt;
    if (hudTimer < 0.1) return;
    hudTimer = 0;
    fillHealth.style.width = player.health + "%";
    fillHunger.style.width = player.hunger + "%";
    fillThirst.style.width = player.thirst + "%";
    numHealth.textContent = Math.ceil(player.health);
    numHunger.textContent = Math.ceil(player.hunger);
    numThirst.textContent = Math.ceil(player.thirst);
    scrapCount.textContent = scrap;
    let _aliveThreats = 0;
    for (let i = 0; i < enemies.length; i++)
      if (enemies[i].alive) _aliveThreats++;
    threatsEl.textContent = "THREATS " + _aliveThreats;

    const mpCount =
      window.ARiveMP && window.ARiveMP.connected
        ? 1 + window.ARiveMP.remotePlayers.size
        : 1;
    peersEl.textContent = "SURVIVORS " + mpCount;
  }

  const edgeWarnEl = (function () {
    let el = document.getElementById("edgeWarn");
    if (!el) {
      el = document.createElement("div");
      el.id = "edgeWarn";
      el.textContent = "◈  VOID AHEAD — TURN BACK  ◈";
      el.style.cssText =
        "position:fixed;left:50%;top:22%;transform:translateX(-50%);" +
        'font:bold 20px "Courier New",monospace;letter-spacing:6px;' +
        "color:#e8c86a;text-shadow:2px 2px 0 #000,0 0 22px rgba(232,200,106,.6);" +
        "pointer-events:none;opacity:0;transition:opacity .2s;" +
        "z-index:8;white-space:nowrap;";
      document.body.appendChild(el);
    }
    return el;
  })();

  const lockHintEl = (function () {
    let el = document.getElementById("lockHint");
    if (!el) {
      el = document.createElement("div");
      el.id = "lockHint";
      el.textContent = "◈  CLICK TO LOOK  ◈";
      el.style.cssText =
        "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);" +
        'font:bold 18px "Courier New",monospace;letter-spacing:5px;' +
        "color:#e8c86a;text-shadow:2px 2px 0 #000,0 0 18px rgba(232,200,106,.55);" +
        "pointer-events:none;opacity:0;transition:opacity .15s;" +
        "z-index:9;white-space:nowrap;";
      document.body.appendChild(el);
    }
    return el;
  })();

  let lockHintTimer = 0;
  function updatePointerLockHint(dt) {
    const wantLock =
      gameRunning &&
      player.alive &&
      !pointerLocked &&
      !inventory.isOpen &&
      !(Minimap && Minimap.isOpen()) &&
      !(window.SandboxMenu && window.SandboxMenu.isOpen()) &&
      !(window.SandboxMenu && window.SandboxMenu.isPlacing && window.SandboxMenu.isPlacing());

    if (wantLock) lockHintTimer += dt;
    else lockHintTimer = 0;

    lockHintEl.style.opacity = lockHintTimer > 0.25 ? "1" : "0";
  }

  const flashEl = (function () {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:4;background:radial-gradient(circle at center,transparent 45%,rgba(200,20,20,.55) 100%);opacity:0;transition:opacity .15s";
    document.body.appendChild(el);
    return el;
  })();

  /* =========================================================================
   19. LEGACY MULTIPLAYER (BroadcastChannel tab-to-tab carve/boom only)
   ========================================================================= */
  class Net {
    constructor() {
      this.id = Math.random().toString(36).slice(2, 8);
      this.enabled = false;
      try {
        if (typeof BroadcastChannel !== "undefined") {
          this.channel = new BroadcastChannel("ruincity-fine-v3");
          this.channel.onmessage = (e) => this.onMessage(e.data);
          this.enabled = true;
          window.addEventListener("beforeunload", () => {
            try {
              this.channel.postMessage({ t: "bye", id: this.id });
            } catch (e) { }
          });
        }
      } catch (e) {
        console.warn("MP unavailable", e);
      }
    }
    send(m) {
      if (this.enabled)
        try {
          this.channel.postMessage(m);
        } catch (e) { }
    }

    sendCarve(x, y, z, r, ignite) {
      this.send({ t: "carve", id: this.id, x, y, z, r, ignite });
    }
    sendExplosion(x, y, z, r) {
      this.send({ t: "boom", id: this.id, x, y, z, r });
    }

    onMessage(m) {
      if (!m || m.id === this.id) return;
      if (m.t === "carve") {
        const rv = m.r;
        const R = Math.ceil(rv);
        const r2 = rv * rv;
        const cx = m.x,
          cy = m.y,
          cz = m.z;
        for (let dy = -R; dy <= R; dy++)
          for (let dz = -R; dz <= R; dz++)
            for (let dx = -R; dx <= R; dx++) {
              if (dx * dx + dy * dy + dz * dz > r2) continue;
              const wx = cx + dx,
                wy = cy + dy,
                wz = cz + dz;
              if (getV(wx, wy, wz) === 0) continue;
              setVRaw(wx, wy, wz, 0);
              markDirty(wx, wy, wz);
              if (m.ignite) {
                const b = getV(wx, wy, wz);
                if (
                  b &&
                  BLOCKS[b] &&
                  BLOCKS[b].flammable &&
                  Math.random() < 0.2
                )
                  ignite(wx, wy, wz);
              }
            }
        return;
      }
      if (m.t === "boom") {
        const rv = m.r / VOXEL;
        const R = Math.ceil(rv),
          r2 = rv * rv;
        for (let dy = -R; dy <= R; dy++)
          for (let dz = -R; dz <= R; dz++)
            for (let dx = -R; dx <= R; dx++) {
              if (dx * dx + dy * dy + dz * dz > r2) continue;
              const wx = m.x + dx,
                wy = m.y + dy,
                wz = m.z + dz;
              if (getV(wx, wy, wz) === 0) continue;
              setVRaw(wx, wy, wz, 0);
              markDirty(wx, wy, wz);
            }
        return;
      }
    }

    update(dt) { }
  }
  const net = new Net();

  /* =========================================================================
   20. SCREENS + BOOT
   ========================================================================= */
  const overlayEl = document.getElementById("overlay");
  const loadingEl = document.getElementById("loading");
  const mapSelectEl = document.getElementById("mapSelect");
  const hudEl = document.getElementById("hud");
  const progressEl = document.getElementById("progressBar");

  function showOverlay(s) {
    overlayEl.classList.toggle("hidden", !s);
  }

  function startGame() {
    overlayEl.classList.add("hidden");
    document.getElementById("deathScreen").classList.add("hidden");
    hudEl.classList.remove("hidden");
    gameRunning = true;
    requestPointerLockSafely();
  }

  document.getElementById("playBtn").addEventListener("click", startGame);
  document.getElementById("respawnBtn").addEventListener("click", respawn);

  const settingsScreen = document.getElementById("settingsScreen");
  const setSensitivitySlider = document.getElementById("setSensitivity");
  const setSensitivityVal = document.getElementById("setSensitivityVal");
  const setViewChunksSlider = document.getElementById("setViewChunks");
  const setViewChunksVal = document.getElementById("setViewChunksVal");
  const setMasterVolumeSlider = document.getElementById("setMasterVolume");
  const setMasterVolumeVal = document.getElementById("setMasterVolumeVal");
  const setSeVolumeSlider = document.getElementById("setSeVolume");
  const setSeVolumeVal = document.getElementById("setSeVolumeVal");

  function applyAudioVolumes() {
    const m = settings.masterVolume;
    const s = settings.seVolume;

    if (window.Sfx) {
      Sfx.setVolume("master", m);
      Sfx.setSeVolume(s);
    }
    if (window.Weapons && window.Weapons.setSoundVolume) {
      window.Weapons.setSoundVolume(m * s);
    }
  }

  function refreshSettingsUI() {
    setSensitivitySlider.value = settings.sensitivity;
    setSensitivityVal.textContent = "x" + settings.sensitivity.toFixed(1);

    const vc =
      typeof settings.viewChunks === "number" ? settings.viewChunks : 6;
    setViewChunksSlider.value = vc;
    setViewChunksVal.textContent = vc;

    const mv =
      typeof settings.masterVolume === "number" ? settings.masterVolume : 1;
    const sv = typeof settings.seVolume === "number" ? settings.seVolume : 1;
    setMasterVolumeSlider.value = mv;
    setMasterVolumeVal.textContent = Math.round(mv * 100) + "%";
    setSeVolumeSlider.value = sv;
    setSeVolumeVal.textContent = Math.round(sv * 100) + "%";
  }

  setSensitivitySlider.addEventListener("input", () => {
    settings.sensitivity = parseFloat(setSensitivitySlider.value);
    setSensitivityVal.textContent = "x" + settings.sensitivity.toFixed(1);
    saveSettings();
  });

  setViewChunksSlider.addEventListener("input", () => {
    const v = clamp(parseInt(setViewChunksSlider.value, 10) || 6, 3, 12);
    settings.viewChunks = v;
    setViewChunksVal.textContent = v;
    saveSettings();

    LOAD_RADIUS = v;
    UNLOAD_RADIUS = v + 3;

    lastStreamedCx = -99999;
    lastStreamedCz = -99999;
    if (player && player.alive) {
      unloadFarChunks(player.pos.x, player.pos.z);
    }

    refreshPickupVisibility();
  });

  setMasterVolumeSlider.addEventListener("input", () => {
    settings.masterVolume = parseFloat(setMasterVolumeSlider.value);
    setMasterVolumeVal.textContent =
      Math.round(settings.masterVolume * 100) + "%";
    saveSettings();
    applyAudioVolumes();
  });

  setSeVolumeSlider.addEventListener("input", () => {
    settings.seVolume = parseFloat(setSeVolumeSlider.value);
    setSeVolumeVal.textContent = Math.round(settings.seVolume * 100) + "%";
    saveSettings();
    applyAudioVolumes();
  });

  document.getElementById("settingsBtn").addEventListener("click", () => {
    overlayEl.classList.add("hidden");
    settingsScreen.classList.remove("hidden");
    refreshSettingsUI();
  });

  document.getElementById("settingsBackBtn").addEventListener("click", () => {
    settingsScreen.classList.add("hidden");
    overlayEl.classList.remove("hidden");
  });

  refreshSettingsUI();
  applyAudioVolumes();

  const LOCAL_STRUCTURES_KEY = "arive-structures-v1";

  function mergeLocalStructures() {
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(LOCAL_STRUCTURES_KEY) || "[]");
    } catch (e) {
      console.warn("[ARive] could not parse local structures:", e);
      return;
    }

    const spawning = saved.filter((s) => s && s.spawn && s.blocks && s.size);
    if (!spawning.length) return;

    window.ARIVE_STRUCTURES = window.ARIVE_STRUCTURES || [];

    for (const s of spawning) {
      const idx = window.ARIVE_STRUCTURES.findIndex((x) => x.name === s.name);
      if (idx >= 0)
        window.ARIVE_STRUCTURES[idx] = s;
      else window.ARIVE_STRUCTURES.push(s);
    }

    console.log(
      "[ARive] Loaded " +
      spawning.length +
      " spawnable structure(s) from editor:",
      spawning.map((s) => s.name).join(", "),
    );
  }

  const STRUCTURES_BASE = "assets/model/structureModel/";

  async function fetchDirectoryListing(url) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) return null;
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) return await r.json();
      return await r.text();
    } catch (e) {
      return null;
    }
  }

  function extractJsonNames(listing) {
    const names = new Set();

    if (typeof listing === "string") {
      const linkRe = /href\s*=\s*["']([^"']+\.json)(?:\?[^"']*)?["']/gi;
      let m;
      while ((m = linkRe.exec(listing)) !== null) {
        const base = m[1].split("/").pop();
        if (base) names.add(base);
      }
    }

    if (names.size === 0 && Array.isArray(listing)) {
      for (const item of listing) {
        const s = typeof item === "string" ? item : (item && item.name) || "";
        const base = s.split("/").pop();
        if (base.toLowerCase().endsWith(".json")) names.add(base);
      }
    }

    names.delete("manifest.json");
    names.delete("index.json");

    return [...names];
  }

  async function loadStructuresFromFolder() {
    window.ARIVE_STRUCTURES = window.ARIVE_STRUCTURES || [];

    let names = window.ARIVE_STRUCTURE_FILES || null;

    if (!names || !names.length) {
      const listing = await fetchDirectoryListing(STRUCTURES_BASE);
      if (listing !== null) {
        names = extractJsonNames(listing);
        if (names.length) {
          console.warn(
            "[ARive] index.js is empty or missing — fell back to " +
            "directory scan.  Add filenames to " +
            "assets/model/structureModel/index.js for Live Server.",
          );
        }
      }
    }

    if (!names || !names.length) {
      console.warn(
        "[ARive] No structures to load.  Add filenames to " +
        "assets/model/structureModel/index.js",
      );
      return;
    }

    console.log(
      "[ARive] Loading " + names.length + " structure file(s):",
      names.join(", "),
    );

    const loaded = await Promise.all(
      names.map(async (name) => {
        try {
          const r = await fetch(STRUCTURES_BASE + name, { cache: "no-cache" });
          if (!r.ok) {
            console.warn("[ARive] ✗", name, r.status);
            return null;
          }
          return await r.json();
        } catch (e) {
          console.warn("[ARive] ✗", name, e.message);
          return null;
        }
      }),
    );

    for (const s of loaded) {
      if (!s || !Array.isArray(s.blocks) || !Array.isArray(s.size)) continue;
      const idx = window.ARIVE_STRUCTURES.findIndex((x) => x.name === s.name);
      if (idx >= 0) window.ARIVE_STRUCTURES[idx] = s;
      else window.ARIVE_STRUCTURES.push(s);
      console.log(
        "[ARive] ✓",
        s.name,
        "(" + s.size.join("×") + ", " + s.blocks.length + " blocks)",
      );
    }
  }

  document.getElementById("resetBtn").addEventListener("click", () => {
    overlayEl.classList.add("hidden");
    hudEl.classList.add("hidden");
    gameRunning = false;
    document.exitPointerLock();
    loadingEl.classList.remove("hidden");
    boot(currentMapType);
  });

  document.getElementById("menuBtn").addEventListener("click", () => {
    overlayEl.classList.add("hidden");
    hudEl.classList.add("hidden");
    gameRunning = false;
    document.exitPointerLock();
    mapSelectEl.classList.remove("hidden");
  });

  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) startGame();
  });

  canvas.addEventListener("click", () => {
    if (altHeld) return;
    if (gameRunning && !pointerLocked && !inventory.isOpen) {
      requestPointerLockSafely();
    }
  });

  /* =========================================================================
       20.5  MAP SYSTEM + SANDBOX
       ========================================================================= */
  let currentMapType = "city";
  let loopStarted = false;

  const MAP_INFO = {
    city: {
      title: "RUIN CITY",
      sub: "The city fell. The creatures stayed.",
      note: "TAB bag · ESC menu · LMB use tool · SURVIVE",
    },
    sandbox: {
      title: "SANDBOX",
      sub: "Flat test map. Spawn anything with the dev panel.",
      note: "TAB bag · G dev tools · LMB use tool",
    },
  };

  function getSpawnPoint() {
    if (currentMapType === "sandbox") {
      return { x: WORLD_W * 0.5, z: WORLD_D * 0.5 };
    }

    if (
      cityLayout &&
      cityLayout.roadXs &&
      cityLayout.roadZs &&
      cityLayout.roadXs.length &&
      cityLayout.roadZs.length
    ) {
      const cX = SX * 0.5,
        cZ = SZ * 0.5;
      let bestX = cityLayout.roadXs[0];
      let bestZ = cityLayout.roadZs[0];
      let bestD = Infinity;
      for (const rx of cityLayout.roadXs) {
        for (const rz of cityLayout.roadZs) {
          const d = (rx - cX) * (rx - cX) + (rz - cZ) * (rz - cZ);
          if (d < bestD) {
            bestD = d;
            bestX = rx;
            bestZ = rz;
          }
        }
      }
      return { x: bestX * VOXEL, z: bestZ * VOXEL };
    }

    return { x: WORLD_W * 0.5, z: WORLD_D * 0.5 };
  }

  function clearWorld() {
    generatedChunks.clear();
    meshedChunks.clear();
    lastStreamedCx = -99999;
    lastStreamedCz = -99999;
    cityLayout = null;

    if (Minimap && Minimap.reset) Minimap.reset();
    if (window.Weapons) window.Weapons.reset();

    voxels.fill(0);
    chunkCounts.fill(0);

    for (const entry of chunkMeshes.values()) {
      if (entry.opaque) {
        scene.remove(entry.opaque);
        entry.opaque.geometry.dispose();
      }
      if (entry.glass) {
        scene.remove(entry.glass);
        entry.glass.geometry.dispose();
      }
    }
    chunkMeshes.clear();

    rebuildQueue.length = 0;
    dirtyChunks.clear();

    if (window.Enemies) window.Enemies.clear();
    enemies.length = 0;

    for (const p of projectiles) scene.remove(p.mesh);
    projectiles.length = 0;
    for (const p of pickups) {
      scene.remove(p.mesh);
      p.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    pickups.length = 0;

    debrisList.length = 0;
    burning.clear();
    pendingExplosions.length = 0;
    processedExplosions.clear();

    explosionParts.length = 0;
    expGeo.setDrawRange(0, 0);
    for (let i = 0; i < MAX_EXP_PARTS; i++) expPos[i * 3 + 1] = -9999;
    expGeo.attributes.position.needsUpdate = true;

    fireGeo.setDrawRange(0, 0);
    for (let i = 0; i < MAX_FIRE; i++) firePos[i * 3 + 1] = -9999;
    fireGeo.attributes.position.needsUpdate = true;

    bloodParts.length = 0;
    bloodGeo.setDrawRange(0, 0);
    for (let i = 0; i < MAX_BLOOD; i++) bloodPos[i * 3 + 1] = -9999;
    bloodGeo.attributes.position.needsUpdate = true;

    if (window.ARiveMP && window.ARiveMP.onWorldReset) {
      try {
        window.ARiveMP.onWorldReset();
      } catch (e) { }
    }
  }

  function generateSandbox(seed) {
    const rnd = mulberry32(seed);

    const x0 = SANDBOX_CX0 * CHUNK,
      x1 = SANDBOX_CX1 * CHUNK;
    const z0 = SANDBOX_CZ0 * CHUNK,
      z1 = SANDBOX_CZ1 * CHUNK;

    for (let x = x0; x < x1; x++) {
      for (let z = z0; z < z1; z++) {
        for (let y = 0; y < GROUND_Y; y++) {
          setVRaw(x, y, z, y === GROUND_Y - 1 ? 9 : 8);
        }
      }
    }

    for (let x = x0; x < x1; x++) {
      for (let y = 0; y < GROUND_Y + 5; y++) {
        setVRaw(x, y, z0, 2);
        setVRaw(x, y, z1 - 1, 2);
      }
    }
    for (let z = z0; z < z1; z++) {
      for (let y = 0; y < GROUND_Y + 5; y++) {
        setVRaw(x0, y, z, 2);
        setVRaw(x1 - 1, y, z, 2);
      }
    }

    const cx = (x0 + x1) >> 1,
      cz = (z0 + z1) >> 1;
    const mats = [2, 3, 5, 11, 7, 15, 6];
    for (let i = 0; i < mats.length; i++) {
      const a = (i / mats.length) * Math.PI * 2;
      const px = cx + Math.round(Math.cos(a) * 40);
      const pz = cz + Math.round(Math.sin(a) * 40);
      for (let y = GROUND_Y; y < GROUND_Y + 14; y++) {
        for (let dx = -2; dx <= 2; dx++)
          for (let dz = -2; dz <= 2; dz++)
            setVRaw(px + dx, y, pz + dz, mats[i]);
      }
    }

    for (let i = 0; i < 16; i++) {
      const x = x0 + 20 + ((rnd() * (x1 - x0 - 40)) | 0);
      const z = z0 + 20 + ((rnd() * (z1 - z0 - 40)) | 0);
      for (let k = 0; k < 3; k++) setVRaw(x, GROUND_Y + k, z, 13);
    }
  }

  function applyBlockBatch(blocks, skipNet) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      setVRaw(b[0], b[1], b[2], b[3]);
      markDirty(b[0], b[1], b[2]);
    }
    if (!skipNet && window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalBlockBatch(blocks);
    }
  }

  function devSpawnBox(vx, vy, vz, w, h, d, blockId) {
    const blocks = [];
    const x0 = vx - Math.floor(w / 2);
    const z0 = vz - Math.floor(d / 2);
    for (let x = x0; x < x0 + w; x++)
      for (let y = vy; y < vy + h; y++)
        for (let z = z0; z < z0 + d; z++) blocks.push([x, y, z, blockId]);
    applyBlockBatch(blocks);
  }

  function devSpawnWall(vx, vy, vz) {
    const W = 2,
      H = 8,
      D = 16;
    const blocks = [];
    for (let x = vx - 1; x < vx - 1 + W; x++)
      for (let y = vy; y < vy + H; y++)
        for (let z = vz; z < vz + D; z++) blocks.push([x, y, z, 3]);
    applyBlockBatch(blocks);
  }

  function devSpawnPillar(vx, vy, vz) {
    const H = 16;
    const blocks = [];
    for (let x = vx - 1; x <= vx + 1; x++)
      for (let y = vy; y < vy + H; y++)
        for (let z = vz - 1; z <= vz + 1; z++) blocks.push([x, y, z, 7]);
    applyBlockBatch(blocks);
  }

  function devSpawnHouse(vx, vy, vz) {
    const W = 14,
      H = 11,
      D = 14,
      WT = 2;
    const blocks = [];
    for (let y = vy; y < vy + H; y++)
      for (let x = vx; x < vx + W; x++)
        for (let z = vz; z < vz + D; z++) {
          const edge =
            x < vx + WT || x >= vx + W - WT || z < vz + WT || z >= vz + D - WT;
          const roof = y >= vy + H - 2;
          if (!edge && !roof) continue;
          const isDoor = y < vy + 6 && x >= vx + 6 && x <= vx + 8 && z < vz + 2;
          if (isDoor) continue;
          const isWin =
            y >= vy + 5 &&
            y < vy + 8 &&
            x >= vx + 4 &&
            x <= vx + 9 &&
            z < vz + WT;
          blocks.push([x, y, z, isWin ? 4 : 2]);
        }
    applyBlockBatch(blocks);
  }

  function devSpawnStairs(vx, vy, vz) {
    const W = 8,
      STEPS = 8;
    const blocks = [];
    for (let i = 0; i < STEPS; i++) {
      for (let x = vx; x < vx + W; x++)
        for (let z = vz + i * 2; z < vz + i * 2 + 2; z++)
          for (let y = vy; y <= vy + i; y++) blocks.push([x, y, z, 2]);
    }
    applyBlockBatch(blocks);
  }

  /* ============================================================
   DEV TOAST — small floating feedback in the bottom-right.
   Used by the inventory overflow path ("Item dropped to floor").
   ============================================================ */
  let _devToastEl = null;
  let _devToastTimer = 0;

  function spawnToast(text) {
    if (!_devToastEl) {
      _devToastEl = document.createElement("div");
      _devToastEl.id = "devToast";
      _devToastEl.style.cssText =
        "position:fixed;right:20px;bottom:20px;z-index:50;" +
        'font:bold 12px "Courier New",monospace;letter-spacing:1px;' +
        "color:#e8c86a;background:#12161d;border:2px solid #e8c86a;" +
        "padding:6px 12px;pointer-events:none;" +
        "box-shadow:0 0 12px rgba(232,200,106,.35);" +
        "opacity:0;transition:opacity .18s;max-width:340px;";
      document.body.appendChild(_devToastEl);
    }
    _devToastEl.textContent = text;
    _devToastEl.style.opacity = "1";
    clearTimeout(_devToastTimer);
    _devToastTimer = setTimeout(function () {
      _devToastEl.style.opacity = "0";
    }, 1800);
  }

  document.querySelectorAll("#mapSelect .map-card").forEach((card) => {
    card.addEventListener("click", () => {
      const map = card.dataset.map;
      mapSelectEl.classList.add("hidden");
      loadingEl.classList.remove("hidden");
      boot(map);
    });
  });

  /* =========================================================================
       21. MAIN LOOP
       ========================================================================= */
  let lastTime = performance.now();
  let fpsAccum = 0,
    fpsFrames = 0;

  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    try {
      updateChunkStreaming();

      const inMP = !!(window.ARiveMP && window.ARiveMP.connected);
      const menusOpen = inventory.isOpen || Minimap.isOpen() ||
        (window.SandboxMenu && window.SandboxMenu.isOpen());
      const overlayOpen = !overlayEl.classList.contains("hidden");

      const simAllowed = gameRunning && player.alive &&
        (inMP || (!menusOpen && !overlayOpen));
      const inputAllowed = gameRunning && player.alive &&
        !menusOpen && !overlayOpen && pointerLocked;

      if (simAllowed) {
        player._inputLocked = !inputAllowed;

        updatePlayer(dt);
        updateStats(dt);

        if (window.Enemies) {
          window.Enemies.update(dt);
          window.Enemies.tickWaves(dt, currentMapType);
        }
        updateProjectiles(dt);

        net.update(dt);
        if (inMP) {
          try { window.ARiveMP.update(dt); } catch (e) { console.error(e); }
        }

        if (inputAllowed) {
          const hit = raycastVoxel(camera.position, getLookDir(), 2.5);
          if (hit) {
            highlight.visible = true;
            highlight.position.set(
              (hit.x + 0.5) * VOXEL,
              (hit.y + 0.5) * VOXEL,
              (hit.z + 0.5) * VOXEL,
            );
          } else highlight.visible = false;
        } else {
          highlight.visible = false;
        }
      } else {
        highlight.visible = false;
      }

      const fpVisible =
        gameRunning &&
        player.alive &&
        !inventory.isOpen &&
        !(window.SandboxMenu && window.SandboxMenu.isOpen());
      playerBody.visible = fpVisible;

      updateFire(dt);
      updateExplosionParts(dt);
      processExplosions();
      updateDebris(dt);
      updateBloodParticles(dt);
      updatePickups(dt);
      flushRebuilds();

      updateHud(dt);
      updateWorldEdgeFx(dt);
      updatePointerLockHint(dt);
      if (window.Weapons) window.Weapons.update(dt);
      if (window.SandboxMenu) window.SandboxMenu.update();
      Minimap.update();

      if (hitFlash > 0) {
        hitFlash -= dt;
        flashEl.style.opacity = clamp(hitFlash * 2, 0, 1);
      }

      fpsAccum += dt;
      fpsFrames++;
      if (fpsAccum >= 0.5) {
        fpsEl.textContent = "FPS " + Math.round(fpsFrames / fpsAccum);
        fpsAccum = 0;
        fpsFrames = 0;
      }
      renderer.render(scene, camera);
    } catch (err) {
      console.error("Frame error:", err);
    }
  }

  /* =========================================================================
       22. PROGRESSIVE BOOT
       ========================================================================= */
  let currentSeed = 0;

  const FALLBACK_WEAPONS = [
    {
      key: "sniper", name: "SNIPER", icon: "◉", color: "#2a3028", w: 4, h: 1,
      ammoType: "5.56", magSize: 5, damage: 95, fireRate: 1.35,
      spread: 0.002, reloadTime: 2.6, scopeFov: 22, scopeSens: 0.28,
      hasScope: true, auto: false, recoilKick: 0.09,
      bulletColor: 0xffe0a0, bulletSize: 0.04,
      model: [
        { p: [0, 0, 0], s: [0.07, 0.09, 0.35], c: 0x2a3028 },
        { p: [0, 0.01, -0.45], s: [0.04, 0.04, 0.5], c: 0x1a1f1a },
        { p: [0, 0.01, -0.74], s: [0.06, 0.06, 0.08], c: 0x30352a },
        { p: [0, -0.03, 0.28], s: [0.06, 0.13, 0.2], c: 0x3a2a1a },
        { p: [0, -0.09, 0.05], s: [0.045, 0.13, 0.07], c: 0x3a2a1a },
        { p: [0, -0.08, -0.12], s: [0.035, 0.1, 0.09], c: 0x3a3a3a },
        { p: [0, 0.115, -0.1], s: [0.045, 0.05, 0.28], c: 0x101010 },
        { p: [0, 0.115, -0.25], s: [0.055, 0.06, 0.02], c: 0x4a6a8a },
        { p: [0, 0.115, 0.045], s: [0.045, 0.05, 0.02], c: 0x202830 },
        { p: [0, 0.06, -0.02], s: [0.025, 0.05, 0.13], c: 0x202020 },
      ],
      muzzleLocal: [0, 0.01, -0.79],
      sightLocal: [0, 0.115, -0.12],
      hipPose: { p: [0.18, -0.24, -0.36], r: [0.03, -0.16, -0.05] },
      adsPose: { p: [-0.0, -0.115, -0.18], r: [0, 0, 0] },
      gripR: { p: [0.0, -0.09, 0.06], r: [0.3, 0.0, -0.1] },
      gripL: { p: [0.0, -0.05, -0.4], r: [0.35, 0.0, 0.12] },
      anim: { swing: 0.55, kick: 0.1, recoilTravel: 0.10, aimTravelMul: 0.8 },
    },
    {
      key: "shotgun", name: "SHOTGUN", icon: "◉", color: "#3a2a1a", w: 4, h: 1,
      ammoType: "shell", magSize: 6, damage: 65, fireRate: 0.85,
      spread: 0.09, reloadTime: 2.4, scopeFov: 62, scopeSens: 0.6,
      auto: false, recoilKick: 0.11,
      bulletColor: 0xffb060, bulletSize: 0.05,
      model: [
        { p: [0, 0, 0], s: [0.085, 0.105, 0.3], c: 0x3a2a1a },
        { p: [0, 0.02, -0.4], s: [0.05, 0.05, 0.5], c: 0x1f1f22 },
        { p: [0, -0.055, -0.34], s: [0.045, 0.045, 0.42], c: 0x2a2a2c },
        { p: [0, -0.075, -0.32], s: [0.075, 0.075, 0.14], c: 0x4a2a14 },
        { p: [0, -0.035, 0.28], s: [0.065, 0.14, 0.22], c: 0x4a2a14 },
        { p: [0, -0.11, 0.05], s: [0.045, 0.13, 0.07], c: 0x3a2010 },
        { p: [0, 0.055, -0.62], s: [0.015, 0.015, 0.015], c: 0xd0a040 },
      ],
      muzzleLocal: [0, 0.02, -0.66],
      sightLocal: [0, 0.06, -0.2],
      hipPose: { p: [0.18, -0.24, -0.36], r: [0.03, -0.13, -0.04] },
      adsPose: { p: [-0.0, -0.06, -0.2], r: [0, 0, 0] },
      gripR: { p: [0.0, -0.11, 0.06], r: [0.3, 0.0, -0.1] },
      gripL: { p: [0.0, -0.075, -0.34], r: [0.42, 0.0, 0.1] },
      anim: { swing: 0.7, kick: 0.12, recoilTravel: 0.075, aimTravelMul: 1.0 },
    },
  ];

  function ensureFallbackWeapons() {
    window.WEAPON_MODEL_DATA = window.WEAPON_MODEL_DATA || [];
    const have = new Set(window.WEAPON_MODEL_DATA.map((d) => d && d.key));
    for (const def of FALLBACK_WEAPONS) {
      if (!have.has(def.key)) {
        window.WEAPON_MODEL_DATA.push(def);
        console.log("[ARive] injected fallback weapon:", def.key);
      }
    }
  }

  /* ---------------------------------------------------------------
   Loads every static asset table the game needs.  Idempotent —
   safe to call from boot() on the host AND from regenerateWorld()
   on a joining client.
   --------------------------------------------------------------- */
  async function initGameAssets() {
    await initItemsAndInventory();
    mergeLocalStructures();
    await loadStructuresFromFolder();

    if (typeof window.loadWeaponsFromFolder === "function") {
      await window.loadWeaponsFromFolder();
    }
    ensureFallbackWeapons();

    if (window.WeaponSkins && window.WeaponSkins.bindSkinSources) {
      window.WeaponSkins.bindSkinSources(window.WEAPON_MODEL_DATA);
    }

    /* Build per-weapon thumbnails (inventory slots need these). */
    for (const def of window.WEAPON_MODEL_DATA || []) {
      if (!Array.isArray(def.model)) continue;
      try {
        const w = Math.max(1, def.w | 0 || 3);
        const h = Math.max(1, def.h | 0 || 1);
        if (w !== h) {
          def.iconImage = renderItemThumbnail(def, w, h);
          def.iconImageRotated = renderItemThumbnail(def, h, w);
        } else if (!def.iconImage) {
          def.iconImage = renderItemThumbnail(def, w, h);
        }
      } catch (e) {
        console.warn("[ARive] weapon thumbnail failed:", def.key, e);
      }
    }

    /* Skinned weapon thumbnails (same code that used to live in boot). */
    if (window.WeaponSkins) {
      for (const wkey in window.WeaponSkins.SKINS) {
        const base = (window.WEAPON_MODEL_DATA || [])
          .find((d) => d.key === wkey);
        if (!base) continue;
        for (const skin of window.WeaponSkins.getSkins(wkey)) {
          try {
            const skinned = window.WeaponSkins.applySkin(base, skin.id);
            if (!Array.isArray(skinned.model)) continue;
            const w = Math.max(1, skinned.w | 0 || 3);
            const h = Math.max(1, skinned.h | 0 || 1);
            if (w !== h) {
              skinned.iconImage = renderItemThumbnail(skinned, w, h);
              skinned.iconImageRotated = renderItemThumbnail(skinned, h, w);
            } else {
              skinned.iconImage = renderItemThumbnail(skinned, w, h);
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    if (window.Weapons) window.Weapons.init();
    applyAudioVolumes();
  }

  async function boot(mapType, forceSeed) {
    currentMapType = mapType || "city";
    resizeRenderer();
    clearWorld();

    await initGameAssets();            // ← replaces the whole loading block

    const seed =
      forceSeed !== undefined && forceSeed !== null
        ? forceSeed
        : (Math.random() * 1e9) | 0;
    currentSeed = seed;

    if (currentMapType === "sandbox") {
      generateSandbox(seed);
    } else {
      cityLayout = generateCityLayout(seed);
    }

    if (hotbarSlots.length === 0) {
      buildHotbarDom();
      renderHotbar();
    }

    const info = MAP_INFO[currentMapType] || MAP_INFO.city;
    document.getElementById("mapTitle").textContent = info.title;
    document.getElementById("mapSubtitle").textContent = info.sub;
    document.getElementById("mapNote").textContent = info.note;

    const sp = getSpawnPoint();

    if (currentMapType === "city") {
      const spawnCx = Math.floor(sp.x / (CHUNK * VOXEL));
      const spawnCz = Math.floor(sp.z / (CHUNK * VOXEL));
      generateChunkColumn(spawnCx, spawnCz);
    }

    placePlayerOnGround(sp.x, sp.z);
    camera.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);

    const list = [];

    if (currentMapType === "city") {
      const pcx = Math.floor(sp.x / (CHUNK * VOXEL));
      const pcz = Math.floor(sp.z / (CHUNK * VOXEL));
      const R = LOAD_RADIUS,
        R2 = R * R;
      for (let dx = -R; dx <= R; dx++) {
        for (let dz = -R; dz <= R; dz++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > R2) continue;
          const cx = pcx + dx,
            cz = pcz + dz;
          if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) continue;
          list.push({ cx, cz, d2 });
        }
      }
      list.sort((a, b) => a.d2 - b.d2);
    } else {
      for (let cx = SANDBOX_CX0; cx < SANDBOX_CX1; cx++) {
        for (let cz = SANDBOX_CZ0; cz < SANDBOX_CZ1; cz++) {
          list.push({ cx, cz, d2: 0 });
        }
      }
    }

    let i = 0;
    (function step() {
      const batch = currentMapType === "sandbox" ? 8 : 4;
      for (let k = 0; k < batch && i < list.length; k++, i++) {
        const { cx, cz } = list[i];

        if (currentMapType === "city") {
          generateChunkColumn(cx, cz);
        } else {
          for (let cy = 0; cy < CHUNKS_Y; cy++) rebuildChunk(cx, cy, cz);
          meshedChunks.add(cx + "," + cz);
          generatedChunks.add(cx + "," + cz);
          if (Minimap && Minimap.markExplored) Minimap.markExplored(cx, cz);
        }
      }
      progressEl.style.width = Math.round((i / list.length) * 100) + "%";
      if (i < list.length) requestAnimationFrame(step);
      else finishBoot();
    })();

    function finishBoot() {
      lastStreamedCx = Math.floor(player.pos.x / (CHUNK * VOXEL));
      lastStreamedCz = Math.floor(player.pos.z / (CHUNK * VOXEL));

      rebuildQueue.length = 0;
      dirtyChunks.clear();

      for (const def of window.WEAPON_MODEL_DATA || []) {
        if (!Array.isArray(def.model)) continue;
        try {
          const w = Math.max(1, def.w | 0 || 3);
          const h = Math.max(1, def.h | 0 || 1);
          if (w !== h) {
            def.iconImage = renderItemThumbnail(def, w, h);
            def.iconImageRotated = renderItemThumbnail(def, h, w);
          } else if (!def.iconImage) {
            def.iconImage = renderItemThumbnail(def, w, h);
          }
          console.log("[ARive] ✓ weapon thumbnail", def.key);
        } catch (e) {
          console.warn("[ARive] ✗ weapon thumbnail failed for", def.key, e);
        }
      }

      if (window.WeaponSkins) {
        for (const wkey in window.WeaponSkins.SKINS) {
          const base = (window.WEAPON_MODEL_DATA || []).find((d) => d.key === wkey);
          if (!base) continue;

          for (const skin of window.WeaponSkins.getSkins(wkey)) {
            try {
              const skinned = window.WeaponSkins.applySkin(base, skin.id);
              if (!Array.isArray(skinned.model)) continue;

              const w = Math.max(1, skinned.w | 0 || 3);
              const h = Math.max(1, skinned.h | 0 || 1);
              if (w !== h) {
                skinned.iconImage = renderItemThumbnail(skinned, w, h);
                skinned.iconImageRotated = renderItemThumbnail(skinned, h, w);
              } else {
                skinned.iconImage = renderItemThumbnail(skinned, w, h);
              }
              console.log("[ARive] ✓ skin thumbnail", wkey, skin.id);
            } catch (e) {
              console.warn("[ARive] ✗ skin thumbnail failed:", wkey, skin.id, e);
            }
          }
        }
      }

      if (window.Weapons) window.Weapons.init();
      applyAudioVolumes();
      Minimap.buildTerrainCache();

      loadingEl.classList.add("hidden");
      if (window.__ariveAutoStart) {
        window.__ariveAutoStart = false;
        startGame();
      } else {
        showOverlay(true);
      }

      if (!loopStarted) {
        loopStarted = true;
        requestAnimationFrame(animate);
      }
    }
  }

  window.addEventListener("load", () =>
    setTimeout(() => {
      resizeRenderer();
    }, 40),
  );

  /* =========================================================================
       MULTIPLAYER BRIDGE
       ========================================================================= */
  const _origSendCarve = net.sendCarve.bind(net);
  net.sendCarve = function (x, y, z, r, ignite) {
    _origSendCarve(x, y, z, r, ignite);
    if (window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalCarve(x, y, z, r, ignite);
    }
  };
  const _origSendExplosion = net.sendExplosion.bind(net);
  net.sendExplosion = function (x, y, z, r) {
    _origSendExplosion(x, y, z, r);
    if (window.ARiveMP && window.ARiveMP.connected) {
      window.ARiveMP.onLocalExplosion(x, y, z, r);
    }
  };

  const DEFAULT_AVATAR = {
    colors: {
      skin: 0xd4a686, hair: 0x3a2418, shirt: 0x3a4a30,
      pants: 0x2a3a4a, boot: 0x18181a, accent: 0x808890,
    },
    body: {
      hipY: 0.53, legLen: 0.42, legW: 0.12, legD: 0.15, legSpread: 0.1,
      bootW: 0.17, bootH: 0.095, bootD: 0.24, bootOffZ: 0.04,
      torsoW: 0.38, torsoH: 0.72, torsoD: 0.17, torsoY: 0.86,
      headW: 0.22, headH: 0.22, headD: 0.22, headY: 1.31,
      hairW: 0.24, hairH: 0.06, hairD: 0.24, hairY: 1.44,
      armW: 0.11, armLen: 0.44, armSpread: 0.045, armY: 1.17,
      armHandW: 0.12, armHandH: 0.13, armHandD: 0.14, armHandOffset: 0.48,
    },
    parts: [],
  };

  function buildRemotePlayerMesh(avatarData) {
    const A = avatarData || window.AVATAR_MODEL_DATA || DEFAULT_AVATAR;
    const S = PLAYER_SCALE;

    const B = Object.fromEntries(
      Object.entries(A.body).map(([k, v]) => [k, v * S]),
    );
    const C = A.colors;

    const lam = (hex) =>
      new THREE.MeshLambertMaterial({ color: hex, fog: true });
    const SKIN = lam(C.skin);
    const HAIR = lam(C.hair);
    const SHIRT = lam(C.shirt);
    const PANTS = lam(C.pants);
    const BOOT = lam(C.boot);
    const ACCENT = lam(C.accent);

    const root = new THREE.Group();

    function buildLeg(side) {
      const pivot = new THREE.Group();
      pivot.position.set(B.legSpread * side, B.hipY, 0);

      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(B.legW, B.legLen, B.legD),
        PANTS,
      );
      leg.position.y = -B.legLen * 0.5;
      pivot.add(leg);

      const boot = new THREE.Mesh(
        new THREE.BoxGeometry(B.bootW, B.bootH, B.bootD),
        BOOT,
      );
      boot.position.set(0, -B.legLen * 0.5 - B.bootH * 0.5 - 0.01, B.bootOffZ);
      leg.add(boot);
      return pivot;
    }
    const legL = buildLeg(-1),
      legR = buildLeg(+1);
    root.add(legL, legR);

    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(B.torsoW, B.torsoH, B.torsoD),
      SHIRT,
    );
    torso.position.y = B.torsoY;
    root.add(torso);

    const head = new THREE.Mesh(
      new THREE.BoxGeometry(B.headW, B.headH, B.headD),
      SKIN,
    );
    head.position.y = B.headY;
    root.add(head);

    const hair = new THREE.Mesh(
      new THREE.BoxGeometry(B.hairW, B.hairH, B.hairD),
      HAIR,
    );
    hair.position.y = B.hairY;
    root.add(hair);

    function buildArm(side) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (B.torsoW * 0.5 + B.armSpread), B.armY, 0);

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(B.armW, B.armLen, B.armW),
        SHIRT,
      );
      arm.position.y = -B.armLen * 0.5;
      pivot.add(arm);

      const hand = new THREE.Mesh(
        new THREE.BoxGeometry(B.armHandW, B.armHandH, B.armHandD),
        SKIN,
      );
      hand.position.y = -B.armHandOffset;
      pivot.add(hand);

      const handAttach = new THREE.Group();
      handAttach.position.set(0, -B.armHandOffset, 0);
      pivot.add(handAttach);
      pivot.userData.handAttach = handAttach;

      return pivot;
    }
    const armL = buildArm(-1),
      armR = buildArm(+1);
    root.add(armL, armR);

    const partParents = {
      head: head, torso: torso, hip: root,
      armL: armL, armR: armR, legL: legL, legR: legR,
    };
    for (const p of A.parts || []) {
      const parent = partParents[p.parent] || root;
      const cube = new THREE.Mesh(
        new THREE.BoxGeometry(p.s[0], p.s[1], p.s[2]),
        lam(p.c),
      );
      cube.position.set(p.p[0], p.p[1], p.p[2]);
      if (p.r) cube.rotation.set(p.r[0], p.r[1], p.r[2]);
      parent.add(cube);
    }

    const toolHolders = {};
    const restR = FP_MODEL.hands.R || { rx: 0, ry: 0, rz: 0 };
    for (const t of TOOLS) {
      const def = TOOL_HELD[t.id];
      if (!def) continue;
      const holder = new THREE.Group();
      holder.position.set(def.pose.p[0], def.pose.p[1], def.pose.p[2]);
      holder.rotation.set(
        def.pose.r[0] + (restR.rx || 0),
        def.pose.r[1] + (restR.ry || 0),
        def.pose.r[2] + (restR.rz || 0),
      );
      holder.visible = false;
      holder.add(buildItemMesh(def.model));
      armR.userData.handAttach.add(holder);
      toolHolders[t.id] = holder;

      holder.userData.baseRx = holder.rotation.x;
      holder.userData.baseRy = holder.rotation.y;
      holder.userData.baseRz = holder.rotation.z;
      holder.userData.basePz = holder.position.z;
      holder.userData.swing = def.anim.swing;
      holder.userData.kick = def.anim.kick;
    }

    /* ---- Weapon holders — one per WEAPON_MODEL_DATA entry.  A remote
   player swaps between these and the toolHolders based on the
   `weaponSlot` field carried on every state tick. */
    const weaponHolders = {};
    const weaponDefs = window.WEAPON_MODEL_DATA || [];
    for (const wdef of weaponDefs) {
      if (!wdef || !Array.isArray(wdef.model)) continue;
      if (weaponHolders[wdef.key]) continue;

      const holder = new THREE.Group();
      const hp = wdef.hipPose || { p: [0.18, -0.24, -0.36], r: [0.03, -0.16, -0.05] };
      holder.position.set(hp.p[0], hp.p[1], hp.p[2]);
      holder.rotation.set(hp.r[0], hp.r[1], hp.r[2]);
      holder.visible = false;
      holder.add(buildItemMesh(wdef.model));
      armR.userData.handAttach.add(holder);
      weaponHolders[wdef.key] = holder;

      holder.userData.baseRx = holder.rotation.x;
      holder.userData.baseRy = holder.rotation.y;
      holder.userData.baseRz = holder.rotation.z;
      holder.userData.basePz = holder.position.z;
      holder.userData.swing = 0.4;
      holder.userData.kick = 0.06;
    }

    return {
      group: root, legL, legR, armL, armR, torso, head, hair,
      toolHolders,
      weaponHolders,
      handAttachL: armL.userData.handAttach,
      handAttachR: armR.userData.handAttach,
    };
  }

  // Expose a compact surface for multiplayer.js
  window.ARiveHooks = {
    THREE: THREE,
    scene: scene,
    camera: camera,
    renderer: renderer,
    player: player,
    pickups: pickups,
    enemies: enemies,
    voxels: voxels,
    CROUCH_MUL: CROUCH_MUL,
    BLOCKS: BLOCKS,
    VOXEL: VOXEL,
    SX: SX,
    SY: SY,
    SZ: SZ,
    WORLD_W: WORLD_W,
    WORLD_D: WORLD_D,

    setCreativeMode: setCreativeMode,
    getCreativeMode: function () { return creativeMode; },

    fpRoot: fpRoot,
    handL: handL,
    handR: handR,
    setWeaponDrivesHands: setWeaponDrivesHands,
    updateArmBones: updateArmBones,

    CHUNK: CHUNK,
    canvas: canvas,

    /* ---- weapons.js needs ---- */
    getLookDir: getLookDir,
    raycastVoxel: raycastVoxel,
    carveSphere: carveSphere,
    hurtEnemy: hurtEnemy,
    shakeCamera: shakeCamera,
    updateHeldToolModel: updateHeldToolModel,
    getAmmoDef: function (type) {
      if (!type) return null;

      if (AMMO_BY_TYPE[type]) return AMMO_BY_TYPE[type];

      const canon = (window.ARiveAmmo && window.ARiveAmmo.canon) || null;
      if (canon) {
        const want = canon(type);
        for (const k in AMMO_BY_TYPE) {
          if (canon(AMMO_BY_TYPE[k].ammoType) === want) return AMMO_BY_TYPE[k];
        }
      }

      const lower = String(type).toLowerCase();
      for (const k in AMMO_BY_TYPE) {
        if (String(AMMO_BY_TYPE[k].ammoType).toLowerCase() === lower) {
          return AMMO_BY_TYPE[k];
        }
      }
      return null;
    },
    net: net,

    /* ---- enemy.js needs ---- */
    spawnBloodBurst: spawnBloodBurst,
    damagePlayer: damagePlayer,
    AMMO_BY_TYPE: AMMO_BY_TYPE,
    WORLD_H: WORLD_H,
    hitEnemyRay: hitEnemyRay,

    getCityLayout: function () {
      return cityLayout;
    },
    getGameRunning: function () {
      return gameRunning;
    },
    getInventory: function () {
      return inventory;
    },

    getV: getV,
    setVRaw: setVRaw,
    markDirty: markDirty,
    explodeAt: explodeAt,
    spawnPickup: spawnPickup,
    spawnRemoteProjectile: spawnRemoteProjectile,
    buildRemotePlayerMesh: buildRemotePlayerMesh,
    getCurrentSeed: function () {
      return currentSeed;
    },
    getCurrentMapType: function () {
      return currentMapType;
    },
    getCurrentToolId: function () {
      return TOOLS[selectedTool].id;
    },
    regenerateWorld: async function (seed, mapType) {
      currentMapType = mapType || currentMapType;
      currentSeed = seed;

      /* FIRST — the client still needs the item/weapon/structure tables
         the host built during boot().  This is idempotent, so a second
         world gen on the same client is a no-op. */
      await initGameAssets();

      resizeRenderer();
      clearWorld();

      quietGeneration = true;
      if (currentMapType === "sandbox") {
        generateSandbox(seed);
        for (let cx = 0; cx < CHUNKS_X; cx++)
          for (let cy = 0; cy < CHUNKS_Y; cy++)
            for (let cz = 0; cz < CHUNKS_Z; cz++) rebuildChunk(cx, cy, cz);
      } else {
        cityLayout = generateCityLayout(seed);
      }

      const sp = getSpawnPoint();

      if (currentMapType === "city") {
        const spawnCx = Math.floor(sp.x / (CHUNK * VOXEL));
        const spawnCz = Math.floor(sp.z / (CHUNK * VOXEL));
        generateChunkColumn(spawnCx, spawnCz);
      }

      placePlayerOnGround(sp.x, sp.z);

      if (currentMapType === "city") {
        fillInitialRing(sp.x, sp.z, 4);
        lastStreamedCx = Math.floor(sp.x / (CHUNK * VOXEL));
        lastStreamedCz = Math.floor(sp.z / (CHUNK * VOXEL));
      }

      if (hotbarSlots.length === 0) {
        buildHotbarDom();
        renderHotbar();
      }

      Minimap.buildTerrainCache();
      console.log("[ARive] client world regenerated · seed", seed);
    },
    applyBlockBatch: function (blocks) {
      applyBlockBatch(blocks, true);
    },

    suppressNextPause: function () {
      suppressUnlockPause = true;
      clearTimeout(_suppressPauseTimer);
      _suppressPauseTimer = setTimeout(function () {
        suppressUnlockPause = false;
      }, 1500);
    },

    /* =============== MULTIPLAYER FLOW HOOKS =============== */

    startPlaying: function (mapType, seed) {
      mapSelectEl.classList.add("hidden");
      settingsScreen.classList.add("hidden");
      overlayEl.classList.add("hidden");
      var mpScr = document.getElementById("mpScreen");
      if (mpScr) mpScr.classList.add("hidden");
      document.getElementById("deathScreen").classList.add("hidden");
      loadingEl.classList.remove("hidden");
      window.__ariveAutoStart = true;
      boot(mapType || "city", seed);
    },

    showLoadingScreen: function () {
      mapSelectEl.classList.add("hidden");
      settingsScreen.classList.add("hidden");
      overlayEl.classList.add("hidden");
      var mpScr = document.getElementById("mpScreen");
      if (mpScr) mpScr.classList.add("hidden");
      document.getElementById("deathScreen").classList.add("hidden");
      loadingEl.classList.remove("hidden");
      progressEl.style.width = "100%";
    },

    beginPlay: function () {
      mapSelectEl.classList.add("hidden");
      settingsScreen.classList.add("hidden");
      overlayEl.classList.add("hidden");
      var mpScr = document.getElementById("mpScreen");
      if (mpScr) mpScr.classList.add("hidden");
      document.getElementById("deathScreen").classList.add("hidden");
      loadingEl.classList.add("hidden");
      hudEl.classList.remove("hidden");
      gameRunning = true;
      if (!loopStarted) {
        loopStarted = true;
        requestAnimationFrame(animate);
      }
      var p = canvas.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(function () { });
    },

    stopPlaying: function () {
      overlayEl.classList.add("hidden");
      hudEl.classList.add("hidden");
      var mpScr = document.getElementById("mpScreen");
      if (mpScr) mpScr.classList.add("hidden");
      document.getElementById("deathScreen").classList.add("hidden");
      settingsScreen.classList.add("hidden");
      gameRunning = false;
      window.__ariveAutoStart = false;
      try {
        document.exitPointerLock();
      } catch (e) { }
      mapSelectEl.classList.remove("hidden");
    },

    requestPointerLock: requestPointerLockSafely,

    setMpBadge: function (text) {
      var el = document.getElementById("mpBadge");
      if (!el) return;
      if (text) {
        el.textContent = text;
        el.style.display = "block";
      } else {
        el.style.display = "none";
      }
    },

    /* ---- sandbox_menu.js needs ---- */
    getItemDefs: function () { return ITEM_DEFS; },
    getFurnitureDefs: function () { return window.ARIVE_FURNITURE || []; },

    getCrosshairTarget: function () {
      const dir = getLookDir();
      const hit = raycastVoxel(camera.position, dir, 14);
      if (!hit) return null;
      const vx = hit.x + hit.nx;
      const vy = hit.y + hit.ny;
      const vz = hit.z + hit.nz;
      return {
        vx, vy, vz,
        x: (vx + 0.5) * VOXEL,
        y: (vy + 1.0) * VOXEL + 0.05,
        z: (vz + 0.5) * VOXEL,
      };
    },

    getGroundYAtVoxel: function (vx, vz) {
      for (let y = SY - 1; y > 0; y--) {
        if (getV(vx, y, vz) !== 0) return (y + 1) * VOXEL + 0.1;
      }
      return 30 * VOXEL;
    },

    spawnItemAt: function (x, y, z, def) {
      return spawnPickup({
        name: def.name || "ITEM",
        icon: def.icon || "",
        iconImage: def.iconImage,
        iconImageRotated: def.iconImageRotated,
        w: def.w || 1,
        h: def.h || 1,
        color: def.color || "#4a5a6a",
        meta: def.meta || (Array.isArray(def.model) ? { model: def.model } : null),
        size: def.size,
        furnitureKey: def.furnitureKey,
        isAmmo: !!def.isAmmo,
        ammoType: def.ammoType,
        count: def.count,
        maxStack: def.maxStack,
      }, new THREE.Vector3(x, y, z));
    },

    spawnAmmoAt: function (x, y, z, def) {
      const amount = (def.ammoType === "shell" || def.ammoType === "short") ? 20 : 30;
      return this.spawnItemAt(x, y, z, Object.assign({}, def, {
        isAmmo: true,
        ammoType: def.ammoType,
        count: amount,
        maxStack: def.maxStack || 200,
      }));
    },

    spawnWeaponAt: function (x, y, z, def, skinId) {
      if (!Array.isArray(def.model)) return null;
      let finalDef = def;
      if (window.WeaponSkins) {
        const skins = window.WeaponSkins.getSkins(def.key);
        if (skins.length > 1) {
          const pick = skinId || window.WeaponSkins.randomSkin(def.key).id;
          finalDef = window.WeaponSkins.applySkin(def, pick);
        }
      }
      const meta = Object.assign({}, finalDef.meta || {});
      meta.model = finalDef.model;
      return spawnPickup({
        name: finalDef.name || finalDef.key || "WEAPON",
        icon: finalDef.icon || "◉",
        iconImage: finalDef.iconImage,
        iconImageRotated: finalDef.iconImageRotated,
        w: finalDef.w || 3,
        h: finalDef.h || 1,
        color: finalDef.color || "#4a3820",
        meta: meta,
        isWeapon: true,
        weaponDef: finalDef,
      }, new THREE.Vector3(x, y, z));
    },

    spawnFurnitureAt: function (x, y, z, def) {
      const meta = Object.assign({}, def.meta || {});
      if (!meta.model && Array.isArray(def.model)) meta.model = def.model;
      return spawnPickup({
        name: def.name,
        iconImage: def.iconImage,
        iconImageRotated: def.iconImageRotated,
        w: def.w, h: def.h,
        color: def.color,
        meta: meta,
        size: def.size,
        furnitureKey: def.key,
      }, new THREE.Vector3(x, y, z));
    },

    placeBlockAt: function (vx, vy, vz, blockId) {
      if (vx < 0 || vy < 0 || vz < 0 || vx >= SX || vy >= SY || vz >= SZ) return false;
      setVRaw(vx, vy, vz, blockId);
      markDirty(vx, vy, vz);
      if (window.ARiveMP && window.ARiveMP.connected && window.ARiveMP.onLocalBlockBatch) {
        window.ARiveMP.onLocalBlockBatch([[vx, vy, vz, blockId]]);
      }
      return true;
    },

    spawnStructurePresetAt: function (vx, vy, vz, preset) {
      switch (preset) {
        case "cube-wood": devSpawnBox(vx, vy, vz, 6, 6, 6, 6); return true;
        case "cube-concrete": devSpawnBox(vx, vy, vz, 6, 6, 6, 2); return true;
        case "cube-metal": devSpawnBox(vx, vy, vz, 6, 6, 6, 7); return true;
        case "cube-glass": devSpawnBox(vx, vy, vz, 6, 6, 6, 4); return true;
        case "wall": devSpawnWall(vx, vy, vz); return true;
        case "pillar": devSpawnPillar(vx, vy, vz); return true;
        case "house": devSpawnHouse(vx, vy, vz); return true;
        case "stairs": devSpawnStairs(vx, vy, vz); return true;
        case "barrel": devSpawnBox(vx, vy, vz, 3, 4, 3, 13); return true;
        case "rubble": devSpawnBox(vx, vy, vz, 6, 4, 6, 10); return true;
      }
      return false;
    },
    /* ---- end sandbox_menu hooks ---- */
  };
})();