/**
 * Which source files adapt third-party code, read from `THIRD-PARTY-NOTICES`,
 * and which of their comments is the third-party legal comment. Shared by
 * `check-comments.ts` (which accepts that comment) and `check-dist-notices.ts`
 * (which checks that `dist` keeps it).
 */

/**
 * The repository-relative source paths `THIRD-PARTY-NOTICES` names, such as
 * `src/agents/driver/codex-sdk-exec.ts`. A path inside another one (the
 * upstream `sdk/typescript/src/exec.ts`) is not a match.
 *
 * @param notices - The text of `THIRD-PARTY-NOTICES`.
 * @returns The paths, each once, in order.
 */
export function noticedSourceFiles(notices: string): string[] {
  return [...new Set(notices.match(/(?<![\w/.-])src\/[\w./-]+\.ts\b/g) ?? [])];
}

/**
 * Whether a comment is the third-party legal comment of a file: a `/*!`
 * comment at the very start of a file that `THIRD-PARTY-NOTICES` names.
 *
 * @param file - The file's repository-relative path.
 * @param comment - The comment's text and offset in the file.
 * @param noticed - The paths from {@link noticedSourceFiles}.
 * @returns `true` only for that leading comment of a named file.
 */
export function isThirdPartyLegalComment(
  file: string,
  comment: { text: string; start: number },
  noticed: readonly string[],
): boolean {
  return (
    comment.start === 0 &&
    comment.text.startsWith("/*!") &&
    noticed.includes(file)
  );
}
