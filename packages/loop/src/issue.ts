export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url?: string;
}

/** Accepts the output of `gh issue view <n> --json number,title,body,labels,url`. */
export function parseIssue(json: unknown): Issue {
  const o = (json ?? {}) as Record<string, unknown>;
  const number = Number(o['number']);
  if (!Number.isInteger(number) || number <= 0) throw new Error('Issue JSON has no valid "number"');
  const labels = Array.isArray(o['labels'])
    ? (o['labels'] as unknown[]).map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>)?.['name'] ?? ''))).filter(Boolean)
    : [];
  return {
    number,
    title: String(o['title'] ?? '').trim(),
    body: String(o['body'] ?? '').trim(),
    labels,
    ...(typeof o['url'] === 'string' ? { url: o['url'] } : {}),
  };
}
