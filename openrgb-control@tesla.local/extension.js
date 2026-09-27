import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {OpenRGBClient} from './lib/client.js';
import * as L from './lib/lighting.js';
import {colorToHex, hexToColor} from './lib/protocol.js';

const SERVER_UNIT = 'openrgb-server.service';
const OPENRGB_APP = 'org.openrgb.OpenRGB.desktop';
const STARTUP_STAMP = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'openrgb-control-startup-applied']);
const RESUME_DELAY_MS = 2500;
const SLIDER_THROTTLE_MS = 80;

const DEVICE_ICONS = {
    0: 'computer-symbolic',
    1: 'media-flash-symbolic',
    2: 'video-display-symbolic',
    3: 'weather-windy-symbolic',
    4: 'display-brightness-symbolic',
    5: 'input-keyboard-symbolic',
    6: 'input-mouse-symbolic',
    8: 'audio-headphones-symbolic',
    10: 'input-gaming-symbolic',
    11: 'display-brightness-symbolic',
    12: 'audio-speakers-symbolic',
    14: 'drive-harddisk-symbolic',
    16: 'audio-input-microphone-symbolic',
    20: 'video-display-symbolic',
};

const LoginManagerIface = `
<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="Inhibit">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="h" direction="out"/>
    </method>
    <signal name="PrepareForSleep">
      <arg type="b"/>
    </signal>
  </interface>
</node>`;
const LoginManagerProxy = Gio.DBusProxy.makeProxyWrapper(LoginManagerIface);

// Runs `fn` at most once per `ms`, always delivering the latest arguments.
function throttle(ms, fn) {
    let pending = null;
    let sourceId = 0;
    const wrapped = (...args) => {
        pending = args;
        if (sourceId)
            return;
        fn(...pending);
        pending = null;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            sourceId = 0;
            if (pending) {
                const latest = pending;
                pending = null;
                wrapped(...latest);
            }
            return GLib.SOURCE_REMOVE;
        });
    };
    wrapped.cancel = () => {
        if (sourceId)
            GLib.source_remove(sourceId);
        sourceId = 0;
        pending = null;
    };
    return wrapped;
}

// Owns the SDK connection and every lighting action; the UI only calls into it.
class LightingService extends Signals.EventEmitter {
    constructor(extension) {
        super();
        this._ext = extension;
        this._settings = extension.getSettings();
        this._client = new OpenRGBClient('GNOME Shell');
        this._brightness = new L.BrightnessController();
        this._queues = new Map();
        this._retryId = 0;
        this._settleId = 0;
        this._serverStartAttempted = false;
        this._autoOff = null;
        this._destroyed = false;

        this._clientIds = [
            this._client.connect('state-changed', () => this._onStateChanged()),
            this._client.connect('devices-changed', () => this.emit('devices-changed')),
            this._client.connect('profiles-changed', () => this.emit('profiles-changed')),
            this._client.connect('device-updated', (_c, index) => {
                this.emit('device-updated', index);
                this._watchDarkSettle(index);
            }),
        ];
        this._settingsIds = [
            ...['host', 'port'].map(k => this._settings.connect(`changed::${k}`, () => this.reconnect())),
            ...['excluded-devices', 'device-names', 'hidden-profiles'].map(k =>
                this._settings.connect(`changed::${k}`, () => this.emit('devices-changed'))),
        ];

        this._watchSuspend();
        this._sessionId = Main.sessionMode.connect('updated', () => this._onSessionModeChanged());
        this._locked = Main.sessionMode.isLocked;

        this.reconnect();
    }

    get settings() {
        return this._settings;
    }

    get connected() {
        return this._client.connected;
    }

    get profiles() {
        const hidden = new Set(this._settings.get_strv('hidden-profiles'));
        return this._client.profiles.filter(p => !hidden.has(p));
    }

    get allProfiles() {
        return this._client.profiles;
    }

    get activeProfile() {
        return this._client.activeProfile;
    }

    // Visible devices with their menu labels; duplicate names get a number.
    get devices() {
        const excluded = new Set(this._settings.get_strv('excluded-devices'));
        const names = this._customNames();
        const counts = new Map();
        for (const c of this._client.controllers)
            counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        const seen = new Map();
        return this._client.controllers.map((ctrl, index) => {
            const key = L.deviceKey(ctrl);
            const n = (seen.get(ctrl.name) ?? 0) + 1;
            seen.set(ctrl.name, n);
            let label = names[key] || ctrl.displayName || ctrl.name;
            if (!names[key] && counts.get(ctrl.name) > 1)
                label = `${label} ${n}`;
            return {index, ctrl, key, label, excluded: excluded.has(key)};
        }).filter(d => !d.excluded);
    }

    _customNames() {
        try {
            return JSON.parse(this._settings.get_string('device-names'));
        } catch {
            return {};
        }
    }

    get isOn() {
        return this.devices.some(d => L.isOn(d.ctrl));
    }

    // Re-sync once a device that went dark mid-effect has settled into "off".
    _watchDarkSettle(index) {
        const ctrl = this._client.controllers[index];
        const delay = ctrl ? L.darkSettleDelay(ctrl) : 0;
        if (!delay || this._settleId)
            return;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._settleId = 0;
            this.emit('state-changed');
            this._client.controllers.forEach((_c, i) => this._watchDarkSettle(i));
            return GLib.SOURCE_REMOVE;
        });
    }

    get lastColor() {
        return hexToColor(this._settings.get_string('last-color')) ?? 0xffffff;
    }

    // ---- Connection -------------------------------------------------------

    reconnect() {
        this._clearRetry();
        const host = this._settings.get_string('host');
        const port = this._settings.get_int('port');
        this._client.open(host, port).then(() => {
            this._serverStartAttempted = false;
            this._applyStartupProfile();
        }).catch(e => {
            if (this._destroyed)
                return;
            console.debug(`[openrgb-control] Connect failed: ${e.message}`);
            if (this._settings.get_boolean('manage-server') && !this._serverStartAttempted) {
                this._serverStartAttempted = true;
                this.startServer();
            }
            this._scheduleRetry();
        });
    }

    _scheduleRetry() {
        this._clearRetry();
        const seconds = this._settings.get_int('reconnect-interval');
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retryId = 0;
            this.reconnect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearRetry() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
    }

    _onStateChanged() {
        if (!this._client.connected && !this._destroyed && !this._retryId)
            this._scheduleRetry();
        this.emit('state-changed');
    }

    // Prefer the systemd user unit; fall back to spawning OpenRGB directly.
    startServer() {
        const port = `${this._settings.get_int('port')}`;
        const spawnDirect = () => {
            try {
                Gio.Subprocess.new(['openrgb', '--server', '--server-port', port, '--noautoconnect'],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            } catch (e) {
                console.warn(`[openrgb-control] Could not start OpenRGB: ${e.message}`);
            }
        };
        try {
            const proc = Gio.Subprocess.new(['systemctl', '--user', 'start', SERVER_UNIT],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_check_async(null, (p, res) => {
                try {
                    p.wait_check_finish(res);
                } catch {
                    spawnDirect();
                }
                this._clearRetry();
                this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    this._retryId = 0;
                    this.reconnect();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch {
            spawnDirect();
        }
    }

    rescan() {
        this._run(this._client.rescan());
    }

    _applyStartupProfile() {
        const name = this._settings.get_string('startup-profile');
        if (!name || GLib.file_test(STARTUP_STAMP, GLib.FileTest.EXISTS))
            return;
        GLib.file_set_contents(STARTUP_STAMP, name);
        if (this._client.profiles.includes(name))
            this.loadProfile(name);
    }

    // ---- Actions ----------------------------------------------------------

    // Serialize operations per device so mode and LED writes never interleave.
    _enqueue(index, fn) {
        const prev = this._queues.get(index) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(() => {
            if (!this._client.connected || !this._client.controllers[index])
                throw new Error(_('OpenRGB is not connected'));
            return fn();
        });
        this._queues.set(index, next);
        return next;
    }

    _run(promise, quiet = false) {
        return promise.catch(e => {
            console.warn(`[openrgb-control] ${e.message}`);
            if (!quiet)
                Main.notifyError(_('RGB Lighting'), e.message);
        }).finally(() => this.emit('state-changed'));
    }

    _forEachDevice(fn) {
        return Promise.all(this.devices.map(d => this._enqueue(d.index, () => fn(d))));
    }

    _loadSnapshots() {
        try {
            return JSON.parse(this._settings.get_string('device-state'));
        } catch {
            return {};
        }
    }

    _saveSnapshot(d) {
        const snaps = this._loadSnapshots();
        snaps[d.key] = L.snapshot(d.ctrl);
        this._settings.set_string('device-state', JSON.stringify(snaps));
    }

    _profileExists(name) {
        return !!name && this._client.profiles.includes(name);
    }

    setAllOn(on, quiet = false) {
        return this._run((async () => {
            if (!on) {
                for (const d of this.devices) {
                    if (L.isOn(d.ctrl))
                        this._saveSnapshot(d);
                }
                const offProfile = this._settings.get_string('off-profile');
                if (this._profileExists(offProfile))
                    await this._client.loadProfile(offProfile);
                else
                    await this._forEachDevice(d => L.turnOff(this._client, d.index));
                return;
            }
            const onProfile = this._settings.get_string('on-profile');
            if (this._profileExists(onProfile)) {
                await this._client.loadProfile(onProfile);
                return;
            }
            const snaps = this._loadSnapshots();
            await this._forEachDevice(async d => {
                if (L.isOn(d.ctrl))
                    return;
                if (!await L.restore(this._client, d.index, snaps[d.key]))
                    await L.setColor(this._client, d.index, this.lastColor);
            });
        })(), quiet);
    }

    toggle() {
        return this.setAllOn(!this.isOn);
    }

    async _applyColor(d, color) {
        await L.setColor(this._client, d.index, color);
        this._brightness.forget(d.key);
        const level = this._settings.get_double('brightness');
        if (level < 0.999)
            await this._brightness.apply(this._client, d.index, level);
    }

    setAllColor(color) {
        this._settings.set_string('last-color', colorToHex(color));
        return this._run(this._forEachDevice(d => this._applyColor(d, color)));
    }

    setAllBrightness(value) {
        this._settings.set_double('brightness', value);
        return this._run(this._forEachDevice(d =>
            this._brightness.apply(this._client, d.index, value)), true);
    }

    loadProfile(name) {
        return this._run(this._client.loadProfile(name));
    }

    nextProfile() {
        const profiles = this.profiles;
        if (!profiles.length)
            return null;
        const next = profiles[(profiles.indexOf(this.activeProfile) + 1) % profiles.length];
        this.loadProfile(next);
        return next;
    }

    saveProfile(name) {
        return this._run(this._client.saveProfile(name));
    }

    _device(index) {
        return this.devices.find(d => d.index === index);
    }

    setDeviceOn(index, on) {
        const d = this._device(index);
        if (!d)
            return Promise.resolve();
        return this._run(this._enqueue(index, async () => {
            if (!on) {
                if (L.isOn(d.ctrl))
                    this._saveSnapshot(d);
                await L.turnOff(this._client, index);
            } else if (!await L.restore(this._client, index, this._loadSnapshots()[d.key])) {
                await L.setColor(this._client, index, this.lastColor);
            }
        }));
    }

    setDeviceColor(index, color) {
        const d = this._device(index);
        if (!d)
            return Promise.resolve();
        this._settings.set_string('last-color', colorToHex(color));
        return this._run(this._enqueue(index, () => this._applyColor(d, color)));
    }

    setDeviceMode(index, modeIndex) {
        return this._run(this._enqueue(index, () =>
            L.setMode(this._client, index, modeIndex, this.lastColor)));
    }

    setDeviceBrightness(index, value) {
        return this._run(this._enqueue(index, () =>
            this._brightness.apply(this._client, index, value)), true);
    }

    setDeviceSpeed(index, value) {
        return this._run(this._enqueue(index, () =>
            L.setSpeed(this._client, index, value)), true);
    }

    // ---- Lock & suspend ---------------------------------------------------

    _onSessionModeChanged() {
        const locked = Main.sessionMode.isLocked;
        if (locked === this._locked)
            return;
        this._locked = locked;
        this.emit('lock-changed', locked);
        if (locked && this._settings.get_boolean('off-on-lock'))
            this._autoSwitchOff('lock');
        else if (!locked && this._autoOff === 'lock')
            this._autoSwitchOn();
    }

    _autoSwitchOff(reason) {
        if (!this.connected || !this.isOn)
            return Promise.resolve();
        this._autoOff = reason;
        return this.setAllOn(false, true);
    }

    _autoSwitchOn() {
        this._autoOff = null;
        return this.setAllOn(true, true);
    }

    _watchSuspend() {
        this._login = null;
        this._inhibitFd = null;
        LoginManagerProxy(Gio.DBus.system, 'org.freedesktop.login1', '/org/freedesktop/login1',
            (proxy, error) => {
                if (error || this._destroyed)
                    return;
                this._login = proxy;
                this._sleepId = proxy.connectSignal('PrepareForSleep', (_p, _s, [going]) =>
                    this._onPrepareForSleep(going));
                this._takeInhibitor();
            });
    }

    // A delay inhibitor gives us time to switch devices off before sleep.
    _takeInhibitor() {
        if (!this._login || this._inhibitFd || !this._settings.get_boolean('off-on-suspend'))
            return;
        this._login.call_with_unix_fd_list(
            'Inhibit',
            new GLib.Variant('(ssss)', ['sleep', 'RGB Lighting', 'Switching RGB lighting off', 'delay']),
            Gio.DBusCallFlags.NONE, -1, null, null,
            (proxy, res) => {
                try {
                    const [, fdList] = proxy.call_with_unix_fd_list_finish(res);
                    const fd = fdList.steal_fds()[0];
                    if (this._destroyed)
                        new Gio.UnixInputStream({fd, close_fd: true}).close(null);
                    else
                        this._inhibitFd = fd;
                } catch (e) {
                    console.debug(`[openrgb-control] Inhibit failed: ${e.message}`);
                }
            });
    }

    _releaseInhibitor() {
        if (this._inhibitFd === null)
            return;
        new Gio.UnixInputStream({fd: this._inhibitFd, close_fd: true}).close(null);
        this._inhibitFd = null;
    }

    _onPrepareForSleep(going) {
        if (going) {
            const off = this._settings.get_boolean('off-on-suspend')
                ? this._autoSwitchOff('suspend') : Promise.resolve();
            off.finally(() => this._releaseInhibitor());
            return;
        }
        this._takeInhibitor();
        if (this._autoOff !== 'suspend')
            return;
        // USB devices re-enumerate after resume; give OpenRGB a moment.
        this._resumeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESUME_DELAY_MS, () => {
            this._resumeId = 0;
            this._autoSwitchOn();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        this._clearRetry();
        if (this._resumeId)
            GLib.source_remove(this._resumeId);
        if (this._settleId)
            GLib.source_remove(this._settleId);
        Main.sessionMode.disconnect(this._sessionId);
        if (this._sleepId)
            this._login.disconnectSignal(this._sleepId);
        this._releaseInhibitor();
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._clientIds.forEach(id => this._client.disconnect(id));
        this._client.destroy();
        this._settings = null;
    }
}

// ---- Menu widgets ---------------------------------------------------------

function makeSwatch(color, onClick) {
    const button = new St.Button({
        style_class: 'openrgb-swatch',
        style: `background-color: ${colorToHex(color)};`,
        can_focus: true,
        accessible_name: colorToHex(color),
    });
    button.connect('clicked', () => onClick(color));
    return button;
}

const SwatchRow = GObject.registerClass(
class SwatchRow extends PopupMenu.PopupBaseMenuItem {
    _init(presets, onPick) {
        super._init({activate: false, reactive: false, can_focus: false, style_class: 'openrgb-swatch-row'});
        const box = new St.BoxLayout({style_class: 'openrgb-swatches', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        for (const hex of presets) {
            const color = hexToColor(hex);
            if (color !== null)
                box.add_child(makeSwatch(color, onPick));
        }
        this.add_child(box);
    }
});

const SliderRow = GObject.registerClass(
class SliderRow extends PopupMenu.PopupBaseMenuItem {
    _init(iconName, label, value, onChange) {
        super._init({activate: false, style_class: 'openrgb-slider-row'});
        this.add_child(new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}));
        this.slider = new Slider(value);
        this.slider.x_expand = true;
        this.slider.accessible_name = label;
        this._throttled = throttle(SLIDER_THROTTLE_MS, onChange);
        this._dragging = false;
        this.slider.connect('drag-begin', () => (this._dragging = true));
        this.slider.connect('drag-end', () => (this._dragging = false));
        this._changedId = this.slider.connect('notify::value', () => this._throttled(this.slider.value));
        this.add_child(this.slider);
        this.connect('destroy', () => this._throttled.cancel());
    }

    // Moves the handle without re-triggering the change callback.
    setValue(value) {
        if (this._dragging)
            return;
        this.slider.block_signal_handler(this._changedId);
        this.slider.value = value;
        this.slider.unblock_signal_handler(this._changedId);
    }

    vfunc_key_press_event(event) {
        return this.slider.vfunc_key_press_event(event);
    }
});

// setToggleState() emits 'toggled' in GNOME 50, so syncing a switch to the
// device state must block the handler or it would send the state right back.
function syncSwitch(item, handlerId, state) {
    item.block_signal_handler(handlerId);
    item.setToggleState(state);
    item.unblock_signal_handler(handlerId);
}

// The switch eases its knob into place, and an ease started while the menu is
// hidden never runs. Re-apply the position once the switch is on screen.
// `getItems` is called from the idle so rebuilt menus yield their live items.
function settleSwitches(getItems) {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        for (const item of getItems()) {
            const sw = item?._switch;
            if (sw?.mapped)
                sw.state = sw.state;
        }
        return GLib.SOURCE_REMOVE;
    });
}

function dotStyle(ctrl) {
    if (!L.isOn(ctrl))
        return 'background-color: transparent;';
    const color = L.currentColor(ctrl);
    if (color === null || color === 0)
        return 'background-gradient-direction: horizontal; background-gradient-start: #ff3060; background-gradient-end: #30a0ff;';
    return `background-color: ${colorToHex(color)};`;
}

// Submenu with one device's switch, colors, sliders and modes.
class DeviceSection {
    constructor(service, device, presets) {
        this._service = service;
        this.index = device.index;

        this.item = new PopupMenu.PopupSubMenuMenuItem(device.label, true);
        this.item.icon.icon_name = DEVICE_ICONS[device.ctrl.type] ?? 'preferences-color-symbolic';
        this._dot = new St.Widget({style_class: 'openrgb-dot', y_align: Clutter.ActorAlign.CENTER});
        this.item.insert_child_above(this._dot, this.item.label);
        const menu = this.item.menu;

        this._switch = new PopupMenu.PopupSwitchMenuItem(_('On'), L.isOn(device.ctrl));
        this._switchId = this._switch.connect('toggled', (_i, state) => service.setDeviceOn(this.index, state));
        this._alive = true;
        this.item.connect('destroy', () => (this._alive = false));
        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                settleSwitches(() => (this._alive ? [this._switch] : []));
        });
        menu.addMenuItem(this._switch);

        menu.addMenuItem(new SwatchRow(presets, color => service.setDeviceColor(this.index, color)));

        this._brightness = new SliderRow('display-brightness-symbolic', _('Brightness'), 1,
            v => service.setDeviceBrightness(this.index, v));
        menu.addMenuItem(this._brightness);

        this._speed = new SliderRow('power-profile-performance-symbolic', _('Speed'), 0.5,
            v => service.setDeviceSpeed(this.index, v));
        menu.addMenuItem(this._speed);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Effect')));
        this._modeItems = device.ctrl.modes.map((mode, modeIndex) => {
            const item = new PopupMenu.PopupMenuItem(mode.name);
            item.connect('activate', () => service.setDeviceMode(this.index, modeIndex));
            menu.addMenuItem(item);
            return item;
        });

        this.update(device.ctrl);
    }

    update(ctrl) {
        const on = L.isOn(ctrl);
        syncSwitch(this._switch, this._switchId, on);
        this._dot.style = dotStyle(ctrl);
        this._modeItems.forEach((item, i) =>
            item.setOrnament(i === ctrl.activeMode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT));

        const mode = L.activeMode(ctrl);
        if (L.hasHardwareBrightness(mode))
            this._brightness.setValue((mode.brightness - mode.brightnessMin) / (mode.brightnessMax - mode.brightnessMin));
        this._brightness.visible = on;
        const speed = L.getSpeed(ctrl);
        this._speed.visible = on && speed !== null;
        if (speed !== null)
            this._speed.setValue(speed);
    }
}

// Fills any PopupMenu-like container with the lighting controls.
class LightingMenu {
    constructor(service, menu, {showSwitch}) {
        this._service = service;
        this._menu = menu;
        this._showSwitch = showSwitch;
        this._deviceSections = new Map();
        this._settings = service.settings;

        this._serviceIds = [
            service.connect('state-changed', () => this.sync()),
            service.connect('devices-changed', () => this.rebuild()),
            service.connect('profiles-changed', () => this._buildProfiles()),
            service.connect('device-updated', (_s, index) => this._onDeviceUpdated(index)),
        ];
        this._settingsIds = ['color-presets', 'show-devices'].map(k =>
            this._settings.connect(`changed::${k}`, () => this.rebuild()));

        this._openId = menu.connect('open-state-changed', (_m, open) => {
            if (open)
                settleSwitches(() => (this._destroyed ? [] : [this._switchItem]));
        });

        this.rebuild();
    }

    rebuild() {
        this._menu.removeAll();
        this._deviceSections.clear();
        this._switchItem = null;

        if (this._showSwitch) {
            this._switchItem = new PopupMenu.PopupSwitchMenuItem(_('Lighting'),
                this._service.connected && this._service.isOn,
                {style_class: 'openrgb-master-switch'});
            this._switchId = this._switchItem.connect('toggled', (_i, state) => this._service.setAllOn(state));
            this._menu.addMenuItem(this._switchItem);
        }

        this._offline = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._offline);
        const offlineLabel = new PopupMenu.PopupMenuItem(_('OpenRGB server is not reachable'), {reactive: false});
        offlineLabel.setOrnament(PopupMenu.Ornament.HIDDEN);
        this._offline.addMenuItem(offlineLabel);
        const start = new PopupMenu.PopupImageMenuItem(_('Start OpenRGB Server'), 'system-run-symbolic');
        start.connect('activate', () => this._service.startServer());
        this._offline.addMenuItem(start);

        this._online = new PopupMenu.PopupMenuSection();
        this._menu.addMenuItem(this._online);

        this._profiles = new PopupMenu.PopupMenuSection();
        this._online.addMenuItem(this._profiles);
        this._buildProfiles();

        const presets = this._settings.get_strv('color-presets');
        this._online.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Color')));
        this._online.addMenuItem(new SwatchRow(presets, color => this._service.setAllColor(color)));
        this._online.addMenuItem(new SliderRow('color-select-symbolic', _('Hue'), 0,
            v => this._service.setAllColor(L.hueToColor(v))));
        this._brightnessRow = new SliderRow('display-brightness-symbolic', _('Brightness'),
            this._settings.get_double('brightness'), v => this._service.setAllBrightness(v));
        this._online.addMenuItem(this._brightnessRow);

        if (this._settings.get_boolean('show-devices')) {
            const devices = this._service.devices;
            if (devices.length)
                this._online.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Devices')));
            for (const device of devices) {
                const section = new DeviceSection(this._service, device, presets);
                this._deviceSections.set(device.index, section);
                this._online.addMenuItem(section.item);
            }
        }

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addMenuItem(this._buildFooter());
        this.sync();
    }

    _buildProfiles() {
        this._profiles.removeAll();
        const profiles = this._service.profiles;
        if (!profiles.length)
            return;
        this._profiles.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Profiles')));
        const active = this._service.activeProfile;
        for (const name of profiles) {
            const item = new PopupMenu.PopupMenuItem(name);
            item.setOrnament(name === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => this._service.loadProfile(name));
            this._profiles.addMenuItem(item);
        }
    }

    _buildFooter() {
        const row = new PopupMenu.PopupBaseMenuItem({activate: false, reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'openrgb-footer', x_expand: true, x_align: Clutter.ActorAlign.END});
        const add = (icon, label, fn) => {
            const button = new St.Button({
                style_class: 'icon-button openrgb-footer-button',
                icon_name: icon,
                accessible_name: label,
                can_focus: true,
            });
            button.connect('clicked', () => {
                this._menu.close?.(true);
                fn();
            });
            box.add_child(button);
        };
        add('view-refresh-symbolic', _('Rescan Devices'), () => this._service.rescan());
        add('preferences-color-symbolic', _('Open OpenRGB'), () => {
            const app = Shell.AppSystem.get_default().lookup_app(OPENRGB_APP);
            if (app)
                app.activate();
            else
                Gio.Subprocess.new(['openrgb'], Gio.SubprocessFlags.NONE);
        });
        add('preferences-system-symbolic', _('Settings'), () => this._service.openPreferences());
        row.add_child(box);
        return row;
    }

    _onDeviceUpdated(index) {
        const section = this._deviceSections.get(index);
        const ctrl = this._service.devices.find(d => d.index === index)?.ctrl;
        if (section && ctrl)
            section.update(ctrl);
        this.sync();
    }

    sync() {
        const connected = this._service.connected;
        this._offline.actor.visible = !connected;
        this._online.actor.visible = connected;
        if (this._switchItem) {
            syncSwitch(this._switchItem, this._switchId, connected && this._service.isOn);
            this._switchItem.reactive = connected;
            this._switchItem.setStatus(connected ? this._service.activeProfile || null : null);
        }
        this._brightnessRow?.setValue(this._settings.get_double('brightness'));
        for (const [index, section] of this._deviceSections) {
            const ctrl = this._service.devices.find(d => d.index === index)?.ctrl;
            if (ctrl)
                section.update(ctrl);
        }
    }

    destroy() {
        this._serviceIds.forEach(id => this._service.disconnect(id));
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._destroyed = true;
        this._menu.disconnect(this._openId);
        this._menu.removeAll();
    }
}

function statusText(service) {
    if (!service.connected)
        return _('Server offline');
    if (!service.isOn)
        return _('Off');
    return service.activeProfile || _('On');
}

// ---- Placements -----------------------------------------------------------

const TopBarIndicator = GObject.registerClass(
class TopBarIndicator extends PanelMenu.Button {
    _init(service, gicon) {
        super._init(0.5, _('RGB Lighting'));
        this._service = service;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({gicon, style_class: 'system-status-icon'});
        this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'openrgb-panel-label'});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._lightingMenu = new LightingMenu(service, this.menu, {showSwitch: true});
        this._ids = ['state-changed', 'profiles-changed', 'device-updated'].map(s =>
            service.connect(s, () => this._sync()));
        this._labelId = service.settings.connect('changed::show-profile-label', () => this._sync());
        this._sync();
    }

    _sync() {
        const connected = this._service.connected;
        const on = connected && this._service.isOn;
        this._icon.opacity = on ? 255 : 110;
        const showLabel = this._service.settings.get_boolean('show-profile-label');
        this._label.text = connected ? this._service.activeProfile : '';
        this._label.visible = showLabel && !!this._label.text;
    }

    // Scrolling over the icon adjusts global brightness.
    vfunc_scroll_event(event) {
        const dir = event.get_scroll_direction();
        const step = dir === Clutter.ScrollDirection.UP ? 0.05 : dir === Clutter.ScrollDirection.DOWN ? -0.05 : 0;
        if (!step || !this._service.connected)
            return Clutter.EVENT_PROPAGATE;
        const value = Math.min(1, Math.max(0, this._service.settings.get_double('brightness') + step));
        this._scrollThrottle ??= throttle(SLIDER_THROTTLE_MS, v => this._service.setAllBrightness(v));
        this._service.settings.set_double('brightness', value);
        this._scrollThrottle(value);
        return Clutter.EVENT_STOP;
    }

    destroy() {
        this._scrollThrottle?.cancel();
        this._ids.forEach(id => this._service.disconnect(id));
        this._service.settings.disconnect(this._labelId);
        this._lightingMenu.destroy();
        super.destroy();
    }
});

const LightingToggle = GObject.registerClass(
class LightingToggle extends QuickMenuToggle {
    _init(service, gicon) {
        super._init({title: _('Lighting'), gicon, toggleMode: false});
        this._service = service;
        this._gicon = gicon;
        this.connect('clicked', () => service.toggle());
        this._lightingMenu = new LightingMenu(service, this.menu, {showSwitch: false});
        this._ids = ['state-changed', 'profiles-changed', 'device-updated'].map(s =>
            service.connect(s, () => this._sync()));
        this._sync();
    }

    _sync() {
        const connected = this._service.connected;
        this.checked = connected && this._service.isOn;
        this.subtitle = statusText(this._service);
        this.menu.setHeader(this._gicon, _('RGB Lighting'), this.subtitle);
    }

    destroy() {
        this._ids.forEach(id => this._service.disconnect(id));
        this._lightingMenu.destroy();
        super.destroy();
    }
});

const QuickSettingsIndicator = GObject.registerClass(
class QuickSettingsIndicator extends SystemIndicator {
    _init(service, gicon) {
        super._init();
        this._service = service;
        this._indicator = this._addIndicator();
        this._indicator.gicon = gicon;
        this.quickSettingsItems.push(new LightingToggle(service, gicon));
        this._ids = ['state-changed', 'device-updated'].map(s => service.connect(s, () => this._sync()));
        this._sync();
    }

    _sync() {
        this._indicator.visible = this._service.connected && this._service.isOn;
    }

    destroy() {
        this._ids.forEach(id => this._service.disconnect(id));
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class OpenRGBControlExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._gicon = Gio.icon_new_for_string(`${this.path}/icons/rgb-symbolic.svg`);
        this._service = new LightingService(this);
        this._service.openPreferences = () => this.openPreferences();

        this._positionId = this._settings.connect('changed::indicator-position', () => this._buildUi());
        this._lockId = this._service.connect('lock-changed', () => this._buildUi());
        this._buildUi();

        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('toggle-lighting', this._settings, Meta.KeyBindingFlags.NONE, mode, () => {
            const turningOn = !this._service.isOn;
            this._service.setAllOn(turningOn);
            Main.osdWindowManager.showAll(this._gicon, turningOn ? _('Lighting On') : _('Lighting Off'), null);
        });
        Main.wm.addKeybinding('next-profile', this._settings, Meta.KeyBindingFlags.NONE, mode, () => {
            const next = this._service.nextProfile();
            if (next)
                Main.osdWindowManager.showAll(this._gicon, next, null);
        });
    }

    // The UI is torn down while locked; the service keeps running for lock automation.
    _buildUi() {
        this._destroyUi();
        if (Main.sessionMode.isLocked)
            return;
        if (this._settings.get_string('indicator-position') === 'quick-settings') {
            this._qsIndicator = new QuickSettingsIndicator(this._service, this._gicon);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._qsIndicator);
        } else {
            this._topBar = new TopBarIndicator(this._service, this._gicon);
            Main.panel.addToStatusArea(this.uuid, this._topBar);
        }
    }

    _destroyUi() {
        this._topBar?.destroy();
        this._topBar = null;
        this._qsIndicator?.destroy();
        this._qsIndicator = null;
    }

    disable() {
        Main.wm.removeKeybinding('toggle-lighting');
        Main.wm.removeKeybinding('next-profile');
        this._settings.disconnect(this._positionId);
        this._service.disconnect(this._lockId);
        this._destroyUi();
        this._service.destroy();
        this._service = null;
        this._settings = null;
        this._gicon = null;
    }
}
