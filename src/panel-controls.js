// Lightweight, dependency-free control toolkit for the settings panel.
//
// Each control writes straight through to the bound params object, registers a
// "refresh" callback (to pull the current value back into the DOM when params
// change externally, e.g. reset / hotkey), and optionally a "poll" callback for
// live readouts. A control fires its `onChange` after mutating params.

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

function makeRow(parent, label) {
    const row = el('div', 'cp-row', parent);
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
function makeScope(body, ctx) {
    const scope = {
        body,

        addSection(opts) {
            return buildSection(body, ctx, opts);
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
            const row = makeRow(body, label);
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
    head.addEventListener('click', () => section.classList.toggle('cp-sec--collapsed'));

    const secBody = el('div', 'cp-sec__body', section);
    return makeScope(secBody, ctx);
}

/** @param {{ title?: string, onHide?: () => void }} [opts] */
export function createPanel({ title, onHide } = {}) {
    /** @type {{ refreshers: Array<() => void>, polls: Array<() => void> }} */
    const ctx = { refreshers: [], polls: [] };

    const element = el('aside', 'cp');
    const header = el('header', 'cp__header', element);
    el('span', 'cp__title', header).textContent = title;
    const hideBtn = el('button', 'cp__hide', header);
    hideBtn.type = 'button';
    hideBtn.title = 'Hide controls (P)';
    hideBtn.textContent = '×'; // ×
    if (onHide) hideBtn.addEventListener('click', onHide);

    const body = el('div', 'cp__body', element);
    const scope = makeScope(body, ctx);

    return {
        element,
        addSection: scope.addSection,
        refresh() {
            ctx.refreshers.forEach((fn) => fn());
            ctx.polls.forEach((fn) => fn());
        },
        poll() {
            ctx.polls.forEach((fn) => fn());
        }
    };
}
