import type { ResolvedAgentConfig } from './config.js';
import type { Issue } from './issue.js';

export type Phase = 'red' | 'green' | 'single';

export interface PromptInput {
  issue: Issue;
  phase: Phase;
  config: ResolvedAgentConfig;
  /** Context files that exist in the repository. */
  contextFiles: string[];
  attempt: number;
  /** What went wrong on the previous attempt, as the loop saw it. */
  feedback?: string;
  /** Test files fixed by the red phase, which the green phase must not edit. */
  lockedTests?: string[];
  /** A person's comments on the previous plan, which this red phase must address. */
  planFeedback?: string;
}

function list(items: readonly string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

/**
 * Builds the agent's prompt. Everything project-specific comes from the
 * config and the repository's own context files, never from this template.
 */
export function buildPrompt(input: PromptInput): string {
  const { issue, phase, config, contextFiles, attempt, feedback, lockedTests, planFeedback } = input;
  const red = config.gates.find((g) => g.name === config.tdd.redGate);
  const sections: string[] = [];

  sections.push(
    `# Task: issue #${issue.number}: ${issue.title}`,
    [
      'You are the coding agent inside an automated software factory.',
      'A loop around you runs the project\'s gates and decides whether your work is accepted.',
      'Work only inside this repository and only on this issue.',
    ].join(' '),
  );

  sections.push(
    '## Read first',
    [
      contextFiles.length > 0
        ? `Read these files before you change anything, and follow them:\n${list(contextFiles)}`
        : 'This repository has no agent context files. Read the README and the code near your change.',
      'Then read the existing code next to the files you will change and copy its patterns, names and test style.',
    ].join('\n\n'),
  );

  sections.push('## The issue', issue.body || '(The issue has no description. Use the title.)');

  if (phase === 'red') {
    sections.push(
      '## This step: write failing tests (red)',
      list([
        'Write tests that check every acceptance criterion in the issue, and the edge cases it implies.',
        'Put them where this project keeps its tests and follow the existing test style.',
        `Change only test files. Files that do not match these patterns will be reverted: ${config.tdd.testFiles.join(', ')}`,
        'Do not write the implementation yet.',
        red
          ? `The loop then runs \`${red.run}\` and expects it to FAIL, because the behaviour does not exist yet. If it passes, your tests do not test anything new.`
          : 'The loop then runs the test gate and expects it to fail.',
      ]),
    );
  } else {
    const gateList = config.gates.map((g, i) => `${i + 1}. ${g.name}: \`${g.run}\``).join('\n');
    sections.push(
      phase === 'green' ? '## This step: make the tests pass (green)' : '## This step: implement the issue',
      [
        phase === 'green'
          ? list([
              'The tests from the previous step check the acceptance criteria. Make them pass with the smallest correct implementation.',
              `Do not edit, delete, skip or weaken these tests. The loop restores them if you do:\n${(lockedTests ?? []).map((t) => `  - ${t}`).join('\n')}`,
              'You may add new tests.',
            ])
          : list(['Write tests for every acceptance criterion, then the implementation.']),
        `The loop runs these gates in order and stops at the first failure:\n${gateList}`,
        'Run them yourself before you finish.',
      ].join('\n\n'),
    );
  }

  sections.push(
    '## Rules',
    list([
      `Never change these paths. The loop reverts any change to them: ${config.protectedPaths.join(', ')}`,
      'Do not run git commit, git push, or create pull requests. The loop commits for you.',
      'Import only packages the project already declares. If you truly need a new one, add it with the project\'s package manager so the lockfile updates, and say why in your summary.',
      'Never guess a package name, function or API. Check that it exists in the installed dependencies or the code first.',
      'Keep the change focused on this issue. Do not refactor unrelated code.',
      'In your reply, name files by their path relative to the repository root, without links or file:// URLs.',
      'Use synthetic test data only. Never add real names, phone numbers, keys or tokens.',
    ]),
  );

  if (planFeedback && phase === 'red') {
    sections.push(
      '## A reviewer rejected your previous plan',
      `Address every point below in the new tests and plan. These comments come from people reviewing the draft pull request:\n\n${planFeedback}`,
    );
  }

  if (feedback) {
    sections.push(`## Your previous attempt failed (this is attempt ${attempt} of ${config.maxAttempts})`, feedback);
  }

  sections.push(
    '## When you finish',
    phase === 'red'
      ? [
          'A person reviews your plan and these tests before any implementation starts. Reply in exactly this format:',
          'Approach: two or three lines on how you will implement the issue',
          'Files to change: one line per file, with what changes',
          'Interfaces: new or changed functions, types, endpoints or screens, or "None"',
          'Edge cases covered by the tests: one line each',
          'Risks and open questions: anything a reviewer should decide, or "None"',
        ].join('\n')
      : [
          'Reply with a short summary in exactly this format:',
          'Summary: one line',
          'Changes: one line per file',
          'Notes: open questions, assumptions, or deviations from the issue, or "None"',
        ].join('\n'),
  );

  return `${sections.join('\n\n')}\n`;
}
