/* =========================================================================
   ARive — Google Authentication (Firebase)
   -------------------------------------------------------------------------
   Self-contained Firebase Google sign-in module.  Loaded as a plain
   <script> BEFORE authUI.js so other modules can query the signed-in user.

   Exposes window.ARiveAuth with:
       init()                  — boot the SDK (called automatically)
       signIn()                — open the Google popup
       signOut()               — sign out
       isSignedIn()            — boolean
       getUser()               — { uid, displayName, email, photoURL } | null
       getDisplayName()        — display name, or "Survivor" if guest
       onAuth(callback)        — register a listener for sign-in/out events
       waitForReady()          — promise that resolves once auth state known
       isConfigured()          — true once a real Firebase config is pasted

   If the config below is left as placeholders the module degrades to
   "guest mode": no SDK is downloaded, no errors are thrown, every call
   still works and getDisplayName() returns "Survivor".
   ========================================================================= */
(function (global) {
    "use strict";

    // auth.js - Replace the hardcoded config block with this:
    const firebaseConfig = global.ARiveFirebaseConfig || {};

    /* ---------------------------------------------------------------------
       2. SDK source (loaded on demand — no <script> tags needed in HTML)
       --------------------------------------------------------------------- */
    const SDK_VERSION = "10.12.2";
    const SDK_BASE = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";
    const APP_SRC = SDK_BASE + "firebase-app-compat.js";
    const AUTH_SRC = SDK_BASE + "firebase-auth-compat.js";

    /* ---------------------------------------------------------------------
       3. Internal state
       --------------------------------------------------------------------- */
    const PLACEHOLDER = /^(YOUR_|PASTE_)/;

    let auth = null;              // firebase.auth() instance, or null in guest mode
    let profile = null;           // { uid, displayName, email, photoURL } | null
    let ready = false;            // auth state has been determined at least once
    let started = false;          // init() has been kicked off
    let listeners = [];           // onAuth subscribers

    let resolveReady;
    const readyPromise = new Promise(function (res) { resolveReady = res; });

    /* ---------------------------------------------------------------------
       4. Helpers
       --------------------------------------------------------------------- */
    function isConfigured() {
        const values = Object.keys(firebaseConfig).map(function (k) { return firebaseConfig[k]; });
        if (!values.length) return false;
        return values.every(function (v) {
            return typeof v === "string" && v.length > 0 && !PLACEHOLDER.test(v);
        });
    }

    function toProfile(user) {
        if (!user) return null;
        return {
            uid: user.uid,
            displayName: user.displayName || "Survivor",
            email: user.email || "",
            photoURL: user.photoURL || "",
            isAnonymous: !!user.isAnonymous,
        };
    }

    function publish(next) {
        profile = next;
        // copy so a listener that unsubscribes mid-loop can't break iteration
        const snapshot = listeners.slice();
        for (let i = 0; i < snapshot.length; i++) {
            try {
                snapshot[i](profile);
            } catch (e) {
                console.warn("[Auth] listener error:", e);
            }
        }
    }

    function settle() {
        if (ready) return;
        ready = true;
        resolveReady(profile);
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            const existing = document.querySelector('script[src="' + src + '"]');
            if (existing && existing.dataset.ariveLoaded === "1") return resolve();

            const el = existing || document.createElement("script");
            el.src = src;
            el.async = false; // keep app-compat before auth-compat ordering
            el.addEventListener("load", function () {
                el.dataset.ariveLoaded = "1";
                resolve();
            });
            el.addEventListener("error", function () {
                reject(new Error("Failed to load " + src));
            });
            if (!existing) document.head.appendChild(el);
        });
    }

    /* ---------------------------------------------------------------------
       5. Boot
       --------------------------------------------------------------------- */
    async function init() {
        if (started) return readyPromise;
        started = true;

        if (!isConfigured()) {
            console.warn(
                "[Auth] Firebase config is still a placeholder — running in guest mode.\n" +
                "        Open auth.js and paste your Firebase web config to enable Google sign-in."
            );
            settle();
            return readyPromise;
        }

        try {
            await loadScript(APP_SRC);
            await loadScript(AUTH_SRC);

            if (!global.firebase || !global.firebase.auth) {
                throw new Error("Firebase SDK loaded but firebase.auth is unavailable");
            }

            if (!global.firebase.apps.length) {
                global.firebase.initializeApp(firebaseConfig);
            }

            auth = global.firebase.auth();
            if (typeof auth.useDeviceLanguage === "function") auth.useDeviceLanguage();

            // Keep the session across reloads (default is LOCAL, but be explicit).
            try {
                await auth.setPersistence(global.firebase.auth.Auth.Persistence.LOCAL);
            } catch (e) {
                console.warn("[Auth] persistence not set:", e && (e.code || e.message));
            }

            let anonAttempted = false;

            auth.onAuthStateChanged(async function (user) {
                // 没人登录时自动拿一个匿名身份，这样访客也能写 Firestore（房间心跳）
                if (!user && auth && !anonAttempted &&
                    typeof auth.signInAnonymously === "function") {
                    anonAttempted = true;
                    try {
                        await auth.signInAnonymously();
                        return; // 会再触发一次 onAuthStateChanged（这次 user 是匿名用户）
                    } catch (e) {
                        console.warn("[Auth] anonymous sign-in failed:", e && (e.code || e.message));
                    }
                }
                if (user && user.isAnonymous) anonAttempted = true;
                publish(toProfile(user));
                settle();
            });

            // Completes a sign-in that fell back to a full-page redirect.
            auth.getRedirectResult().catch(function (e) {
                const code = e && e.code;
                if (code && code !== "auth/no-auth-event") {
                    console.warn("[Auth] redirect result:", code);
                }
            });

            console.log("[Auth] Firebase initialised");
        } catch (e) {
            console.error("[Auth] init failed:", e);
            auth = null;
            settle(); // never leave waitForReady() hanging
        }

        return readyPromise;
    }

    /* ---------------------------------------------------------------------
       6. Public actions
       --------------------------------------------------------------------- */
    async function signIn() {
        await readyPromise;

        if (!auth) {
            throw new Error(
                isConfigured()
                    ? "auth/unavailable — Firebase failed to initialise (see console)"
                    : "auth/not-configured — paste your Firebase config into auth.js"
            );
        }

        const provider = new global.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });

        try {
            const cred = await auth.signInWithPopup(provider);
            return toProfile(cred && cred.user);
        } catch (err) {
            const code = (err && err.code) || "";
            const popupUnavailable =
                code === "auth/popup-blocked" ||
                code === "auth/operation-not-supported-in-this-environment";

            if (popupUnavailable) {
                console.warn("[Auth] popup unavailable (" + code + ") — using redirect instead");
                await auth.signInWithRedirect(provider);
                return null;
            }
            throw err;
        }
    }

    async function signOut() {
        await readyPromise;
        if (!auth) return; // guest mode: nothing to do
        await auth.signOut();
    }

    /* ---------------------------------------------------------------------
       7. Public API
       --------------------------------------------------------------------- */
    global.ARiveAuth = {
        init: init,

        signIn: signIn,
        signOut: signOut,

        isConfigured: isConfigured,
        isSignedIn: function () { return !!profile && !profile.isAnonymous; },
        isAuthenticated: function () { return !!profile; },   // 新增：Firebase 层是否已认证（含匿名）
        getUser: function () { return profile ? Object.assign({}, profile) : null; },
        getDisplayName: function () {
            return (profile && profile.displayName) || "Survivor";
        },

        /**
         * Register a listener for auth changes.
         * @param {(profile: object|null) => void} cb
         * @returns {() => void} unsubscribe
         */
        onAuth: function (cb) {
            if (typeof cb !== "function") return function () { };
            listeners.push(cb);
            if (ready) {
                try { cb(profile); } catch (e) { console.warn("[Auth] listener error:", e); }
            }
            return function () {
                listeners = listeners.filter(function (fn) { return fn !== cb; });
            };
        },

        waitForReady: function () { return readyPromise; }
    };

    /* ---------------------------------------------------------------------
       8. Auto-boot
       --------------------------------------------------------------------- */
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () { init(); });
    } else {
        init();
    }

    console.log("[Auth] module ready");
})(window);