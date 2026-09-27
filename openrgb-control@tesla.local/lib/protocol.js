// OpenRGB SDK wire format (protocol versions 3–6).
// Reference: OpenRGB release_1.0 NetworkProtocol.h / RGBController.cpp.

export const MAX_PROTOCOL = 6;
export const HEADER_SIZE = 16;
const MAGIC = [0x4f, 0x52, 0x47, 0x42]; // "ORGB"

export const Pkt = {
    CONTROLLER_COUNT: 0,
    CONTROLLER_DATA: 1,
    ACK: 10,
    PROTOCOL_VERSION: 40,
    SET_CLIENT_NAME: 50,
    SET_SERVER_NAME: 51,
    DEVICE_LIST_UPDATED: 100,
    DETECTION_COMPLETE: 103,
    RESCAN_DEVICES: 140,
    PROFILE_LIST: 150,
    SAVE_PROFILE: 151,
    LOAD_PROFILE: 152,
    DELETE_PROFILE: 153,
    ACTIVE_PROFILE: 156,
    ACTIVE_PROFILE_CHANGED: 157,
    PROFILE_LOADED: 158,
    PROFILE_LIST_UPDATED: 160,
    UPDATE_LEDS: 1050,
    UPDATE_MODE: 1101,
    SAVE_MODE: 1102,
    SIGNAL_UPDATE: 1150,
};

export const ModeFlag = {
    HAS_SPEED: 1 << 0,
    HAS_DIRECTION_LR: 1 << 1,
    HAS_DIRECTION_UD: 1 << 2,
    HAS_DIRECTION_HV: 1 << 3,
    HAS_BRIGHTNESS: 1 << 4,
    HAS_PER_LED_COLOR: 1 << 5,
    HAS_MODE_SPECIFIC_COLOR: 1 << 6,
    HAS_RANDOM_COLOR: 1 << 7,
};

export const ColorMode = {NONE: 0, PER_LED: 1, MODE_SPECIFIC: 2, RANDOM: 3};

export const UpdateReason = {UPDATE_LEDS: 0};

export const DEVICE_TYPES = [
    'Motherboard', 'DRAM', 'GPU', 'Cooler', 'LED Strip', 'Keyboard', 'Mouse',
    'Mousemat', 'Headset', 'Headset Stand', 'Gamepad', 'Light', 'Speaker',
    'Virtual', 'Storage', 'Case', 'Microphone', 'Accessory', 'Keypad',
    'Laptop', 'Monitor',
];

export function deviceTypeName(type) {
    return DEVICE_TYPES[type] ?? 'Device';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function buildPacket(devId, pktId, payload = new Uint8Array(0)) {
    const buf = new Uint8Array(HEADER_SIZE + payload.length);
    buf.set(MAGIC, 0);
    const view = new DataView(buf.buffer);
    view.setUint32(4, devId, true);
    view.setUint32(8, pktId, true);
    view.setUint32(12, payload.length, true);
    buf.set(payload, HEADER_SIZE);
    return buf;
}

// Returns {devId, pktId, size} or null if magic mismatches.
export function parseHeader(bytes) {
    for (let i = 0; i < 4; i++) {
        if (bytes[i] !== MAGIC[i])
            return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
    return {
        devId: view.getUint32(4, true),
        pktId: view.getUint32(8, true),
        size: view.getUint32(12, true),
    };
}

export function cString(str) {
    const b = encoder.encode(str);
    const out = new Uint8Array(b.length + 1);
    out.set(b);
    return out;
}

export function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = 0;
    }

    u16() {
        const v = this.view.getUint16(this.pos, true);
        this.pos += 2;
        return v;
    }

    u32() {
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    i32() {
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
    }

    string(len = this.u16()) {
        const raw = this.bytes.subarray(this.pos, this.pos + len);
        this.pos += len;
        const nul = raw.indexOf(0);
        return decoder.decode(nul >= 0 ? raw.subarray(0, nul) : raw);
    }

    skip(n) {
        this.pos += n;
    }
}

class Writer {
    constructor() {
        this.parts = [];
        this.length = 0;
    }

    _push(arr) {
        this.parts.push(arr);
        this.length += arr.length;
    }

    u16(v) {
        const a = new Uint8Array(2);
        new DataView(a.buffer).setUint16(0, v, true);
        this._push(a);
    }

    u32(v) {
        this._push(u32(v >>> 0));
    }

    i32(v) {
        const a = new Uint8Array(4);
        new DataView(a.buffer).setInt32(0, v, true);
        this._push(a);
    }

    string(s) {
        const b = cString(s);
        this.u16(b.length);
        this._push(b);
    }

    toBytes() {
        const out = new Uint8Array(this.length);
        let off = 0;
        for (const p of this.parts) {
            out.set(p, off);
            off += p.length;
        }
        return out;
    }
}

function readMode(r, version) {
    const mode = {name: r.string()};
    if (version < 6)
        mode.value = r.i32();
    mode.flags = r.u32();
    mode.speedMin = r.u32();
    mode.speedMax = r.u32();
    if (version >= 3) {
        mode.brightnessMin = r.u32();
        mode.brightnessMax = r.u32();
    } else {
        mode.brightnessMin = mode.brightnessMax = 0;
    }
    mode.colorsMin = r.u32();
    mode.colorsMax = r.u32();
    mode.speed = r.u32();
    mode.brightness = version >= 3 ? r.u32() : 0;
    mode.direction = r.u32();
    mode.colorMode = r.u32();
    const n = r.u16();
    mode.colors = [];
    for (let i = 0; i < n; i++)
        mode.colors.push(r.u32());
    return mode;
}

function writeMode(w, mode, version) {
    w.string(mode.name);
    if (version < 6)
        w.i32(mode.value ?? 0);
    w.u32(mode.flags);
    w.u32(mode.speedMin);
    w.u32(mode.speedMax);
    if (version >= 3) {
        w.u32(mode.brightnessMin);
        w.u32(mode.brightnessMax);
    }
    w.u32(mode.colorsMin);
    w.u32(mode.colorsMax);
    w.u32(mode.speed);
    if (version >= 3)
        w.u32(mode.brightness);
    w.u32(mode.direction);
    w.u32(mode.colorMode);
    w.u16(mode.colors.length);
    for (const c of mode.colors)
        w.u32(c);
}

function skipMatrix(r) {
    const size = r.u16();
    r.skip(size);
}

function readZone(r, version) {
    const zone = {name: r.string(), type: r.i32()};
    zone.ledsMin = r.u32();
    zone.ledsMax = r.u32();
    zone.ledsCount = r.u32();
    skipMatrix(r);
    if (version >= 4) {
        const segments = r.u16();
        for (let i = 0; i < segments; i++) {
            r.string();
            r.i32();
            r.u32();
            r.u32();
            if (version >= 6) {
                skipMatrix(r);
                r.u32();
            }
        }
    }
    if (version >= 5)
        zone.flags = r.u32();
    if (version >= 6) {
        zone.activeMode = r.i32();
        const modes = r.u16();
        zone.modes = [];
        for (let i = 0; i < modes; i++)
            zone.modes.push(readMode(r, version));
        zone.displayName = r.string();
    }
    return zone;
}

function readColors(r) {
    const n = r.u16();
    const colors = new Array(n);
    for (let i = 0; i < n; i++)
        colors[i] = r.u32();
    return colors;
}

// Parses a controller description block (leading u32 size included).
export function parseController(bytes, version) {
    const r = new Reader(bytes);
    r.u32(); // data size
    const c = {type: r.i32(), name: r.string()};
    c.vendor = version >= 1 ? r.string() : '';
    c.description = r.string();
    c.version = r.string();
    c.serial = r.string();
    c.location = r.string();
    const numModes = r.u16();
    c.activeMode = r.i32();
    c.modes = [];
    for (let i = 0; i < numModes; i++)
        c.modes.push(readMode(r, version));
    const numZones = r.u16();
    c.zones = [];
    for (let i = 0; i < numZones; i++)
        c.zones.push(readZone(r, version));
    const numLeds = r.u16();
    for (let i = 0; i < numLeds; i++) {
        r.string();
        if (version < 6)
            r.u32();
    }
    c.colors = readColors(r);
    if (version >= 5) {
        const altNames = r.u16();
        for (let i = 0; i < altNames; i++)
            r.string();
        c.flags = r.u32();
    }
    if (version >= 6) {
        c.displayName = r.string();
        const cfgLen = r.u32();
        r.skip(cfgLen);
    }
    return c;
}

// SIGNAL_UPDATE payload: u32 size, u32 reason, then colors or a device block.
export function parseSignalUpdate(bytes, version) {
    const r = new Reader(bytes);
    r.u32();
    const reason = r.u32();
    if (reason === UpdateReason.UPDATE_LEDS)
        return {reason, colors: readColors(r)};
    return {reason, controller: parseController(bytes.subarray(4), version)};
}

export function parseControllerCount(bytes, version) {
    const r = new Reader(bytes);
    const count = r.u32();
    const ids = [];
    for (let i = 0; i < count; i++)
        ids.push(version >= 6 ? r.u32() : i);
    return ids;
}

export function parseProfileList(bytes) {
    const r = new Reader(bytes);
    r.u32();
    const n = r.u16();
    const names = [];
    for (let i = 0; i < n; i++)
        names.push(r.string());
    return names;
}

export function parseAck(bytes) {
    const r = new Reader(bytes);
    return {pktId: r.u32(), status: r.u32()};
}

export function parseCString(bytes) {
    return new Reader(bytes).string(bytes.length);
}

export function readU32(bytes) {
    return new Reader(bytes).u32();
}

// UPDATE_MODE / SAVE_MODE payload: u32 size, i32 mode index, mode block.
export function buildModePayload(modeIndex, mode, version) {
    const body = new Writer();
    body.i32(modeIndex);
    writeMode(body, mode, version);
    const bytes = body.toBytes();
    const out = new Uint8Array(bytes.length + 4);
    out.set(u32(out.length), 0);
    out.set(bytes, 4);
    return out;
}

// UPDATE_LEDS payload: u32 size, u16 count, u32 colors.
export function buildLedsPayload(colors) {
    const w = new Writer();
    w.u32(4 + 2 + colors.length * 4);
    w.u16(colors.length);
    for (const c of colors)
        w.u32(c);
    return w.toBytes();
}

// OpenRGB colors are 0x00BBGGRR.
export function rgbToColor(r, g, b) {
    return ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

export function colorToRgb(c) {
    return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
}

export function hexToColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return rgbToColor((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

export function colorToHex(c) {
    const [r, g, b] = colorToRgb(c);
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
