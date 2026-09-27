// Async OpenRGB SDK client. Holds a mirror of the server's controllers and
// profiles and emits signals when they change.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as P from './protocol.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');

const REQUEST_TIMEOUT_MS = 5000;

export const OpenRGBClient = GObject.registerClass({
    Signals: {
        'state-changed': {},
        'devices-changed': {},
        'device-updated': {param_types: [GObject.TYPE_INT]},
        'profiles-changed': {},
    },
}, class OpenRGBClient extends GObject.Object {
    constructor(clientName) {
        super();
        this._clientName = clientName;
        this._conn = null;
        this._cancellable = null;
        this._buffer = new Uint8Array(0);
        this._waiters = new Map();
        this._lock = Promise.resolve();
        this._writeChain = Promise.resolve();

        this.connected = false;
        this.version = 0;
        this.serverName = '';
        this.controllers = [];
        this.profiles = [];
        this.activeProfile = '';
    }

    async open(host, port) {
        this.close();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        const client = new Gio.SocketClient({timeout: 3});
        const conn = await client.connect_to_host_async(host, port, cancellable);
        if (cancellable.is_cancelled()) {
            conn.close(null);
            return;
        }
        // The client timeout also applies to every later read; the connection
        // idles between events, so only the connect itself may time out.
        const socket = conn.get_socket();
        socket.set_timeout(0);
        socket.set_keepalive(true);
        socket.set_option(6 /* IPPROTO_TCP */, 1 /* TCP_NODELAY */, 1);
        this._conn = conn;
        this._readLoop(conn, cancellable);

        try {
            const reply = await this._request(0, P.Pkt.PROTOCOL_VERSION,
                P.u32(P.MAX_PROTOCOL), P.Pkt.PROTOCOL_VERSION);
            this.version = Math.min(P.readU32(reply.data), P.MAX_PROTOCOL);
        } catch (e) {
            // Protocol 0 servers never answer the version request.
            this.version = 0;
        }
        this._send(0, P.Pkt.SET_CLIENT_NAME, P.cString(this._clientName));

        this.connected = true;
        await this.refreshAll();
        this.emit('state-changed');
    }

    close() {
        this._cancellable?.cancel();
        this._cancellable = null;
        const wasConnected = this.connected;
        this.connected = false;
        if (this._conn) {
            this._conn.close_async(GLib.PRIORITY_DEFAULT, null, null);
            this._conn = null;
        }
        this._buffer = new Uint8Array(0);
        for (const queue of this._waiters.values()) {
            for (const w of queue)
                w.reject(new Error('Disconnected'));
        }
        this._waiters.clear();
        this.controllers = [];
        if (wasConnected)
            this.emit('state-changed');
    }

    async _readLoop(conn, cancellable) {
        const input = conn.get_input_stream();
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, cancellable);
                if (bytes.get_size() === 0)
                    throw new Error('Connection closed by server');
                this._append(bytes.toArray());
                this._drain();
            }
        } catch (e) {
            if (cancellable.is_cancelled())
                return;
            this.close();
            this.emit('state-changed');
        }
    }

    _append(chunk) {
        const merged = new Uint8Array(this._buffer.length + chunk.length);
        merged.set(this._buffer);
        merged.set(chunk, this._buffer.length);
        this._buffer = merged;
    }

    _drain() {
        while (this._buffer.length >= P.HEADER_SIZE) {
            const header = P.parseHeader(this._buffer);
            if (!header)
                throw new Error('Bad packet magic');
            const total = P.HEADER_SIZE + header.size;
            if (this._buffer.length < total)
                return;
            const data = this._buffer.slice(P.HEADER_SIZE, total);
            this._buffer = this._buffer.slice(total);
            this._dispatch(header, data);
        }
    }

    _dispatch(header, data) {
        const key = header.pktId === P.Pkt.ACK ? `ack:${P.parseAck(data).pktId}` : `${header.pktId}`;
        const queue = this._waiters.get(key);
        if (queue?.length) {
            const waiter = queue.shift();
            waiter.resolve({devId: header.devId, data});
            return;
        }
        try {
            this._handleEvent(header, data);
        } catch (e) {
            console.warn(`[openrgb-control] Failed to handle packet ${header.pktId}: ${e.message}`);
        }
    }

    _handleEvent(header, data) {
        switch (header.pktId) {
        case P.Pkt.SIGNAL_UPDATE: {
            const index = this.controllers.findIndex(c => c.id === header.devId);
            if (index < 0)
                return;
            const update = P.parseSignalUpdate(data, this.version);
            const ctrl = this.controllers[index];
            if (update.colors)
                ctrl.colors = update.colors;
            else
                this.controllers[index] = Object.assign(update.controller, {id: ctrl.id});
            this.emit('device-updated', index);
            break;
        }
        case P.Pkt.DEVICE_LIST_UPDATED:
        case P.Pkt.DETECTION_COMPLETE:
            this._scheduleRefresh();
            break;
        case P.Pkt.ACTIVE_PROFILE_CHANGED:
        case P.Pkt.PROFILE_LIST_UPDATED:
        case P.Pkt.PROFILE_LOADED:
            this._serialize(() => this._fetchProfiles())
                .then(() => this.emit('profiles-changed'))
                .catch(() => {});
            break;
        case P.Pkt.SET_SERVER_NAME:
            this.serverName = P.parseCString(data);
            break;
        }
    }

    _scheduleRefresh() {
        if (this._refreshId)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._refreshId = 0;
            this.refreshAll().catch(e => console.warn(`[openrgb-control] Refresh failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _send(devId, pktId, payload) {
        const conn = this._conn;
        if (!conn)
            return Promise.reject(new Error('Not connected'));
        const packet = P.buildPacket(devId, pktId, payload);
        this._writeChain = this._writeChain
            .catch(() => {})
            .then(() => conn.get_output_stream().write_all_async(packet, GLib.PRIORITY_DEFAULT, this._cancellable));
        return this._writeChain;
    }

    _await(key) {
        return new Promise((resolve, reject) => {
            const waiter = {resolve, reject};
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
                const queue = this._waiters.get(key);
                const i = queue?.indexOf(waiter) ?? -1;
                if (i >= 0)
                    queue.splice(i, 1);
                reject(new Error(`Timed out waiting for ${key}`));
                return GLib.SOURCE_REMOVE;
            });
            waiter.resolve = v => {
                GLib.source_remove(timeoutId);
                resolve(v);
            };
            waiter.reject = e => {
                GLib.source_remove(timeoutId);
                reject(e);
            };
            if (!this._waiters.has(key))
                this._waiters.set(key, []);
            this._waiters.get(key).push(waiter);
        });
    }

    _request(devId, pktId, payload, replyPktId) {
        const reply = this._await(`${replyPktId}`);
        this._send(devId, pktId, payload).catch(() => {});
        return reply;
    }

    // Fire a command; on protocol 6+ wait for the server's ACK and surface errors.
    async _command(devId, pktId, payload) {
        if (this.version < 6) {
            await this._send(devId, pktId, payload);
            return;
        }
        const ack = this._await(`ack:${pktId}`);
        this._send(devId, pktId, payload).catch(() => {});
        const {data} = await ack;
        const {status} = P.parseAck(data);
        if (status !== 0)
            throw new Error(`OpenRGB rejected request ${pktId} (status ${status})`);
    }

    // Requests whose replies share a packet id must not interleave.
    _serialize(fn) {
        const run = this._lock.then(fn, fn);
        this._lock = run.catch(() => {});
        return run;
    }

    refreshAll() {
        return this._serialize(async () => {
            await this._fetchControllers();
            await this._fetchProfiles();
        }).then(() => {
            this.emit('devices-changed');
            this.emit('profiles-changed');
        });
    }

    async _fetchControllers() {
        const count = await this._request(0, P.Pkt.CONTROLLER_COUNT, undefined, P.Pkt.CONTROLLER_COUNT);
        const ids = P.parseControllerCount(count.data, this.version);
        const controllers = [];
        for (const [index, id] of ids.entries()) {
            const payload = this.version < 6 ? P.u32(this.version) : undefined;
            // eslint-disable-next-line no-await-in-loop
            const reply = await this._request(this.version >= 6 ? id : index,
                P.Pkt.CONTROLLER_DATA, payload, P.Pkt.CONTROLLER_DATA);
            controllers.push(Object.assign(P.parseController(reply.data, this.version), {id}));
        }
        this.controllers = controllers;
    }

    async _fetchProfiles() {
        if (this.version < 2) {
            this.profiles = [];
            return;
        }
        const list = await this._request(0, P.Pkt.PROFILE_LIST, undefined, P.Pkt.PROFILE_LIST);
        this.profiles = P.parseProfileList(list.data);
        if (this.version >= 6) {
            const active = await this._request(0, P.Pkt.ACTIVE_PROFILE, undefined, P.Pkt.ACTIVE_PROFILE);
            this.activeProfile = P.parseCString(active.data);
        }
    }

    _devId(index) {
        return this.version >= 6 ? this.controllers[index].id : index;
    }

    async updateMode(index, modeIndex, mode, save = false) {
        const ctrl = this.controllers[index];
        await this._command(this._devId(index), save ? P.Pkt.SAVE_MODE : P.Pkt.UPDATE_MODE,
            P.buildModePayload(modeIndex, mode, this.version));
        ctrl.activeMode = modeIndex;
        ctrl.modes[modeIndex] = mode;
    }

    async updateLeds(index, colors) {
        const ctrl = this.controllers[index];
        await this._command(this._devId(index), P.Pkt.UPDATE_LEDS, P.buildLedsPayload(colors));
        ctrl.colors = colors;
    }

    async loadProfile(name) {
        await this._command(0, P.Pkt.LOAD_PROFILE, P.cString(name));
        this.activeProfile = name;
        // Pull the new device state; servers before protocol 6 send no updates.
        await this.refreshAll();
    }

    async saveProfile(name) {
        await this._command(0, P.Pkt.SAVE_PROFILE, P.cString(name));
        await this.refreshAll();
    }

    async deleteProfile(name) {
        await this._command(0, P.Pkt.DELETE_PROFILE, P.cString(name));
        await this.refreshAll();
    }

    rescan() {
        return this._command(0, P.Pkt.RESCAN_DEVICES, undefined);
    }

    destroy() {
        if (this._refreshId) {
            GLib.source_remove(this._refreshId);
            this._refreshId = 0;
        }
        this.close();
    }
});
