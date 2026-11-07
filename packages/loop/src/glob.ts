/**
 * Minimal glob matching for repo-relative POSIX paths, so the loop needs no
 * runtime dependencies. Supports `**`, `*`, `?`, and a trailing `/` meaning
 * "everything under this directory".
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.endsWith('/') ? `${glob}**` : glob;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => {
    const re = globToRegExp(g);
    // A bare directory name such as "e2e" also protects everything under it.
    return re.test(normalized) || (!/[*?]/.test(g) && normalized.startsWith(`${g.replace(/\/$/, '')}/`));
  });
}
