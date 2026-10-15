export function accountSignOutConfirmation(app: string) {
  return {
    title: `Sign out of ${app}?`,
    message: "You'll need your token to sign back in.",
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
