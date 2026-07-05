// Lightweight, dependency-free control toolkit for the settings panel.
//
// Controls write straight through to the bound params object, register a
// "refresh" callback (to pull the current value back into the DOM when params
// change externally, e.g. reset / hotkey), and optionally a "poll" callback for
// live readouts. A control fires its `onChange` after mutating params.
//
// The panel is organised as an iOS-style page stack: a root page plus drill-in
// sub-pages that slide in horizontally with a shared header (back button +
// title). `addPage` registers a page and returns a row-factory scope;
// `addDrill` pushes onto the nav stack.

import { FOCUSABLE } from './dom-utils.js';

const hasFocus = (el) => document.activeElement === el && FOCUSABLE.includes(el.tagName);

function clampNum(v, min, max) {
    if (Number.isNaN(v)) return min;
    return Math.min(max, Math.max(min, v));
}

export function floatRgbToHex({ r, g, b }) {
    const h = (v) => Math.round(clampNum(v, 0, 1) * 255).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToFloatRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
}

function makeRow(parent, label, className) {
    const row = el('div', className ? `cp-row ${className}` : 'cp-row', parent);
    if (label != null) {
        const l = el('label', 'cp-row__label', row);
        l.textContent = label;
    }
    return row;
}

/**
 * Wire one or more DOM inputs to a params field: on `event`, run `onInput` (which
 * writes params from the DOM) then fire `onChange`; and register a focus-guarded
 * refresher that runs `read` (which pulls params back into the DOM) when none of
 * the inputs is being actively edited. Collapses the near-identical write-back +
 * refresher boilerplate every control used to repeat.
 *
 * @param {{refreshers: Array<() => void>}} ctx
 * @param {HTMLElement | HTMLElement[]} inputs
 * @param {{event: string, onInput: (el: any) => void, read: () => void, onChange?: () => void}} cfg
 */
function bindInput(ctx, inputs, { event, onInput, read, onChange }) {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    for (const input of list) {
        input.addEventListener(event, () => { onInput(input); onChange?.(); });
    }
    ctx.refreshers.push(() => {
        if (list.some(hasFocus)) return;
        read();
    });
}

// Returns a section/panel "scope" with row-factory methods that append to `body`.
// `nav` (optional) is the page-stack controller, needed by addPage/addDrill.
function makeScope(body, ctx, nav) {
    const scope = {
        body,

        addSection(opts) {
            return buildSection(body, ctx, opts);
        },

        // Register a sub-page and return its scope. Drilling into it is wired by
        // addDrill. `title` shows in the shared header while the page is on top.
        /** @param {{ id?: string, title?: string, root?: boolean }} [opts] */
        addPage(opts) {
            return nav.addPage(opts);
        },

        // A disclosure row (label + optional value + chevron) that pushes `page`.
        addDrill(opts = {}) {
            const { label, page, value } = opts;
            const rowBtn = el('button', 'cp-drill', body);
            rowBtn.type = 'button';
            el('span', 'cp-drill__label', rowBtn).textContent = label;
            if (value != null) {
                const val = el('span', 'cp-drill__value', rowBtn);
                if (typeof value === 'function') ctx.polls.push(() => { val.textContent = value(); });
                else val.textContent = value;
            }
            el('span', 'cp-drill__chevron', rowBtn).textContent = '›';
            rowBtn.addEventListener('click', () => nav.push(page.id));
            return scope;
        },

        addSlider(obj, key, opts = {}) {
            const { min = 0, max = 1, step = 0.01, label = key, format, onChange } = opts;
            const row = makeRow(body, label);
            const wrap = el('div', 'cp-slider', row);
            const range = el('input', 'cp-range', wrap);
            range.type = 'range';
            range.min = min; range.max = max; range.step = step;
            const num = el('input', 'cp-num', wrap);
            num.type = 'number';
            num.min = min; num.max = max; num.step = step;

            const fmtNum = (v) => (format ? format(v) : v);
            const sync = (val) => { range.value = String(val); num.value = fmtNum(val); };
            bindInput(ctx, [range, num], {
                event: 'input',
                onInput: (input) => {
                    const val = clampNum(parseFloat(input.value), min, max);
                    obj[key] = val;
                    sync(val);
                },
                read: () => sync(obj[key]),
                onChange
            });
            sync(obj[key]);
            return scope;
        },

        addColor(obj, key, opts = {}) {
            const { label = key, onChange } = opts;
            const row = makeRow(body, label);
            const input = el('input', 'cp-color', row);
            input.type = 'color';
            input.value = floatRgbToHex(obj[key]);
            bindInput(ctx, input, {
                event: 'input',
                onInput: () => {
                    const c = hexToFloatRgb(input.value);
                    obj[key].r = c.r; obj[key].g = c.g; obj[key].b = c.b;
                },
                read: () => { input.value = floatRgbToHex(obj[key]); },
                onChange
            });
            return scope;
        },

        addToggle(obj, key, opts = {}) {
            const { label = key, onChange } = opts;
            const row = makeRow(body, label, 'cp-row--toggle');
            const sw = el('label', 'cp-switch', row);
            const input = el('input', null, sw);
            input.type = 'checkbox';
            input.checked = !!obj[key];
            el('span', 'cp-switch__track', sw);
            bindInput(ctx, input, {
                event: 'change',
                onInput: () => { obj[key] = input.checked; },
                read: () => { input.checked = !!obj[key]; },
                onChange
            });
            return scope;
        },

        // A switch backed by get/set functions (rather than an obj[key]). Used
        // for controls whose target changes at runtime — e.g. a single toggle
        // that drives different params depending on the current mode. Returns a
        // handle so the caller can relabel / show-hide the row live.
        addToggleFn(opts = {}) {
            const { label = '', get, set, onChange } = opts;
            const row = makeRow(body, label, 'cp-row--toggle');
            const labelEl = row.querySelector('.cp-row__label');
            const sw = el('label', 'cp-switch', row);
            const input = el('input', null, sw);
            input.type = 'checkbox';
            input.checked = !!get();
            el('span', 'cp-switch__track', sw);
            bindInput(ctx, input, {
                event: 'change',
                onInput: () => { set(input.checked); },
                read: () => { input.checked = !!get(); },
                onChange
            });
            return {
                setLabel: (text) => { if (labelEl) labelEl.textContent = text; },
                setVisible: (v) => { row.style.display = v ? '' : 'none'; },
                // Re-read the switch state from get() — needed when the backing
                // target changes at runtime (e.g. the mode-aware under-hood toggle).
                sync: () => { if (!hasFocus(input)) input.checked = !!get(); }
            };
        },

        addSelect(obj, key, opts = {}) {
            const { label = key, options = {}, onChange } = opts;
            const row = makeRow(body, label);
            const sel = el('select', 'cp-select', row);
            for (const [name, val] of Object.entries(options)) {
                const o = el('option', null, sel);
                o.value = String(val);
                o.textContent = name;
            }
            sel.value = String(obj[key]);
            bindInput(ctx, sel, {
                event: 'change',
                onInput: () => { obj[key] = sel.value; },
                read: () => { sel.value = String(obj[key]); },
                onChange
            });
            return scope;
        },

        // Segmented (pill) control — one button per option, active one filled.
        // Writes obj[key] like addSelect but reads as a set of primary choices.
        addSegmented(obj, key, opts = {}) {
            const { options = {}, onChange } = opts;
            const seg = el('div', 'cp-seg', body);
            /** @type {Array<{ el: HTMLButtonElement, val: string }>} */
            const buttons = [];
            const paint = () => {
                const cur = String(obj[key]);
                for (const b of buttons) b.el.classList.toggle('cp-seg__btn--on', b.val === cur);
            };
            for (const [name, val] of Object.entries(options)) {
                const btn = el('button', 'cp-seg__btn', seg);
                btn.type = 'button';
                btn.textContent = name;
                const sval = String(val);
                btn.addEventListener('click', () => {
                    obj[key] = sval;
                    paint();
                    onChange?.();
                });
                buttons.push({ el: btn, val: sval });
            }
            paint();
            ctx.refreshers.push(paint);
            return scope;
        },

        addText(obj, key, opts = {}) {
            const { label = key, onChange } = opts;
            const row = makeRow(body, label);
            const input = el('input', 'cp-text', row);
            input.type = 'text';
            input.value = obj[key];
            bindInput(ctx, input, {
                event: 'change',
                onInput: () => { obj[key] = input.value; },
                read: () => { input.value = obj[key]; },
                onChange
            });
            return scope;
        },

        addButton(opts = {}) {
            const { title, onClick } = opts;
            const btn = el('button', 'cp-btn', body);
            btn.type = 'button';
            btn.textContent = title;
            if (onClick) btn.addEventListener('click', onClick);
            return scope;
        },

        // A horizontal group of equal-width buttons (e.g. Save / Reset).
        addButtonRow(buttons = []) {
            const rowEl = el('div', 'cp-btnrow', body);
            for (const { title, onClick } of buttons) {
                const btn = el('button', 'cp-btn', rowEl);
                btn.type = 'button';
                btn.textContent = title;
                if (onClick) btn.addEventListener('click', onClick);
            }
            return scope;
        },

        addReadout(opts = {}) {
            const { label, get } = opts;
            const row = makeRow(body, label);
            const span = el('span', 'cp-readout', row);
            const update = () => { span.textContent = get(); };
            ctx.polls.push(update);
            update();
            return scope;
        }
    };
    return scope;
}

/**
 * @param {HTMLElement} parent
 * @param {{ refreshers: Array<() => void>, polls: Array<() => void> }} ctx
 * @param {{ title?: string, expanded?: boolean }} [opts]
 */
function buildSection(parent, ctx, { title, expanded = true } = {}) {
    const section = el('section', 'cp-sec', parent);
    if (!expanded) section.classList.add('cp-sec--collapsed');

    const head = el('button', 'cp-sec__head', section);
    head.type = 'button';
    el('span', 'cp-sec__chevron', head).textContent = '▸'; // ▸
    el('span', 'cp-sec__title', head).textContent = title;
    head.addEventListener('click', () => {
        section.classList.toggle('cp-sec--collapsed');
        // let the page-stack re-measure so expanded content isn't stuck behind a scrollbar
        window.dispatchEvent(new Event('resize'));
    });

    const secBody = el('div', 'cp-sec__body', section);
    return makeScope(secBody, ctx);
}

/**
 * The page-stack navigation controller. Owns the pages container, a stack of
 * page ids, and updates the shared header (back button + title) as pages are
 * pushed/popped. Pages slide horizontally via CSS state classes.
 *
 * @param {HTMLElement} pagesEl
 * @param {HTMLElement} backBtn
 * @param {HTMLElement} titleEl
 * @param {{ refreshers: Array<() => void>, polls: Array<() => void> }} ctx
 */
function makeNav(pagesEl, backBtn, titleEl, ctx) {
    /** @type {Map<string, { el: HTMLElement, title: string }>} */
    const pages = new Map();
    /** @type {string[]} */
    const stack = [];
    let counter = 0;

    // Pages are absolutely positioned (so they can slide over each other), which
    // means they contribute no height to the container. Size the container to the
    // active page's content instead — clamped to the space left below the header —
    // so the card grows/shrinks per page and tall pages scroll.
    const sizeToActive = () => {
        const top = pages.get(stack[stack.length - 1]);
        if (!top) return;
        const avail = window.innerHeight - 12 - pagesEl.getBoundingClientRect().top;
        pagesEl.style.height = `${Math.min(top.el.scrollHeight, Math.max(avail, 80))}px`;
    };

    const paint = () => {
        const topId = stack[stack.length - 1];
        pages.forEach((p, id) => {
            const depth = stack.indexOf(id);
            p.el.classList.remove('cp-page--active', 'cp-page--behind', 'cp-page--ahead');
            if (id === topId) p.el.classList.add('cp-page--active');
            else if (depth >= 0) p.el.classList.add('cp-page--behind'); // parent in stack
            else p.el.classList.add('cp-page--ahead'); // not visited
        });
        const top = pages.get(topId);
        titleEl.textContent = top ? top.title : '';
        backBtn.classList.toggle('cp__back--show', stack.length > 1);
        requestAnimationFrame(sizeToActive);
    };

    window.addEventListener('resize', sizeToActive);

    const nav = {
        /** @param {{ id?: string, title?: string, root?: boolean }} [opts] */
        addPage({ id, title = '', root = false } = {}) {
            const pid = id || `page-${counter++}`;
            const pageEl = el('div', 'cp-page', pagesEl);
            pages.set(pid, { el: pageEl, title });
            if (root) stack.push(pid);
            paint();
            const scope = makeScope(pageEl, ctx, nav);
            // expose the resolved id so addDrill can target this page directly
            return Object.assign(scope, { id: pid });
        },
        push(id) {
            if (!pages.has(id) || stack[stack.length - 1] === id) return;
            stack.push(id);
            paint();
        },
        back() {
            if (stack.length > 1) { stack.pop(); paint(); }
        },
        // Return to the root page (used on hide/reset so reopening starts clean).
        reset() {
            if (stack.length > 1) { stack.length = 1; paint(); }
        }
    };
    return nav;
}

/** @param {{ title?: string, onHide?: () => void }} [opts] */
export function createPanel({ title, onHide } = {}) {
    /** @type {{ refreshers: Array<() => void>, polls: Array<() => void> }} */
    const ctx = { refreshers: [], polls: [] };

    const element = el('aside', 'cp');
    const header = el('header', 'cp__header', element);

    const backBtn = el('button', 'cp__back', header);
    backBtn.type = 'button';
    backBtn.title = 'Back';
    backBtn.textContent = '‹';

    const titleEl = el('span', 'cp__title', header);
    titleEl.textContent = title;

    const hideBtn = el('button', 'cp__hide', header);
    hideBtn.type = 'button';
    hideBtn.title = 'Hide controls (P)';
    hideBtn.textContent = '×'; // ×
    if (onHide) hideBtn.addEventListener('click', onHide);

    const pagesEl = el('div', 'cp__pages', element);
    const nav = makeNav(pagesEl, backBtn, titleEl, ctx);
    backBtn.addEventListener('click', () => nav.back());

    return {
        element,
        addPage: nav.addPage,
        showRoot: () => nav.reset(),
        refresh() {
            ctx.refreshers.forEach((fn) => fn());
            ctx.polls.forEach((fn) => fn());
        },
        poll() {
            ctx.polls.forEach((fn) => fn());
        }
    };
}
