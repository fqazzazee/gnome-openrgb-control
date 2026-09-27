// High-level lighting operations built on the SDK client. Each device exposes
// a different mix of modes, so every action picks the best-fitting mode.

import GLib from 'gi://GLib';

import {ColorMode, ModeFlag, colorToRgb, rgbToColor} from './protocol.js';

const OFF_RE = /^off$/i;
const STATIC_RE = /^static$/i;
const DIRECT_RE = /^(direct|custom)$/i;

export function deviceKey(ctrl) {
    return `${ctrl.name}|${ctrl.location}`;
}

function cloneMode(mode) {
    return {...mode, colors: [...mode.colors]};
}

const has = (mode, flag) => (mode.flags & flag) !== 0;

export function activeMode(ctrl) {
    return ctrl.modes[ctrl.activeMode] ?? null;
}

function findMode(ctrl, predicate) {
    const index = ctrl.modes.findIndex(predicate);
    return index >= 0 ? index : -1;
}

// Per-LED effects such as music visualizers blank every LED between beats, so
// an all-black per-LED device only counts as off once it has stayed dark for
// DARK_SETTLE_MS, was already dark when first seen, or was blanked by us.
const DARK_SETTLE_MS = 3000;
const darkSince = new Map(); // key -> null (lit) | ms timestamp it went dark

const nowMs = () => GLib.get_monotonic_time() / 1000;

function perLedOn(ctrl) {
    const key = deviceKey(ctrl);
    if (ctrl.colors.some(c => c !== 0)) {
        darkSince.set(key, null);
        return true;
    }
    const since = darkSince.get(key);
    if (since === undefined) {
        darkSince.set(key, 0);
        return false;
    }
    if (since === null) {
        darkSince.set(key, nowMs());
        return true;
    }
    return nowMs() - since < DARK_SETTLE_MS;
}

export function isOn(ctrl) {
    const mode = activeMode(ctrl);
    if (!mode || OFF_RE.test(mode.name))
        return false;
    if (mode.colorMode === ColorMode.PER_LED)
        return perLedOn(ctrl);
    if (mode.colorMode === ColorMode.MODE_SPECIFIC)
        return mode.colors.some(c => c !== 0);
    return true;
}

// Milliseconds until a device that just went dark settles into "off", or 0.
export function darkSettleDelay(ctrl) {
    if (!isOn(ctrl) || activeMode(ctrl)?.colorMode !== ColorMode.PER_LED)
        return 0;
    const since = darkSince.get(deviceKey(ctrl));
    return since ? Math.max(1, Math.ceil(DARK_SETTLE_MS - (nowMs() - since))) : 0;
}

// Returns a representative color for the device, or null for effects.
export function currentColor(ctrl) {
    const mode = activeMode(ctrl);
    if (!mode)
        return null;
    if (mode.colorMode === ColorMode.PER_LED)
        return ctrl.colors.find(c => c !== 0) ?? ctrl.colors[0] ?? null;
    if (mode.colorMode === ColorMode.MODE_SPECIFIC)
        return mode.colors[0] ?? null;
    return null;
}

function colorCount(mode) {
    const n = Math.max(mode.colors.length, mode.colorsMin, 1);
    return mode.colorsMax > 0 ? Math.min(n, mode.colorsMax) : n;
}

async function applyPerLed(client, index, modeIndex, color) {
    const ctrl = client.controllers[index];
    const mode = cloneMode(ctrl.modes[modeIndex]);
    if (ctrl.activeMode !== modeIndex || mode.colorMode !== ColorMode.PER_LED) {
        mode.colorMode = ColorMode.PER_LED;
        await client.updateMode(index, modeIndex, mode);
    }
    await client.updateLeds(index, new Array(ctrl.colors.length).fill(color));
}

async function applyModeSpecific(client, index, modeIndex, color) {
    const ctrl = client.controllers[index];
    const mode = cloneMode(ctrl.modes[modeIndex]);
    mode.colorMode = ColorMode.MODE_SPECIFIC;
    mode.colors = new Array(colorCount(mode)).fill(color);
    await client.updateMode(index, modeIndex, mode);
}

// Set a solid color. Keeps the current effect when it accepts colors,
// otherwise switches to Static, then Direct/Custom.
export async function setColor(client, index, color) {
    const ctrl = client.controllers[index];
    const current = activeMode(ctrl);
    if (current && !OFF_RE.test(current.name)) {
        if (has(current, ModeFlag.HAS_PER_LED_COLOR))
            return applyPerLed(client, index, ctrl.activeMode, color);
        if (has(current, ModeFlag.HAS_MODE_SPECIFIC_COLOR))
            return applyModeSpecific(client, index, ctrl.activeMode, color);
    }

    const candidates = [
        m => STATIC_RE.test(m.name) && has(m, ModeFlag.HAS_MODE_SPECIFIC_COLOR),
        m => STATIC_RE.test(m.name) && has(m, ModeFlag.HAS_PER_LED_COLOR),
        m => DIRECT_RE.test(m.name) && has(m, ModeFlag.HAS_PER_LED_COLOR),
        m => has(m, ModeFlag.HAS_PER_LED_COLOR),
        m => has(m, ModeFlag.HAS_MODE_SPECIFIC_COLOR),
    ];
    for (const predicate of candidates) {
        const modeIndex = findMode(ctrl, predicate);
        if (modeIndex < 0)
            continue;
        const mode = ctrl.modes[modeIndex];
        if (has(mode, ModeFlag.HAS_MODE_SPECIFIC_COLOR) && !has(mode, ModeFlag.HAS_PER_LED_COLOR))
            return applyModeSpecific(client, index, modeIndex, color);
        return applyPerLed(client, index, modeIndex, color);
    }
    throw new Error(`${ctrl.name} has no mode that accepts colors`);
}

export async function turnOff(client, index) {
    const ctrl = client.controllers[index];
    const offIndex = findMode(ctrl, m => OFF_RE.test(m.name));
    if (offIndex >= 0) {
        await client.updateMode(index, offIndex, cloneMode(ctrl.modes[offIndex]));
        return;
    }
    await setColor(client, index, 0);
    darkSince.set(deviceKey(ctrl), 0);
}

export function snapshot(ctrl) {
    const mode = activeMode(ctrl);
    if (!mode)
        return null;
    return {
        modeIndex: ctrl.activeMode,
        mode: cloneMode(mode),
        colors: mode.colorMode === ColorMode.PER_LED ? [...ctrl.colors] : null,
    };
}

export async function restore(client, index, snap) {
    const ctrl = client.controllers[index];
    const target = ctrl.modes[snap?.modeIndex];
    if (!target || target.name !== snap.mode.name)
        return false;
    await client.updateMode(index, snap.modeIndex, cloneMode(snap.mode));
    if (snap.colors?.length === ctrl.colors.length)
        await client.updateLeds(index, snap.colors);
    return true;
}

export async function setMode(client, index, modeIndex, fallbackColor) {
    const ctrl = client.controllers[index];
    const mode = cloneMode(ctrl.modes[modeIndex]);
    await client.updateMode(index, modeIndex, mode);
    // Coming from Off, per-LED modes would otherwise stay dark.
    if (mode.colorMode === ColorMode.PER_LED && ctrl.colors.every(c => c === 0))
        await client.updateLeds(index, new Array(ctrl.colors.length).fill(fallbackColor));
}

export function hasHardwareBrightness(mode) {
    return !!mode && has(mode, ModeFlag.HAS_BRIGHTNESS) && mode.brightnessMin !== mode.brightnessMax;
}

export function hasSpeed(mode) {
    return !!mode && has(mode, ModeFlag.HAS_SPEED) && mode.speedMin !== mode.speedMax;
}

const fraction = (value, min, max) => Math.min(1, Math.max(0, (value - min) / (max - min)));
const lerp = (min, max, t) => Math.round(min + (max - min) * t);

export function getSpeed(ctrl) {
    const mode = activeMode(ctrl);
    return hasSpeed(mode) ? fraction(mode.speed, mode.speedMin, mode.speedMax) : null;
}

export async function setSpeed(client, index, value) {
    const ctrl = client.controllers[index];
    const mode = cloneMode(activeMode(ctrl));
    mode.speed = lerp(mode.speedMin, mode.speedMax, value);
    await client.updateMode(index, ctrl.activeMode, mode);
}

export function scaleColor(color, t) {
    const [r, g, b] = colorToRgb(color);
    return rgbToColor(Math.round(r * t), Math.round(g * t), Math.round(b * t));
}

// Brightness uses the mode's hardware brightness when present and scales
// colors in software otherwise. `bases` caches unscaled colors per device so
// repeated slider moves don't compound rounding loss.
export class BrightnessController {
    constructor() {
        this._bases = new Map();
    }

    forget(key) {
        this._bases.delete(key);
    }

    _base(key, current) {
        const entry = this._bases.get(key);
        if (entry && entry.written.length === current.length &&
            entry.written.every((c, i) => c === current[i]))
            return entry.base;
        return current;
    }

    async apply(client, index, value) {
        const ctrl = client.controllers[index];
        const mode = activeMode(ctrl);
        if (!mode || !isOn(ctrl))
            return;
        const key = deviceKey(ctrl);

        if (hasHardwareBrightness(mode)) {
            const next = cloneMode(mode);
            next.brightness = lerp(mode.brightnessMin, mode.brightnessMax, value);
            await client.updateMode(index, ctrl.activeMode, next);
            return;
        }

        if (mode.colorMode === ColorMode.PER_LED) {
            const base = this._base(key, ctrl.colors);
            const written = base.map(c => scaleColor(c, value));
            this._bases.set(key, {base, written});
            await client.updateLeds(index, written);
        } else if (mode.colorMode === ColorMode.MODE_SPECIFIC) {
            const base = this._base(key, mode.colors);
            const written = base.map(c => scaleColor(c, value));
            this._bases.set(key, {base, written});
            const next = cloneMode(mode);
            next.colors = written;
            await client.updateMode(index, ctrl.activeMode, next);
        }
    }
}

export function hueToColor(hue) {
    const h = (hue % 1) * 6;
    const x = Math.round(255 * (1 - Math.abs((h % 2) - 1)));
    const table = [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]];
    const [r, g, b] = table[Math.floor(h) % 6];
    return rgbToColor(r, g, b);
}
