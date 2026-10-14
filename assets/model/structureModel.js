/* =========================================================================
   ARive — structure registry
   -------------------------------------------------------------------------
   Every entry placed here gets randomly stamped into a city block when
   the world is generated.  Add entries by:
     1. Designing a structure in structure-editor.html
     2. Clicking "COPY GAME SNIPPET"
     3. Pasting the result at the bottom of this file
   ========================================================================= */
window.ARIVE_STRUCTURES = window.ARIVE_STRUCTURES || [];

/* ---------- example: a small two-storey ruin ---------- */
ARIVE_STRUCTURES.push({
    name: "Small Ruin",
    size: [22, 18, 22],
    blocks: (function () {
        const b = [];
        // floor
        for (let x = 0; x < 22; x++) for (let z = 0; z < 22; z++) b.push([x, 0, z, 2]);
        // four walls, 12 voxels tall, with a door gap
        for (let y = 1; y < 13; y++) {
            for (let x = 0; x < 22; x++) { b.push([x, y, 0, 3]); b.push([x, y, 21, 3]); }
            for (let z = 0; z < 22; z++) { b.push([0, y, z, 3]); b.push([21, y, z, 3]); }
        }
        // carve a doorway (front wall)
        for (let y = 1; y < 5; y++) for (let x = 9; x < 13; x++) b.push([x, y, 0, 0]);
        // windows along the sides
        for (let y = 6; y < 9; y++) for (let z = 5; z < 9; z++) { b.push([0, y, z, 4]); b.push([21, y, z, 4]); }
        // roof
        for (let x = 0; x < 22; x++) for (let z = 0; z < 22; z++) b.push([x, 13, z, 6]);
        // rubble on top (so it reads as "ruined")
        for (let i = 0; i < 40; i++) {
            const x = 2 + ((Math.random() * 18) | 0);
            const z = 2 + ((Math.random() * 18) | 0);
            b.push([x, 14, z, 10]);
        }
        return b.filter(v => v[3] !== 0); // drop the door-carve entries
    })()
});

/* --- Add more structures below with the editor's "COPY GAME SNIPPET" --- */