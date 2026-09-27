import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {OpenRGBClient} from './lib/client.js';
import {deviceKey} from './lib/lighting.js';
import {deviceTypeName} from './lib/protocol.js';

const SERVER_UNIT = 'openrgb-server.service';
const DEFAULT_PRESETS = ['#ffffff', '#ff0000', '#ff6a00', '#ffd000', '#00ff3c', '#00e5ff', '#0040ff', '#8a00ff', '#ff00b4'];

// printf-style %s/%d substitution; String.prototype.format isn't guaranteed here.
function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd]/g, () => `${args[i++]}`);
}

function readJson(settings, key) {
    try {
        return JSON.parse(settings.get_string(key));
    } catch {
        return {};
    }
}

function toggleInList(settings, key, value, present) {
    const list = settings.get_strv(key).filter(v => v !== value);
    if (present)
        list.push(value);
    settings.set_strv(key, list);
}

function rgbaToHex(rgba) {
    const c = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

// A preferences group whose rows can be rebuilt as a unit.
class DynamicGroup {
    constructor(params) {
        this.group = new Adw.PreferencesGroup(params);
        this._rows = [];
    }

    add(row) {
        this.group.add(row);
        this._rows.push(row);
        return row;
    }

    clear() {
        this._rows.forEach(r => this.group.remove(r));
        this._rows = [];
    }
}

function systemctl(args) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(['systemctl', '--user', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    resolve({ok: p.get_successful(), out: (stdout ?? '').trim()});
                } catch {
                    resolve({ok: false, out: ''});
                }
            });
        } catch {
            resolve({ok: false, out: ''});
        }
    });
}

export default class OpenRGBControlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._settings = settings;
        this._window = window;
        this._client = new OpenRGBClient('GNOME Extension Settings');
        window.set_default_size(640, 760);
        window.search_enabled = true;

        window.add(this._buildGeneralPage());
        window.add(this._buildProfilesPage());
        window.add(this._buildDevicesPage());
        window.add(this._buildColorsPage());
        window.add(this._buildConnectionPage());

        this._client.connect('state-changed', () => this._refresh());
        this._client.connect('devices-changed', () => this._refresh());
        this._client.connect('profiles-changed', () => this._refresh());
        window.connect('close-request', () => {
            this._client.destroy();
            return false;
        });

        this._refresh();
        this._connect();
    }

    _connect() {
        this._client.open(this._settings.get_string('host'), this._settings.get_int('port'))
            .catch(() => this._refresh());
    }

    _toast(text) {
        this._window.add_toast(new Adw.Toast({title: text, timeout: 3}));
    }

    _refresh() {
        this._refreshProfiles();
        this._refreshDevices();
        this._refreshConnection();
    }

    // ---- General ----------------------------------------------------------

    _buildGeneralPage() {
        const s = this._settings;
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        const placement = new Adw.PreferencesGroup({title: _('Placement')});
        const positions = ['top-bar', 'quick-settings'];
        const position = new Adw.ComboRow({
            title: _('Show Controls In'),
            model: Gtk.StringList.new([_('Top Bar'), _('Quick Settings')]),
            selected: Math.max(0, positions.indexOf(s.get_string('indicator-position'))),
        });
        position.connect('notify::selected', () => s.set_string('indicator-position', positions[position.selected]));
        placement.add(position);

        const label = new Adw.SwitchRow({
            title: _('Show Active Profile Name'),
            subtitle: _('Next to the top bar icon'),
        });
        s.bind('show-profile-label', label, 'active', Gio.SettingsBindFlags.DEFAULT);
        position.bind_property_full('selected', label, 'sensitive', GObject.BindingFlags.SYNC_CREATE,
            (_b, v) => [true, v === 0], null);
        placement.add(label);

        const devices = new Adw.SwitchRow({
            title: _('Per-Device Controls'),
            subtitle: _('List each device with its own switch, colors and effects'),
        });
        s.bind('show-devices', devices, 'active', Gio.SettingsBindFlags.DEFAULT);
        placement.add(devices);
        page.add(placement);

        const auto = new Adw.PreferencesGroup({title: _('Automation')});
        const lock = new Adw.SwitchRow({
            title: _('Turn Off While Locked'),
            subtitle: _('Restores lighting when you unlock'),
        });
        s.bind('off-on-lock', lock, 'active', Gio.SettingsBindFlags.DEFAULT);
        auto.add(lock);
        const suspend = new Adw.SwitchRow({
            title: _('Turn Off During Suspend'),
            subtitle: _('Restores lighting after resume'),
        });
        s.bind('off-on-suspend', suspend, 'active', Gio.SettingsBindFlags.DEFAULT);
        auto.add(suspend);
        page.add(auto);

        const keys = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
            description: GLib.markup_escape_text(_('Use GTK accelerator syntax, e.g. <Super><Shift>l. Leave empty to disable.'), -1),
        });
        keys.add(this._shortcutRow('toggle-lighting', _('Toggle Lighting')));
        keys.add(this._shortcutRow('next-profile', _('Next Profile')));
        page.add(keys);

        const tips = new Adw.PreferencesGroup({title: _('Tips')});
        tips.add(new Adw.ActionRow({
            title: _('Scroll over the top bar icon'),
            subtitle: _('Adjusts brightness for all devices'),
        }));
        page.add(tips);
        return page;
    }

    _shortcutRow(key, title) {
        const row = new Adw.EntryRow({title, show_apply_button: true});
        row.text = this._settings.get_strv(key)[0] ?? '';
        row.connect('apply', () => {
            const text = row.text.trim();
            if (!text) {
                this._settings.set_strv(key, []);
                return;
            }
            const [ok, keyval] = Gtk.accelerator_parse(text);
            if (!ok || !keyval) {
                this._toast(fmt(_('“%s” is not a valid shortcut'), text));
                return;
            }
            this._settings.set_strv(key, [text]);
            this._toast(_('Shortcut saved'));
        });
        return row;
    }

    // ---- Profiles ---------------------------------------------------------

    _buildProfilesPage() {
        const page = new Adw.PreferencesPage({title: _('Profiles'), icon_name: 'view-list-symbolic'});

        this._behavior = new DynamicGroup({
            title: _('Switch Behavior'),
            description: _('Which OpenRGB profile the on/off switch and login use'),
        });
        page.add(this._behavior.group);

        this._profileList = new DynamicGroup({
            title: _('Profiles'),
            description: _('Stored in ~/.config/OpenRGB/profiles'),
        });
        page.add(this._profileList.group);

        const save = new Adw.PreferencesGroup({title: _('Save Current Lighting')});
        const nameRow = new Adw.EntryRow({title: _('New Profile Name'), show_apply_button: true});
        nameRow.connect('apply', () => {
            const name = nameRow.text.trim();
            if (!name || /[/\\]/.test(name)) {
                this._toast(_('Enter a name without slashes'));
                return;
            }
            this._client.saveProfile(name)
                .then(() => {
                    nameRow.text = '';
                    this._toast(fmt(_('Saved “%s”'), name));
                })
                .catch(e => this._toast(e.message));
        });
        save.add(nameRow);
        this._saveGroup = save;
        page.add(save);
        return page;
    }

    _profileCombo(key, title, subtitle, emptyLabel, profiles) {
        const current = this._settings.get_string(key);
        const names = [...profiles];
        if (current && !names.includes(current))
            names.push(current);
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new([emptyLabel, ...names]),
            selected: current ? names.indexOf(current) + 1 : 0,
        });
        row.connect('notify::selected', () =>
            this._settings.set_string(key, row.selected === 0 ? '' : names[row.selected - 1]));
        return row;
    }

    _refreshProfiles() {
        const connected = this._client.connected;
        const profiles = this._client.profiles;

        this._behavior.clear();
        this._behavior.add(this._profileCombo('on-profile', _('When Switched On'), null,
            _('Restore previous state'), profiles));
        this._behavior.add(this._profileCombo('off-profile', _('When Switched Off'), null,
            _('Turn each device off'), profiles));
        this._behavior.add(this._profileCombo('startup-profile', _('At Login'),
            _('Applied once per session'), _('Leave as is'), profiles));

        this._profileList.clear();
        this._saveGroup.sensitive = connected;
        if (!connected) {
            this._profileList.add(new Adw.ActionRow({
                title: _('Not connected'),
                subtitle: _('Start the OpenRGB server to manage profiles'),
            }));
            return;
        }
        if (!profiles.length) {
            this._profileList.add(new Adw.ActionRow({title: _('No profiles yet'),
                subtitle: _('Set up your lighting, then save it below')}));
            return;
        }
        const hidden = new Set(this._settings.get_strv('hidden-profiles'));
        for (const name of profiles) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(name, -1),
                subtitle: name === this._client.activeProfile ? _('Active') : _('Show in menu'),
                active: !hidden.has(name),
            });
            row.connect('notify::active', () =>
                toggleInList(this._settings, 'hidden-profiles', name, !row.active));

            const load = new Gtk.Button({
                icon_name: 'media-playback-start-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Apply'),
                css_classes: ['flat'],
            });
            load.connect('clicked', () => this._client.loadProfile(name).catch(e => this._toast(e.message)));
            row.add_prefix(load);

            const del = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Delete'),
                css_classes: ['flat'],
            });
            del.connect('clicked', () => this._confirmDelete(name));
            row.add_suffix(del);
            this._profileList.add(row);
        }
    }

    _confirmDelete(name) {
        const dialog = new Adw.AlertDialog({
            heading: fmt(_('Delete “%s”?'), name),
            body: _('The profile file will be removed from OpenRGB.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('delete', _('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, response) => {
            if (response === 'delete')
                this._client.deleteProfile(name).catch(e => this._toast(e.message));
        });
        dialog.present(this._window);
    }

    // ---- Devices ----------------------------------------------------------

    _buildDevicesPage() {
        const page = new Adw.PreferencesPage({title: _('Devices'), icon_name: 'input-keyboard-symbolic'});
        this._deviceList = new DynamicGroup({
            title: _('Detected Devices'),
            description: _('Excluded devices are hidden from the menu and skipped by global actions'),
        });
        const rescan = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Rescan Devices'),
            css_classes: ['flat'],
        });
        rescan.connect('clicked', () => {
            this._client.rescan().then(() => this._toast(_('Rescanning…'))).catch(e => this._toast(e.message));
        });
        this._deviceList.group.header_suffix = rescan;
        page.add(this._deviceList.group);
        return page;
    }

    _refreshDevices() {
        this._deviceList.clear();
        if (!this._client.connected) {
            this._deviceList.add(new Adw.ActionRow({title: _('Not connected')}));
            return;
        }
        const excluded = new Set(this._settings.get_strv('excluded-devices'));
        const names = readJson(this._settings, 'device-names');
        const counts = new Map();
        for (const c of this._client.controllers)
            counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
        const seen = new Map();
        for (const ctrl of this._client.controllers) {
            const key = deviceKey(ctrl);
            const n = (seen.get(ctrl.name) ?? 0) + 1;
            seen.set(ctrl.name, n);
            const defaultName = counts.get(ctrl.name) > 1 ? `${ctrl.name} ${n}` : ctrl.name;
            const expander = new Adw.ExpanderRow({
                title: GLib.markup_escape_text(names[key] || defaultName, -1),
                subtitle: GLib.markup_escape_text(
                    [deviceTypeName(ctrl.type), ctrl.vendor, `${ctrl.colors.length} LEDs`].filter(Boolean).join(' · '), -1),
            });

            const include = new Adw.SwitchRow({title: _('Include'), active: !excluded.has(key)});
            include.connect('notify::active', () =>
                toggleInList(this._settings, 'excluded-devices', key, !include.active));
            expander.add_row(include);

            const rename = new Adw.EntryRow({title: _('Display Name'), text: names[key] ?? '', show_apply_button: true});
            rename.connect('apply', () => {
                const map = readJson(this._settings, 'device-names');
                const text = rename.text.trim();
                if (text)
                    map[key] = text;
                else
                    delete map[key];
                this._settings.set_string('device-names', JSON.stringify(map));
                expander.title = GLib.markup_escape_text(text || defaultName, -1);
            });
            expander.add_row(rename);

            expander.add_row(new Adw.ActionRow({
                title: _('Location'),
                subtitle: GLib.markup_escape_text(ctrl.location, -1),
                subtitle_selectable: true,
            }));
            expander.add_row(new Adw.ActionRow({
                title: _('Effects'),
                subtitle: GLib.markup_escape_text(ctrl.modes.map(m => m.name).join(', '), -1),
            }));
            this._deviceList.add(expander);
        }
    }

    // ---- Colors -----------------------------------------------------------

    _buildColorsPage() {
        const page = new Adw.PreferencesPage({title: _('Colors'), icon_name: 'color-select-symbolic'});
        this._colorGroup = new DynamicGroup({
            title: _('Quick Colors'),
            description: _('Swatches shown in the menu'),
        });
        const box = new Gtk.Box({spacing: 6});
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: _('Add Color'), css_classes: ['flat']});
        add.connect('clicked', () => {
            const presets = this._settings.get_strv('color-presets');
            if (presets.length < 14)
                this._settings.set_strv('color-presets', [...presets, '#ffffff']);
        });
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: _('Reset'), css_classes: ['flat']});
        reset.connect('clicked', () => this._settings.set_strv('color-presets', DEFAULT_PRESETS));
        box.append(add);
        box.append(reset);
        this._colorGroup.group.header_suffix = box;
        page.add(this._colorGroup.group);

        this._settings.connect('changed::color-presets', () => this._refreshColors());
        this._refreshColors();
        return page;
    }

    _refreshColors() {
        this._colorGroup.clear();
        const presets = this._settings.get_strv('color-presets');
        presets.forEach((hex, i) => {
            const row = new Adw.ActionRow({title: hex.toUpperCase()});
            const rgba = new Gdk.RGBA();
            rgba.parse(hex);
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                rgba,
                valign: Gtk.Align.CENTER,
            });
            button.connect('notify::rgba', () => {
                const list = this._settings.get_strv('color-presets');
                list[i] = rgbaToHex(button.rgba);
                this._settings.set_strv('color-presets', list);
            });
            row.add_prefix(button);
            row.activatable_widget = button;

            const remove = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Remove'),
            });
            remove.connect('clicked', () => {
                const list = this._settings.get_strv('color-presets');
                list.splice(i, 1);
                this._settings.set_strv('color-presets', list);
            });
            row.add_suffix(remove);
            this._colorGroup.add(row);
        });
    }

    // ---- Connection -------------------------------------------------------

    _buildConnectionPage() {
        const s = this._settings;
        const page = new Adw.PreferencesPage({title: _('Server'), icon_name: 'network-server-symbolic'});

        const status = new Adw.PreferencesGroup({title: _('Status')});
        this._statusRow = new Adw.ActionRow({title: _('OpenRGB Server')});
        this._reconnectButton = new Gtk.Button({label: _('Reconnect'), valign: Gtk.Align.CENTER});
        this._reconnectButton.connect('clicked', () => this._connect());
        this._statusRow.add_suffix(this._reconnectButton);
        status.add(this._statusRow);

        this._serviceRow = new Adw.SwitchRow({
            title: _('Start Server at Login'),
            subtitle: fmt(_('Runs %s as a systemd user service'), SERVER_UNIT),
        });
        this._serviceRow.connect('notify::active', () => this._setServiceEnabled(this._serviceRow.active));
        status.add(this._serviceRow);
        page.add(status);

        const conn = new Adw.PreferencesGroup({title: _('Connection')});
        const host = new Adw.EntryRow({title: _('Host'), text: s.get_string('host'), show_apply_button: true});
        host.connect('apply', () => s.set_string('host', host.text.trim() || '127.0.0.1'));
        conn.add(host);

        const port = Adw.SpinRow.new_with_range(1024, 65535, 1);
        port.title = _('Port');
        s.bind('port', port, 'value', Gio.SettingsBindFlags.DEFAULT);
        conn.add(port);

        const manage = new Adw.SwitchRow({
            title: _('Start Server Automatically'),
            subtitle: _('When the extension cannot reach it'),
        });
        s.bind('manage-server', manage, 'active', Gio.SettingsBindFlags.DEFAULT);
        conn.add(manage);

        const retry = Adw.SpinRow.new_with_range(2, 300, 1);
        retry.title = _('Reconnect Interval');
        retry.subtitle = _('Seconds');
        s.bind('reconnect-interval', retry, 'value', Gio.SettingsBindFlags.DEFAULT);
        conn.add(retry);
        page.add(conn);

        this._refreshService();
        return page;
    }

    _refreshConnection() {
        const c = this._client;
        this._statusRow.subtitle = c.connected
            ? fmt(_('Connected to %s · protocol %d · %d devices'), c.serverName || 'OpenRGB', c.version, c.controllers.length)
            : fmt(_('Not reachable at %s:%d'), this._settings.get_string('host'), this._settings.get_int('port'));
    }

    async _refreshService() {
        const {out} = await systemctl(['is-enabled', SERVER_UNIT]);
        this._updatingService = true;
        this._serviceRow.active = out === 'enabled';
        this._serviceRow.sensitive = out !== '' && out !== 'not-found';
        if (!this._serviceRow.sensitive)
            this._serviceRow.subtitle = fmt(_('%s is not installed'), SERVER_UNIT);
        this._updatingService = false;
    }

    async _setServiceEnabled(enabled) {
        if (this._updatingService)
            return;
        const {ok} = await systemctl([enabled ? 'enable' : 'disable', '--now', SERVER_UNIT]);
        if (!ok)
            this._toast(_('systemctl failed'));
        await this._refreshService();
        if (enabled)
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._connect();
                return GLib.SOURCE_REMOVE;
            });
    }
}
