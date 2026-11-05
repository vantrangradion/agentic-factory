export type GitHubAnnotationType = 'error' | 'warning' | 'notice';

export interface GitHubAnnotationOptions {
  file: string;
  line?: number;
  col?: number;
  message: string;
}

/**
 * Formats a GitHub Actions workflow command annotation:
 * ::error file={file},line={line},col={col}::{message}
 */
export function formatGitHubAnnotation(
  type: GitHubAnnotationType,
  options: GitHubAnnotationOptions
): string {
  const line = options.line ?? 1;
  const col = options.col ?? 1;
  return `::${type} file=${options.file},line=${line},col=${col}::${options.message}`;
}

