/** `unsavedDrafts`: edits on this device that signing out deletes (ADR-009 Amendment 1). */
export function accountSignOutConfirmation(app: string, unsavedDrafts = 0) {
  return {
    title: `Sign out of ${app}?`,
    message: "You'll need your token to sign back in.",
    drafts:
      unsavedDrafts > 0
        ? `${unsavedDrafts} unsaved ${unsavedDrafts === 1 ? 'edit' : 'edits'} on this device will be deleted.`
        : '',
    cancel: 'Cancel',
    confirm: 'Sign out',
  } as const;
}

export async function confirmAccountSignOut(
  confirm: () => Promise<boolean>,
  signOut: () => Promise<void>,
): Promise<void> {
  if (await confirm()) await signOut();
}
