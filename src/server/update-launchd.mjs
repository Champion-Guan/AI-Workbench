import path from 'node:path';
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value);

// Pure configuration generation, never launchctl/install/write a user's plist.
// Pin the independent manager's runtime and entry, not the app's current pointer.
// Upgrading the manager itself requires a separate verified bootstrap operation.
export function updateManagerLaunchAgent({ node, entry, directory, dataRoot, logs, label = 'com.guanaiworkbench.updater' }) {
  if (![node, entry, directory, dataRoot, logs].every(absolute)
    || !entry.endsWith('/scripts/run-update-manager.mjs') || !node.endsWith('/runtime/node')
    || label !== 'com.guanaiworkbench.updater' && !/^com\.guanaiworkbench\.updater\.qa\.[a-f0-9-]{36}$/.test(label)) throw Error('update_launchd_invalid');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>EnvironmentVariables</key><dict><key>GUAN_WORKBENCH_DATA_DIR</key><string>${xml(dataRoot)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'updater.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'updater-error.log'))}</string>
</dict></plist>
`;
}

// Distinct stable user job: restarting/upgrading the manager does not destroy
// service ownership. Generation only, never installs or mutates launchd.
export function updateSupervisorLaunchAgent(options) {
  const label = options.label || 'com.guanaiworkbench.supervisor';
  if (!options.entry?.endsWith('/scripts/run-update-supervisor.mjs')
    || label !== 'com.guanaiworkbench.supervisor' && !/^com\.guanaiworkbench\.supervisor\.qa\.[a-f0-9-]{36}$/.test(label)) throw Error('update_launchd_invalid');
  const managerLabel = label.replace('com.guanaiworkbench.supervisor', 'com.guanaiworkbench.updater');
  return updateManagerLaunchAgent({ ...options, entry: options.entry.replace(/run-update-supervisor\.mjs$/, 'run-update-manager.mjs'), label: managerLabel })
    .replaceAll('run-update-manager.mjs', 'run-update-supervisor.mjs')
    .replaceAll(xml(managerLabel), xml(label))
    .replaceAll('updater.log', 'supervisor.log').replaceAll('updater-error.log', 'supervisor-error.log');
}
