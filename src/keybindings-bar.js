// Dynamic keyboard-shortcut hint bar (bottom-left `#help`).
//
// The old bar was a hand-maintained static list in index.html that showed keys
// irrelevant to the current state (e.g. WASD while Auto Follow drives the
// camera). This rebuilds the list from live state and only lists the shortcuts
// that actually apply — so it stays honest as the mode / camera changes.
//
// `update()` is cheap to call every frame: it diffs a small state signature and
// only rewrites the DOM when the relevant state changes.

const SEP = ' &nbsp;·&nbsp; ';

/**
 * @param {*} params - shared params (reads source.mode + camera.orbitOrb)
 * @returns {{ element: HTMLElement, update: () => void }}
 */
export function createKeybindingsBar(params) {
    let element = /** @type {HTMLElement | null} */ (document.getElementById('help'));
    if (!element) {
        element = document.createElement('div');
        element.id = 'help';
        document.body.appendChild(element);
    }

    let lastSig = '';

    const build = () => {
        const clickMode = params.source.mode === 'click';
        const autoFollow = !!params.camera.orbitOrb;

        // Line 1 — context-specific (movement + orb placement)
        const line1 = [];
        if (!autoFollow) {
            // manual camera is live only while Auto Follow is off
            line1.push('<b>WASD</b> move', '<b>L-drag</b> rotate', '<b>R-drag</b> pan', '<b>Scroll</b> zoom');
        }
        if (clickMode) {
            line1.push('<b>Arrows</b> move orb', '<b>Double-click</b> place orb');
        }

        // Line 2 — global shortcuts (+ anchor capture when it's usable)
        const line2 = ['<b>F</b> frame', '<b>O</b> auto-follow', '<b>H</b> save', '<b>P</b> panel', '<b>V</b> display'];
        if (!autoFollow) line2.push('<b>1-4</b> set camera pos');

        return [line1.join(SEP), line2.join(SEP)].filter(Boolean).join('<br>');
    };

    const update = () => {
        const sig = `${params.source.mode}|${params.camera.orbitOrb}`;
        if (sig === lastSig) return;
        lastSig = sig;
        element.innerHTML = build();
    };

    update();
    return { element, update };
}
