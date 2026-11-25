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

/** Prefix of the one-line notes the fetch maintenance commands print; see {@link gitMaintenanceNotes}. */
export const GIT_MAINTENANCE_NOTE = 'farmslot-git-maintenance:';

/** Prefix of expected-state lines that stay in the command output only. */
const GIT_MAINTENANCE_DEBUG = 'farmslot-git-maintenance-debug:';

// A killed fetch or repack leaves objects/pack/tmp_{pack,idx,rev}_* behind, and git prunes them
// only in a gc. Candidates are files untouched for an hour; lsof runs only when there are any.
// It fails closed: a candidate is removed only when lsof's own listing names the pack directory
// (held as the listing shell's cwd, which proves lsof ran and spells the path the same way), its
// status is 0 or 1, and no process holds that file. It never fails the command it precedes.
export const REMOVE_STALE_TMP_PACKS_COMMAND = `pack_dir=$(git rev-parse --git-path objects/pack 2>/dev/null) && pack_dir=$(cd "$pack_dir" 2>/dev/null && pwd -P) && stale_packs=$(find "$pack_dir" -maxdepth 1 -type f \\( -name 'tmp_pack_*' -o -name 'tmp_idx_*' -o -name 'tmp_rev_*' \\) -mmin +60 -print 2>/dev/null) && [ -n "$stale_packs" ] && if ! command -v lsof >/dev/null 2>&1; then echo "${GIT_MAINTENANCE_NOTE} kept stale tmp packs: lsof is not available"; else open_files=$(cd "$pack_dir" && lsof -Fn +d "$pack_dir" 2>/dev/null; echo "lsof-status=$?"); lsof_status=$(printf '%s\\n' "$open_files" | sed -n 's/^lsof-status=//p'); if { [ "$lsof_status" != 0 ] && [ "$lsof_status" != 1 ]; } || ! printf '%s\\n' "$open_files" | grep -qxF "n$pack_dir"; then echo "${GIT_MAINTENANCE_NOTE} kept stale tmp packs: the open-file check did not complete"; else removed=$({ printf '%s\\n' "$open_files"; echo '--stale--'; printf '%s\\n' "$stale_packs"; } | awk 'seen { if (!($0 in held)) print; next } $0 == "--stale--" { seen = 1; next } substr($0, 1, 1) == "n" { held[substr($0, 2)] = 1 }' | while IFS= read -r tmp_pack; do rm -f "$tmp_pack" && echo removed; done | wc -l | tr -d ' '); if [ "$removed" = 1 ]; then echo "${GIT_MAINTENANCE_NOTE} removed 1 stale tmp pack"; elif [ "$removed" -gt 1 ]; then echo "${GIT_MAINTENANCE_NOTE} removed $removed stale tmp packs"; fi; fi; fi; true`;

// Farm commands pass gc.auto=0 and maintenance.auto=false through withFarmGitConfig, but git a
// worker runs in the slot doesn't, so its auto-maintenance can start background repacks. The slot
// repo's own config turns it off and drops any `git maintenance register` schedule for it. It
// reads the repo-local value first, so a slot already set writes nothing. A linked worktree shares
// its config with every worktree of that repository (the farm checkout, for one), so its config is
// left as it is; that expected state prints only a debug line, which no caller surfaces.
export const DISABLE_AUTO_MAINTENANCE_COMMAND = `repo_paths=$(git rev-parse --git-dir --git-common-dir --show-toplevel 2>/dev/null) && git_dir=$(cd "$(printf '%s\\n' "$repo_paths" | sed -n 1p)" 2>/dev/null && pwd -P) && common_dir=$(cd "$(printf '%s\\n' "$repo_paths" | sed -n 2p)" 2>/dev/null && pwd -P) && maintained_repo=$(printf '%s\\n' "$repo_paths" | sed -n 3p) && if [ "$git_dir" != "$common_dir" ]; then echo "${GIT_MAINTENANCE_DEBUG} config left unchanged: this linked worktree shares it with $common_dir"; else [ "$(git config --local --get maintenance.auto)" = false ] || git config --local maintenance.auto false 2>/dev/null || echo "${GIT_MAINTENANCE_NOTE} could not set maintenance.auto=false"; [ "$(git config --local --get gc.auto)" = 0 ] || git config --local gc.auto 0 2>/dev/null || echo "${GIT_MAINTENANCE_NOTE} could not set gc.auto=0"; git config --global --get-all maintenance.repo 2>/dev/null | grep -qxF "$maintained_repo" && { git maintenance unregister 2>/dev/null || echo "${GIT_MAINTENANCE_NOTE} could not unregister git maintenance for $maintained_repo"; }; fi; true`;

/**
 * Prepare's fetches that start a branch refresh (current branch, default branch, both replay
 * fetches): git's own auto-maintenance off, then stale temporary packs. Most later fetches in the
 * same prepare follow one of these; a replay whose branch is already on origin skips the replay
 * base fetch, so its integration fetch can run without one.
 */
export const FETCH_MAINTENANCE_COMMAND = `${DISABLE_AUTO_MAINTENANCE_COMMAND}; ${REMOVE_STALE_TMP_PACKS_COMMAND}`;

/** Before a fetch: stale remote ref locks, git's own auto-maintenance off, stale temporary packs. */
export const PRE_FETCH_CLEANUP_COMMAND = `${REFRESH_REMOTE_REF_LOCKS_COMMAND}; ${FETCH_MAINTENANCE_COMMAND}`;

/** The notes a fetch maintenance command printed: kept or removed packs, a failed config write. */
export function gitMaintenanceNotes(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith(GIT_MAINTENANCE_NOTE))
    .map((line) => line.slice(GIT_MAINTENANCE_NOTE.length).trim());
}

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
