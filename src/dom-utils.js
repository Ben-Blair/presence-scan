// Form elements that swallow keystrokes — used to stand down game hotkeys / orb
// movement while the user is editing a control, and to guard panel auto-refresh
// from yanking a value out from under an active edit.
export const FOCUSABLE = ['INPUT', 'SELECT', 'TEXTAREA'];

// Input types that don't consume typing or arrow keys, so focusing one (e.g. a
// toggle checkbox, which stays focused after a click) must NOT stand down game
// hotkeys or arrow-key orb/character movement. Text-entry and range inputs are
// deliberately absent — a focused slider legitimately owns the arrow keys.
const PASSIVE_INPUT_TYPES = ['checkbox', 'radio', 'button', 'submit', 'reset'];

// True when the user is typing in (or adjusting) a control-panel field, so game
// hotkeys and orb arrow movement should stand down.
export function isTypingInPanel() {
    const a = /** @type {HTMLInputElement | null} */ (document.activeElement);
    if (!a || !a.closest || !a.closest('.cp') || !FOCUSABLE.includes(a.tagName)) return false;
    // A focused toggle/checkbox doesn't own the keyboard — let movement continue.
    if (a.tagName === 'INPUT' && PASSIVE_INPUT_TYPES.includes(a.type)) return false;
    return true;
}
