/* =========================================================================
   ARive — Authentication UI
   Wires the Google sign-in button in the main menu to window.ARiveAuth.
   ========================================================================= */
(function (global) {
    "use strict";

    const Auth = global.ARiveAuth;
    if (!Auth) {
        console.error("[AuthUI] ARiveAuth missing — load auth.js before authUI.js");
        return;
    }

    let boxEl, guestEl, userEl;
    let signInBtn, signOutBtn;
    let avatarEl, nameEl, emailEl;
    let ready = false;

    const listeners = [];
    function notify(profile) {
        for (const cb of listeners) {
            try { cb(profile); }
            catch (e) { console.warn("[AuthUI] listener error:", e); }
        }
    }

    function render(profile) {
        if (!ready) return;
        const signedIn = !!profile && !profile.isAnonymous;

        guestEl.style.display = signedIn ? "none" : "flex";
        userEl.style.display = signedIn ? "flex" : "none";
        boxEl.style.borderColor = signedIn ? "#e8c86a" : "#2b333f";

        if (signedIn) {
            avatarEl.src = profile.photoURL || "";
            avatarEl.alt = profile.displayName || "";
            nameEl.textContent = profile.displayName || "Survivor";
            emailEl.textContent = profile.email || "";
        }
        notify(profile);
    }

    async function handleSignIn() {
        signInBtn.disabled = true;
        signInBtn.textContent = "CONNECTING…";
        try {
            await Auth.signIn();
        } catch (e) {
            console.warn("[AuthUI] sign-in failed:", e && (e.code || e.message));
        } finally {
            signInBtn.disabled = false;
            signInBtn.textContent = "🔓 SIGN IN WITH GOOGLE";
        }
    }

    async function handleSignOut() {
        if (!confirm("Sign out of your Google account?")) return;
        signOutBtn.disabled = true;
        try {
            await Auth.signOut();
        } catch (e) {
            console.warn("[AuthUI] sign-out failed:", e);
        } finally {
            signOutBtn.disabled = false;
        }
    }

    function init() {
        boxEl = document.getElementById("authBox");
        guestEl = document.getElementById("authGuest");
        userEl = document.getElementById("authUser");
        signInBtn = document.getElementById("authSignInBtn");
        signOutBtn = document.getElementById("authSignOutBtn");
        avatarEl = document.getElementById("authAvatar");
        nameEl = document.getElementById("authName");
        emailEl = document.getElementById("authEmail");

        if (!boxEl || !signInBtn || !signOutBtn) {
            console.warn("[AuthUI] required DOM elements missing — skipping");
            return;
        }

        ready = true;
        signInBtn.addEventListener("click", handleSignIn);
        signOutBtn.addEventListener("click", handleSignOut);

        Auth.onAuth(render);
        Auth.waitForReady().then(render);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    global.ARiveAuthUI = {
        getDisplayName: () => Auth.getDisplayName(),
        isSignedIn: () => Auth.isSignedIn(),
        onChange: (cb) => { if (typeof cb === "function") listeners.push(cb); },
    };

})(window);