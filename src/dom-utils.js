// True when the user is typing in a control-panel field, so game hotkeys and
// orb arrow movement should stand down.
export function isTypingInPanel() {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('.cp') &&
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName));
}
