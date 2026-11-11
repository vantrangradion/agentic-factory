import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * Agents link files with absolute local URLs (file:///home/.../repo/src/a.ts#L1),
 * and gate output prints absolute paths. Those leak the machine's paths into
 * public pull requests and do not resolve on GitHub, so paths under any of
 * `roots` become repository-relative, and the rest of the home folder becomes `~`.
 */
export function localPathsToRelative(text: string, roots: string | readonly string[], home: string = os.homedir()): string {
  let out = text;
  // A tool may print the real path behind a symlink (macOS: /var is /private/var), so check both; longest first.
  const all = [roots].flat().flatMap((r) => [r, realPath(r)]).map((r) => r.replace(/\/$/, '')).filter(Boolean);
  for (const root of [...new Set(all)].sort((a, b) => b.length - a.length)) {
    const rel = (target: string): string => target.replace(/^file:\/\//, '').split(root + '/').join('').replace(/#.*$/, '');
    out = out
      .replace(/\[([^\]]+)\]\((file:\/\/[^)\s]+)\)/g, (m, label: string, target: string) => {
        if (!target.startsWith(`file://${root}/`)) return m;
        const file = rel(target);
        const name = label.replace(/^`|`$/g, '');
        return name === file || file.endsWith(`/${name}`) ? `\`${file}\`` : `${label} (\`${file}\`)`;
      })
      .split(`file://${root}/`).join('')
      .split(`${root}/`).join('');
  }
  const h = home.replace(/\/$/, '');
  return h.length > 1 ? out.split(`${h}/`).join('~/') : out;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
