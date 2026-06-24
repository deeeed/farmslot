// Clear index flags left by fixture sync without using xargs, so tracked paths
// containing spaces are preserved and any per-path update failure propagates.
export const CLEAR_INDEX_FLAGS_COMMAND = `paths=$(git -c core.quotePath=false ls-files -v | awk '/^[hsmrckS] / { print substr($0, 3) }'); flag_status=0; if [ -n "$paths" ]; then printf '%s\\n' "$paths" | while IFS= read -r path; do [ -n "$path" ] || continue; git update-index --no-skip-worktree -- "$path" || exit $?; done || flag_status=$?; if [ "$flag_status" -eq 0 ]; then printf '%s\\n' "$paths" | while IFS= read -r path; do [ -n "$path" ] || continue; git update-index --no-assume-unchanged -- "$path" || exit $?; done || flag_status=$?; fi; fi; [ "$flag_status" -eq 0 ]`;

// Drop stale git index locks only when lsof is present and no process still
// owns the lock; if ownership cannot be checked, leave the lock for git to
// report instead of deleting a potentially live lock.
export const REFRESH_INDEX_AND_UNLOCK_COMMAND = `index_lock=$(git rev-parse --git-path index.lock 2>/dev/null || echo .git/index.lock); if [ -f "$index_lock" ]; then now=$(date +%s); mtime=$(stat -f %m "$index_lock" 2>/dev/null || stat -c %Y "$index_lock" 2>/dev/null || echo "$now"); if [ $((now - mtime)) -gt 30 ] && command -v lsof >/dev/null 2>&1 && ! lsof "$index_lock" >/dev/null 2>&1; then rm -f "$index_lock"; fi; fi; git update-index --refresh -q || true`;

// `git fetch --prune` can leave per-ref lock files under refs/remotes/origin
// after an interrupted refresh. Clear only old, unowned locks; otherwise leave
// them for git to report so a live fetch is never disturbed.
export const REFRESH_REMOTE_REF_LOCKS_COMMAND = `now=$(date +%s); cleanup_git_lock() { lock="$1"; [ -f "$lock" ] || return 0; mtime=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo "$now"); if [ $((now - mtime)) -gt 30 ] && command -v lsof >/dev/null 2>&1 && ! lsof "$lock" >/dev/null 2>&1; then rm -f "$lock"; fi; }; remote_refs_dir=$(git rev-parse --git-path refs/remotes/origin 2>/dev/null || echo .git/refs/remotes/origin); if [ -d "$remote_refs_dir" ]; then find "$remote_refs_dir" -type f -name '*.lock' -print | while IFS= read -r lock; do cleanup_git_lock "$lock"; done; fi; packed_refs_lock=$(git rev-parse --git-path packed-refs.lock 2>/dev/null || echo .git/packed-refs.lock); cleanup_git_lock "$packed_refs_lock"`;

// Same-branch prepares should still refresh/unlock after flag-sweep failures,
// but the final exit status must preserve the flag-sweep failure.
export const CLEAR_INDEX_FLAGS_THEN_REFRESH_COMMAND = `flag_status=0; ${CLEAR_INDEX_FLAGS_COMMAND} || flag_status=$?; ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; exit $flag_status`;
