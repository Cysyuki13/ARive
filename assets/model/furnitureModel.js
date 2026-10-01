/* =========================================================================
   ARive — furniture registry
   -------------------------------------------------------------------------
   Each entry is a full item definition (same shape as ITEM_DEFS in
   game.js).  On world generation the placement pass drops a handful of
   these into any structure that has floor space.
   ========================================================================= */
window.ARIVE_FURNITURE = window.ARIVE_FURNITURE || [];

ARIVE_FURNITURE.push({
    key: 'chair',
    name: 'CHAIR',
    w: 1, h: 1,
    color: '#7a5a2a',
    meta: {
        model: [
            { p: [0, 0.45, 0.0], s: [0.44, 0.06, 0.44], c: 0x6a4824 },
            { p: [0, 0.70, -0.20], s: [0.44, 0.50, 0.05], c: 0x6a4824 },
            { p: [-0.18, 0.20, 0.18], s: [0.05, 0.40, 0.05], c: 0x5a3a18 },
            { p: [0.18, 0.20, 0.18], s: [0.05, 0.40, 0.05], c: 0x5a3a18 },
            { p: [-0.18, 0.20, -0.18], s: [0.05, 0.40, 0.05], c: 0x5a3a18 },
            { p: [0.18, 0.20, -0.18], s: [0.05, 0.40, 0.05], c: 0x5a3a18 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'table',
    name: 'TABLE',
    w: 2, h: 2,
    color: '#7a5a2a',
    meta: {
        model: [
            { p: [0, 0.72, 0], s: [1.20, 0.06, 0.80], c: 0x6a4824 },
            { p: [-0.54, 0.36, -0.34], s: [0.06, 0.72, 0.06], c: 0x5a3a18 },
            { p: [0.54, 0.36, -0.34], s: [0.06, 0.72, 0.06], c: 0x5a3a18 },
            { p: [-0.54, 0.36, 0.34], s: [0.06, 0.72, 0.06], c: 0x5a3a18 },
            { p: [0.54, 0.36, 0.34], s: [0.06, 0.72, 0.06], c: 0x5a3a18 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'lamp',
    name: 'LAMP',
    w: 1, h: 2,
    color: '#4a4a4a',
    meta: {
        model: [
            { p: [0, 0.02, 0], s: [0.24, 0.04, 0.24], c: 0x2a2a2a },
            { p: [0, 0.55, 0], s: [0.05, 1.10, 0.05], c: 0x606060 },
            { p: [0, 1.18, 0], s: [0.34, 0.24, 0.34], c: 0xffd070, e: 0xffb040 }
        ]
    }
});