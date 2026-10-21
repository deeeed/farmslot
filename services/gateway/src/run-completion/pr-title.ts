/** Sentence-case an ordinary leading word while preserving acronyms and identifiers. */
export function lowercaseLeadingTitleWord(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
}
