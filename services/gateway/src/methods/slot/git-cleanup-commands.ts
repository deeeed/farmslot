// Clear index flags left by fixture sync without using xargs, so tracked paths
// containing spaces are preserved and any per-path update failure propagates.
export const CLEAR_INDEX_FLAGS_COMMAND = `paths=$(git -c core.quotePath=false ls-files -v | awk '/^[hsmrckS] / { print substr($0, 3) }'); flag_status=0; if [ -n "$paths" ]; then printf '%s\\n' "$paths" | while IFS= read -r path; do [ -n "$path" ] || continue; git update-index --no-skip-worktree -- "$path" || exit $?; done || flag_status=$?; if [ "$flag_status" -eq 0 ]; then printf '%s\\n' "$paths" | while IFS= read -r path; do [ -n "$path" ] || continue; git update-index --no-assume-unchanged -- "$path" || exit $?; done || flag_status=$?; fi; fi; [ "$flag_status" -eq 0 ]`;

// Drop stale git index locks only when lsof is present and no process still
// owns the lock; if ownership cannot be checked, leave the lock for git to
// report instead of deleting a potentially live lock.
export const REFRESH_INDEX_AND_UNLOCK_COMMAND = `index_lock=$(git rev-parse --git-path index.lock 2>/dev/null || echo .git/index.lock); if [ -f "$index_lock" ]; then now=$(date +%s); mtime=$(stat -f %m "$index_lock" 2>/dev/null) || mtime=$(stat -c %Y "$index_lock" 2>/dev/null || echo "$now"); if [ $((now - mtime)) -gt 30 ] && command -v lsof >/dev/null 2>&1 && ! lsof "$index_lock" >/dev/null 2>&1; then rm -f "$index_lock"; fi; fi; git update-index --refresh -q || true`;

// `git fetch --prune` can leave per-ref lock files under refs/remotes/origin
// after an interrupted refresh. Clear only old, unowned locks; otherwise leave
// them for git to report so a live fetch is never disturbed.
export const REFRESH_REMOTE_REF_LOCKS_COMMAND = `now=$(date +%s); cleanup_git_lock() { lock="$1"; [ -f "$lock" ] || return 0; mtime=$(stat -f %m "$lock" 2>/dev/null) || mtime=$(stat -c %Y "$lock" 2>/dev/null || echo "$now"); if [ $((now - mtime)) -gt 30 ] && command -v lsof >/dev/null 2>&1 && ! lsof "$lock" >/dev/null 2>&1; then rm -f "$lock"; fi; }; remote_refs_dir=$(git rev-parse --git-path refs/remotes/origin 2>/dev/null || echo .git/refs/remotes/origin); if [ -d "$remote_refs_dir" ]; then find "$remote_refs_dir" -type f -name '*.lock' -print | while IFS= read -r lock; do cleanup_git_lock "$lock"; done; fi; packed_refs_lock=$(git rev-parse --git-path packed-refs.lock 2>/dev/null || echo .git/packed-refs.lock); cleanup_git_lock "$packed_refs_lock"`;

// A fetch killed mid-transfer (its timeout's SIGKILL, a dropped ssh link) leaves
// objects/pack/tmp_pack_* behind, and git only prunes them in a gc the farm rarely
// runs: one slot had 3.55 GiB of them. Remove those untouched for an hour that no
// process holds open. Without lsof, ownership can't be checked, so nothing is removed.
// It never fails the command it precedes.
export const REMOVE_STALE_TMP_PACKS_COMMAND = `pack_dir=$(git rev-parse --git-path objects/pack 2>/dev/null) && pack_dir=$(cd "$pack_dir" 2>/dev/null && pwd -P) && if command -v lsof >/dev/null 2>&1; then open_packs=$(lsof -Fn +d "$pack_dir" 2>/dev/null | sed -n 's/^n//p'); find "$pack_dir" -maxdepth 1 -type f \\( -name 'tmp_pack_*' -o -name 'tmp_idx_*' \\) -mmin +60 -print | while IFS= read -r tmp_pack; do case "\n$open_packs\n" in *"\n$tmp_pack\n"*) ;; *) rm -f "$tmp_pack" ;; esac; done; fi; true`;

// Git's auto-maintenance (`gc --auto`, `maintenance run --auto --detach`) starts in the background
// after a fetch. Farm commands already pass gc.auto=0 and maintenance.auto=false through
// withFarmGitConfig, but git run by a worker in the slot doesn't, and on mini-mm-3 that ran 8+
// concurrent cruft repacks (load 29), each one killed leaving tmp packs. So the slot repo's own
// config turns it off, and any `git maintenance register` schedule for the repo is dropped. It reads
// the repo-local value first (the farm's env override would hide it), so a set slot writes nothing.
export const DISABLE_AUTO_MAINTENANCE_COMMAND = `[ "$(git config --local --get maintenance.auto)" = false ] || git config --local maintenance.auto false; [ "$(git config --local --get gc.auto)" = 0 ] || git config --local gc.auto 0; maintained_repo=$(git rev-parse --show-toplevel 2>/dev/null) && git config --global --get-all maintenance.repo 2>/dev/null | grep -qxF "$maintained_repo" && git maintenance unregister 2>/dev/null; true`;

/** Prepare's first fetch: git's own auto-maintenance off, then stale temporary packs. */
export const FETCH_MAINTENANCE_COMMAND = `${DISABLE_AUTO_MAINTENANCE_COMMAND}; ${REMOVE_STALE_TMP_PACKS_COMMAND}`;

/** Before a fetch: stale remote ref locks, git's own auto-maintenance off, stale temporary packs. */
export const PRE_FETCH_CLEANUP_COMMAND = `${REFRESH_REMOTE_REF_LOCKS_COMMAND}; ${FETCH_MAINTENANCE_COMMAND}`;

// Same-branch prepares should still refresh/unlock after flag-sweep failures,
// but the final exit status must preserve the flag-sweep failure.
export const CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND = `flag_status=0; ${CLEAR_INDEX_FLAGS_COMMAND} || flag_status=$?; ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; exit $flag_status`;

/**
 * `git branch -D <branch>` then `git checkout -b <branch> <base>` as one guarded mutation, from
 * the clean default branch (so no second checkout of it): the branch recreated at `base`, with no
 * config left from the older one. When another worktree holds `<branch>`, `branch -D` refuses,
 * keeping the branch and its config, and nothing else runs.
 */
export function recreateBranchCommand(
  branch: string,
  base: string,
  quote: (value: string) => string,
): string {
  return `git branch -D ${quote(branch)} && git checkout -b ${quote(branch)} ${quote(base)}`;
}
