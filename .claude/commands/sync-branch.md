---
name: sync-branch
description: Sync branch with remote (pull then push)
---

# Sync Branch

Follow these steps:

1. **Check Current State**
```bash
   git status
   git branch --show-current
```
   Verify current branch and check for uncommitted changes.

2. **Pull Latest Changes**
   If there are uncommitted changes, warn me before proceeding.
```bash
   git fetch origin
   git pull origin <current-branch>
```
   Handle any merge conflicts if they occur.

3. **Push Local Changes**
```bash
   git push origin <current-branch>
```

4. **Report Status**
   Confirm sync is complete and show the current state.

Wait for my approval before executing git commands if there are uncommitted changes or conflicts.
