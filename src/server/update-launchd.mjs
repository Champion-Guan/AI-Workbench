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
