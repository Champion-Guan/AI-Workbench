export function stableReleaseNotes(source, version) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 256 * 1024 || !/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Invalid release notes');
  const sections = source.split(/^## /m).slice(1);
  const selected = sections.filter(section => section.startsWith(version + ' — '));
  if (selected.length !== 1) throw Error('Version-specific release notes required');
  const body = selected[0].slice(selected[0].indexOf('\n') + 1).trim();
  if (!body || body.length > 16384) throw Error('Invalid release notes body');
  return body;
}
