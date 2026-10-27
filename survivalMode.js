/* =========================================================================
   ARive — Survival Mode (wave defense)
   ========================================================================= */
(function () {
    'use strict';

    const H = window.ARiveHooks || {};
    const Hooks = H;

    const STATE = Object.freeze({
        IDLE: 'IDLE',
        PREP: 'PREP',
        WAVE: 'WAVE',
        BOSS: 'BOSS',
        VICTORY: 'VICTORY',
        DEFEAT: 'DEFEAT',
    });

    const PREP_SECONDS = 60;
    const WAVE_START_DELAY = 1.2;      // short grace as the wave spawner spins up
    const SPAWN_INTERVAL_BASE = 1.5;   // seconds between spawns, scales down
    const SPAWN_INTERVAL_MIN = 0.35;
    const MINI_BOSS_EVERY = 5;         // mini boss on every 5th wave

    const SurvivalMode = {
        state: STATE.IDLE,

        totalWaves: 10,
        currentWave: 0,                // 1-based once started

        prepRemaining: 0,
        waveRemaining: 0,              // enemies still alive + still queued
        waveTotal: 0,

        // internal
        _spawnQueue: [],
        _spawnTimer: 0,
        _startDelay: 0,
        _live: [],                     // references to spawned enemies (alive or dying)
        _bossAlive: null,              // boss ref for HP bar
        _hud: null,
        _bossBar: null,

        // hooks (overridable by game.js)
        onVictory: null,
        onDefeat: null,
        onStateChange: null,

        /* ------------------------------------------------------------------ */
        start(totalWaves) {
            this.stop(true);
            this.totalWaves = Math.max(1, totalWaves | 0);
            this.currentWave = 0;
            this.state = STATE.IDLE;
            this._ensureHud();
            this._enterPrep(3.0);           // 3s first-wave countdown — cheap and readable
            this._emitChange();
        },

        stop(silent) {
            this.state = STATE.IDLE;
            this._spawnQueue.length = 0;
            this._live.length = 0;
            this._bossAlive = null;
            this.waveRemaining = 0;
            this.waveTotal = 0;
            this.prepRemaining = 0;
            this._hideHud(silent);
            if (this._bossBar) this._bossBar.style.display = 'none';
        },

        skipPrep() {
            if (this.state !== STATE.PREP) return;
            this.prepRemaining = 0;
            this._beginNextWave();
        },

        /* ------------------------------------------------------------------ */
        update(dt) {
            if (this.state === STATE.IDLE ||
                this.state === STATE.VICTORY ||
                this.state === STATE.DEFEAT) {
                this._updateHud();
                return;
            }

            // scrub dead refs
            for (let i = this._live.length - 1; i >= 0; i--) {
                if (!this._live[i].alive && !this._live[i].dying) this._live.splice(i, 1);
            }

            if (this.state === STATE.PREP) {
                this.prepRemaining -= dt;
                if (this.prepRemaining <= 0) {
                    this.prepRemaining = 0;
                    this._beginNextWave();
                }
            } else if (this.state === STATE.WAVE || this.state === STATE.BOSS) {
                this._tickWave(dt);
            }

            this._tickBosses(dt);
            this._updateHud();
            this._updateBossBar();
        },

        /* ------------------------------------------------------------------ */
        onEnemyKilled(e) {
            if (this.state !== STATE.WAVE && this.state !== STATE.BOSS) return;
            this.waveRemaining = Math.max(0, this.waveRemaining - 1);
            if (this._bossAlive === e) this._bossAlive = null;
            if (this._spawnQueue.length === 0 && this.waveRemaining === 0) {
                this._completeWave();
            }
        },

        onPlayerDied() {
            if (this.state === STATE.VICTORY || this.state === STATE.DEFEAT) return;
            this.state = STATE.DEFEAT;
            if (this.onDefeat) this.onDefeat();
            this._emitChange();
            this._hideHud();
        },

        /* ------------------------------------------------------------------ */
        /* DEBUG / FORCED-SKIP helpers — callable from the browser console   */
        /*                                                                    */
        /*   SurvivalMode.jumpToWave(5)      // straight to wave 5            */
        /*   SurvivalMode.skipToMiniBoss()   // wave 5 (THE BUTCHER)          */
        /*   SurvivalMode.skipToFinalBoss()  // last wave (THE WARDEN)        */
        /*                                                                    */
        /* The game must be running (survival mode active) before calling.    */
        /* ------------------------------------------------------------------ */
        jumpToWave(waveNum) {
            const target = Math.max(
                1,
                Math.min(this.totalWaves, (waveNum | 0) || 1),
            );

            // If the run hasn't started (or already ended), kick off a fresh run
            // so the wave machinery has valid state to jump into.
            if (this.state === STATE.IDLE ||
                this.state === STATE.VICTORY ||
                this.state === STATE.DEFEAT) {
                this.start(this.totalWaves);
            }

            // Wipe the current wave — otherwise old enemies would decrement the
            // NEW wave's `waveRemaining` as they die, corrupting the counter.
            if (window.Enemies && window.Enemies.clear) {
                try { window.Enemies.clear(); } catch (e) { }
            }
            this._live.length = 0;
            this._spawnQueue.length = 0;
            this._bossAlive = null;
            this.prepRemaining = 0;

            // _beginNextWave() does `currentWave++` itself, so land on target-1.
            this.currentWave = target - 1;
            this._beginNextWave();

            console.log(
                '[SurvivalMode] JUMPED to wave ' + this.currentWave +
                ' / ' + this.totalWaves + '  ·  state ' + this.state,
            );
            return this.currentWave;
        },

        skipToMiniBoss() {
            // Mini-bosses spawn on waves divisible by MINI_BOSS_EVERY (5).
            // If totalWaves <= 5 the "mini boss" slot is the final boss —
            // _beginNextWave() handles that via its `!isFinal` guard.
            return this.jumpToWave(MINI_BOSS_EVERY);
        },

        skipToFinalBoss() {
            return this.jumpToWave(this.totalWaves);
        },

        /* ------------------------------------------------------------------ */
        _enterPrep(secondsOverride) {
            this.state = STATE.PREP;
            this.prepRemaining = secondsOverride != null
                ? secondsOverride
                : PREP_SECONDS;
            this.waveRemaining = 0;
            this.waveTotal = 0;
            this._emitChange();
        },

        _beginNextWave() {
            this.currentWave++;
            this._startDelay = WAVE_START_DELAY;

            const isFinal = this.currentWave === this.totalWaves;
            const isMiniBoss = !isFinal && this.currentWave % MINI_BOSS_EVERY === 0;

            if (isFinal) {
                this.state = STATE.BOSS;
                this._prepareFinalBossWave();
            } else if (isMiniBoss) {
                this.state = STATE.BOSS;
                this._prepareMiniBossWave();
            } else {
                this.state = STATE.WAVE;
                this._prepareNormalWave();
            }

            this.waveTotal = this._spawnQueue.length;
            this.waveRemaining = this.waveTotal;
            this._emitChange();
        },

        _prepareNormalWave() {
            const n = Math.floor(4 + this.currentWave * 1.5);
            for (let i = 0; i < n; i++) {
                this._spawnQueue.push({
                    type: this._pickType(this.currentWave),
                });
            }
            this._spawnTimer = 0.4;
        },

        _prepareMiniBossWave() {
            const escort = Math.floor(2 + this.currentWave * 0.4);
            this._spawnQueue.push({ type: '__mini_boss__' });
            for (let i = 0; i < escort; i++) {
                this._spawnQueue.push({ type: this._pickType(this.currentWave) });
            }
            this._spawnTimer = 0.6;
        },

        _prepareFinalBossWave() {
            this._spawnQueue.push({ type: '__final_boss__' });
            const adds = 4;
            for (let i = 0; i < adds; i++) {
                this._spawnQueue.push({ type: this._pickType(this.currentWave) });
            }
            this._spawnTimer = 1.2;
        },

        _tickWave(dt) {
            if (this._startDelay > 0) {
                this._startDelay -= dt;
                return;
            }
            this._spawnTimer -= dt;

            const waveProgress = 1 - (this._spawnQueue.length / Math.max(1, this.waveTotal));
            const interval = Math.max(
                SPAWN_INTERVAL_MIN,
                SPAWN_INTERVAL_BASE - waveProgress * 1.1,
            );

            while (this._spawnTimer <= 0 && this._spawnQueue.length > 0) {
                this._spawnNext();
                this._spawnTimer += interval;
            }
        },

        _spawnNext() {
            const entry = this._spawnQueue.shift();
            if (!entry) return;

            const p = Hooks.player ? Hooks.player.pos : { x: 0, y: 4, z: 0 };
            const angle = Math.random() * Math.PI * 2;
            const dist = 12 + Math.random() * 8;
            const wx = clamp(p.x + Math.cos(angle) * dist, 1, (Hooks.WORLD_W || 200) - 1);
            const wz = clamp(p.z + Math.sin(angle) * dist, 1, (Hooks.WORLD_D || 200) - 1);
            const wy = (Hooks.getGroundYAtVoxel && Hooks.getGroundYAtVoxel(
                Math.floor(wx / Hooks.VOXEL),
                Math.floor(wz / Hooks.VOXEL),
            )) || 4;

            let spawned = null;
            if (entry.type === '__mini_boss__') {
                spawned = window.Enemies.spawn('__mini_boss__', { x: wx, y: wy, z: wz });
                if (spawned) {
                    spawned.isBoss = true;
                    spawned.bossTier = 'mini';
                    spawned.bossName = 'THE BUTCHER';
                    spawned.summonCooldown = 8;
                    this._bossAlive = spawned;
                }
            } else if (entry.type === '__final_boss__') {
                spawned = window.Enemies.spawn('__final_boss__', { x: wx, y: wy, z: wz });
                if (spawned) {
                    spawned.isBoss = true;
                    spawned.bossTier = 'final';
                    spawned.bossName = 'THE WARDEN';
                    spawned.summonCooldown = 12;
                    this._bossAlive = spawned;
                }
            } else {
                spawned = window.Enemies.spawn(entry.type, { x: wx, y: wy, z: wz });
            }

            if (spawned) this._live.push(spawned);
        },

        _completeWave() {
            if (this.currentWave >= this.totalWaves) {
                this.state = STATE.VICTORY;
                if (this.onVictory) this.onVictory();
                this._emitChange();
                this._hideHud();
                return;
            }
            this._enterPrep();
        },

        /* Boss extras ----------------------------------------------------- */
        _tickBosses(dt) {
            const enemies = Hooks.enemies || window.Enemies && window.Enemies.list || [];
            for (let i = 0; i < enemies.length; i++) {
                const e = enemies[i];
                if (!e || !e.isBoss || !e.alive) continue;
                if (e.summonCooldown == null) continue;
                e.summonCooldown -= dt;
                if (e.summonCooldown <= 0) {
                    e.summonCooldown = (e.bossTier === 'final' ? 10 : 7) + Math.random() * 3;
                    const count = e.bossTier === 'final' ? 3 : 2;
                    for (let k = 0; k < count; k++) {
                        const a = Math.random() * Math.PI * 2;
                        const r = 2.2;
                        const m = window.Enemies.spawn(
                            e.bossTier === 'final' ? 'runner' : 'walker',
                            { x: e.pos.x + Math.cos(a) * r, y: e.pos.y, z: e.pos.z + Math.sin(a) * r },
                        );
                        if (m) {
                            m.isBossSummon = true;
                            this.waveRemaining++;   // count summons toward wave progress too
                            this.waveTotal++;
                            this._live.push(m);
                        }
                    }
                }
            }
        },

        /* Enemy pool ------------------------------------------------------- */
        _pickType(wave) {
            const pool = [
                { type: 'walker', w: 40, min: 1 },
                { type: 'shuffler', w: 20, min: 1 },   // fallback to walker if undefined
                { type: 'runner', w: 20, min: 2 },
                { type: 'crawler', w: 15, min: 3 },
                { type: 'hatty', w: 14, min: 3 },
                { type: 'blondie', w: 14, min: 4 },
                { type: 'beanie', w: 12, min: 5 },
                { type: 'hooded', w: 12, min: 5 },
                { type: 'capboy', w: 12, min: 6 },
                { type: 'rotter', w: 14, min: 6 },
                { type: 'skull', w: 10, min: 7 },
                { type: 'vested', w: 10, min: 7 },
                { type: 'oldblood', w: 12, min: 8 },
                { type: 'demon', w: 8, min: 9 },
                { type: 'brute', w: 8, min: 9 },
                { type: 'imp', w: 8, min: 10 },
                { type: 'trilens', w: 8, min: 8 },
                { type: 'wisp', w: 8, min: 6 },
                { type: 'voidtwin', w: 8, min: 8 },
            ];
            const active = pool.filter((p) => wave >= p.min);
            let total = 0;
            for (const p of active) total += p.w;
            let r = Math.random() * total;
            for (const p of active) {
                r -= p.w;
                if (r <= 0) return p.type;
            }
            return 'walker';
        },

        /* HUD ------------------------------------------------------------- */
        _ensureHud() {
            if (this._hud) return;
            let hud = document.getElementById('waveHud');
            if (!hud) {
                hud = document.createElement('div');
                hud.id = 'waveHud';
                hud.innerHTML =
                    '<div class="wh-state" id="whState">PREP</div>' +
                    '<div class="wh-wave" id="whWave">WAVE 1 / 10</div>' +
                    '<div class="wh-bar"><div class="wh-fill" id="whFill"></div></div>' +
                    '<div class="wh-hint" id="whHint">PRESS P TO SKIP</div>';
                document.body.appendChild(hud);
            }
            this._hud = hud;

            let boss = document.getElementById('bossBar');
            if (!boss) {
                boss = document.createElement('div');
                boss.id = 'bossBar';
                boss.innerHTML =
                    '<div class="bb-name" id="bbName">BOSS</div>' +
                    '<div class="bb-bar"><div class="bb-fill" id="bbFill"></div></div>';
                document.body.appendChild(boss);
            }
            this._bossBar = boss;
        },

        _hideHud(silent) {
            if (this._hud) this._hud.style.display = 'none';
            if (this._bossBar) this._bossBar.style.display = 'none';
        },

        _updateHud() {
            if (!this._hud) return;
            const hud = this._hud;
            if (this.state === STATE.IDLE ||
                this.state === STATE.VICTORY ||
                this.state === STATE.DEFEAT) {
                hud.style.display = 'none';
                return;
            }
            hud.style.display = 'block';

            const stateEl = document.getElementById('whState');
            const waveEl = document.getElementById('whWave');
            const fillEl = document.getElementById('whFill');
            const hintEl = document.getElementById('whHint');

            if (this.state === STATE.PREP) {
                const secs = Math.ceil(this.prepRemaining);
                stateEl.textContent = 'PREPARE  ·  ' + secs + 's';
                waveEl.textContent = 'WAVE ' + (this.currentWave + 1) + ' / ' + this.totalWaves;
                fillEl.style.width = (100 - (this.prepRemaining / PREP_SECONDS) * 100).toFixed(1) + '%';
                hintEl.style.display = 'block';
            } else {
                stateEl.textContent = this.state === STATE.BOSS ? 'BOSS WAVE' : 'WAVE ' + this.currentWave;
                waveEl.textContent = (this.waveTotal - this.waveRemaining) + ' / ' + this.waveTotal;
                const pct = this.waveTotal > 0
                    ? ((this.waveTotal - this.waveRemaining) / this.waveTotal) * 100
                    : 0;
                fillEl.style.width = pct.toFixed(1) + '%';
                hintEl.style.display = 'none';
            }
        },

        _updateBossBar() {
            if (!this._bossBar) return;
            const e = this._bossAlive;
            if (!e || !e.alive) { this._bossBar.style.display = 'none'; return; }
            this._bossBar.style.display = 'block';
            document.getElementById('bbName').textContent = (e.bossName || 'BOSS');
            const pct = Math.max(0, e.hp / e.maxHp) * 100;
            document.getElementById('bbFill').style.width = pct.toFixed(1) + '%';
        },

        _emitChange() {
            if (this.onStateChange) {
                try { this.onStateChange(this.state, this); } catch (e) { /* ignore */ }
            }
        },
    };

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    window.SurvivalMode = SurvivalMode;

    /* Browser-console shortcuts — no need to type `SurvivalMode.xxx`. */
    window.skipToWave = function (n) { return SurvivalMode.jumpToWave(n); };
    window.skipToMiniBoss = function () { return SurvivalMode.skipToMiniBoss(); };
    window.skipToFinalBoss = function () { return SurvivalMode.skipToFinalBoss(); };

    console.log('[SurvivalMode] ready  ·  debug: skipToWave(n), skipToMiniBoss(), skipToFinalBoss()');
})();