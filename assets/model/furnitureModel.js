/* =========================================================================
   ARive — furniture registry (v2)
   -------------------------------------------------------------------------
   Every entry mirrors an ITEM_DEFS entry, plus a `size` tag:
       'small'  → chair, stool, lamp, crate
       'medium' → table, chest, nightstand
       'large'  → bookshelf, bed, cabinet

   game.js merges this array into ITEM_DEFS at boot, so each furniture
   automatically gets an icon, an inventory slot, world-drop physics, and
   pickup behaviour.

   In the STRUCTURE EDITOR, furniture is NOT placed directly — you drop a
   "furniture box" of a given size.  On world generation, one random
   furniture whose `size` matches the box is spawned at that spot.
   ========================================================================= */
window.ARIVE_FURNITURE = window.ARIVE_FURNITURE || [];

/* ------------------------------------------------------------------ SMALL */
ARIVE_FURNITURE.push({
    key: 'chair', name: 'CHAIR', size: 'small',
    w: 1, h: 1, color: '#7a5a2a',
    meta: {
        mass: 3.0,
        model: [
            { p: [0, 0.44, 0.00], s: [0.44, 0.06, 0.44], c: 0x6a4824 },
            { p: [0, 0.68, -0.19], s: [0.44, 0.48, 0.06], c: 0x6a4824 },
            { p: [-0.18, 0.22, 0.18], s: [0.05, 0.42, 0.05], c: 0x5a3a18 },
            { p: [0.18, 0.22, 0.18], s: [0.05, 0.42, 0.05], c: 0x5a3a18 },
            { p: [-0.18, 0.22, -0.18], s: [0.05, 0.42, 0.05], c: 0x5a3a18 },
            { p: [0.18, 0.22, -0.18], s: [0.05, 0.42, 0.05], c: 0x5a3a18 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'stool', name: 'STOOL', size: 'small',
    w: 1, h: 1, color: '#6a4824',
    meta: {
        mass: 2.0,
        model: [
            { p: [0, 0.42, 0], s: [0.36, 0.06, 0.36], c: 0x6a4824 },
            { p: [-0.13, 0.21, 0.13], s: [0.05, 0.42, 0.05], c: 0x5a3a18 },
            { p: [0.13, 0.21, 0.13], s: [0.05, 0.42, 0.05], c: 0x5a3a18 },
            { p: [-0.13, 0.21, -0.13], s: [0.05, 0.42, 0.05], c: 0x5a3a18 },
            { p: [0.13, 0.21, -0.13], s: [0.05, 0.42, 0.05], c: 0x5a3a18 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'lamp', name: 'LAMP', size: 'small',
    w: 1, h: 2, color: '#4a4a4a',
    meta: {
        mass: 1.5,
        model: [
            { p: [0, 0.02, 0], s: [0.24, 0.04, 0.24], c: 0x2a2a2a },
            { p: [0, 0.55, 0], s: [0.05, 1.10, 0.05], c: 0x606060 },
            { p: [0, 1.18, 0], s: [0.34, 0.24, 0.34], c: 0xffd070, e: 0xffb040 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'crate', name: 'CRATE', size: 'small',
    w: 1, h: 1, color: '#7a5a2a',
    meta: {
        mass: 4.0,
        model: [
            { p: [0, 0.24, 0], s: [0.48, 0.48, 0.48], c: 0x6a4824 },
            { p: [0, 0.24, 0.245], s: [0.48, 0.06, 0.02], c: 0x3a2418 },
            { p: [0, 0.24, -0.245], s: [0.48, 0.06, 0.02], c: 0x3a2418 }
        ]
    }
});

/* ----------------------------------------------------------------- MEDIUM */
ARIVE_FURNITURE.push({
    key: 'table', name: 'TABLE', size: 'medium',
    w: 2, h: 2, color: '#7a5a2a',
    meta: {
        mass: 8.0,
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
    key: 'chest', name: 'CHEST', size: 'medium',
    w: 2, h: 2, color: '#5a3a18',
    meta: {
        mass: 6.0,
        model: [
            { p: [0, 0.30, 0], s: [0.80, 0.60, 0.50], c: 0x5a3a18 },
            { p: [0, 0.62, 0], s: [0.80, 0.05, 0.50], c: 0x3a2418 },
            { p: [0, 0.30, 0.255], s: [0.10, 0.10, 0.02], c: 0xb0a040 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'nightstand', name: 'NIGHTSTAND', size: 'medium',
    w: 1, h: 2, color: '#6a4824',
    meta: {
        mass: 5.0,
        model: [
            { p: [0, 0.28, 0], s: [0.50, 0.56, 0.40], c: 0x6a4824 },
            { p: [0, 0.36, 0.21], s: [0.42, 0.18, 0.02], c: 0x3a2418 },
            { p: [0, 0.14, 0.21], s: [0.42, 0.18, 0.02], c: 0x3a2418 }
        ]
    }
});

/* ------------------------------------------------------------------ LARGE */
ARIVE_FURNITURE.push({
    key: 'bookshelf', name: 'BOOKSHELF', size: 'large',
    w: 2, h: 3, color: '#5a3a18',
    meta: {
        mass: 15.0,
        model: [
            { p: [0, 0.90, 0.00], s: [0.90, 1.80, 0.30], c: 0x5a3a18 },
            { p: [0, 0.90, -0.16], s: [0.86, 1.70, 0.02], c: 0x2a1a08 },
            { p: [0, 1.50, -0.14], s: [0.86, 0.04, 0.22], c: 0x3a2418 },
            { p: [0, 1.05, -0.14], s: [0.86, 0.04, 0.22], c: 0x3a2418 },
            { p: [0, 0.60, -0.14], s: [0.86, 0.04, 0.22], c: 0x3a2418 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'bed', name: 'BED', size: 'large',
    w: 2, h: 3, color: '#3a4a60',
    meta: {
        mass: 18.0,
        model: [
            { p: [0, 0.20, 0.00], s: [1.20, 0.40, 2.10], c: 0x3a2418 },
            { p: [0, 0.42, 0.00], s: [1.15, 0.10, 2.00], c: 0x5060a0 },
            { p: [0, 0.48, -0.85], s: [1.00, 0.14, 0.35], c: 0xd0d0c8 },
            { p: [0, 0.62, -1.05], s: [1.20, 0.60, 0.08], c: 0x3a2418 }
        ]
    }
});

ARIVE_FURNITURE.push({
    key: 'cabinet', name: 'CABINET', size: 'large',
    w: 2, h: 3, color: '#5a5a5a',
    meta: {
        mass: 20.0,
        model: [
            { p: [0, 0.90, 0.00], s: [1.00, 1.80, 0.40], c: 0x808890 },
            { p: [-0.22, 0.90, 0.21], s: [0.44, 1.70, 0.02], c: 0x606870 },
            { p: [0.22, 0.90, 0.21], s: [0.44, 1.70, 0.02], c: 0x606870 },
            { p: [-0.06, 0.90, 0.23], s: [0.04, 0.20, 0.03], c: 0xb0a040 },
            { p: [0.06, 0.90, 0.23], s: [0.04, 0.20, 0.03], c: 0xb0a040 }
        ]
    }
});