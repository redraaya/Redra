/** Shorten an absolute path for display: the home dir prefix becomes «~». */
export function tildify(absPath: string, homeDir: string): string {
  if (homeDir.length === 0) return absPath;
  const home = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
  if (absPath === home) return '~';
  if (absPath.startsWith(home + '/')) return '~' + absPath.slice(home.length);
  return absPath;
}
