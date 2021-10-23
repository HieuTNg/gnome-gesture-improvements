import Gio from '@gi-types/gio';

function getShellSettings() {
	return new Gio.Settings({schema_id: 'org.gnome.shell'});
}

export function CanEnableMinimizeGesture() {
	const extensionsWhichCanMinimizeToBottom = [
		'dash-to-dock@micxgx.gmail.com',
		'dash-to-panel@jderose9.github.com',
		'window-list@gnome-shell-extensions.gcampax.github.com',
	];

	const shellSettings = getShellSettings();
	const enabledExtensionsIds = shellSettings.get_strv('enabled-extensions');
	return enabledExtensionsIds.some(extensionId => extensionsWhichCanMinimizeToBottom.includes(extensionId));
}