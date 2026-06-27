// Form elements that swallow keystrokes — used to stand down game hotkeys / orb
// movement while the user is editing a control, and to guard panel auto-refresh
// from yanking a value out from under an active edit.
export const FOCUSABLE = ['INPUT', 'SELECT', 'TEXTAREA'];

// True when the user is typing in a control-panel field, so game hotkeys and
// orb arrow movement should stand down.
export function isTypingInPanel() {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('.cp') && FOCUSABLE.includes(a.tagName));
}
