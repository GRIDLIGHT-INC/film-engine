---
name: check-merge
description: Check diff and potential conflicts between current branch and dev
---

# Check Merge Conflicts

Follow these steps:

1. **Identify Branches**
```bash
   git branch --show-current
   git fetch origin dev
```
   Show me the current branch name.

2. **Check Divergence**
```bash
   git log --oneline dev..HEAD
   git log --oneline HEAD..origin/dev
```
   Show commits that are:
   - On current branch but not in dev (your changes)
   - On dev but not in current branch (incoming changes)

3. **Show File Diff**
```bash
   git diff origin/dev...HEAD --stat
```
   Show which files differ between branches.

4. **Check for Potential Conflicts**
```bash
   git diff origin/dev...HEAD --name-only
```
   List files that have been modified in both branches:
```bash
   git diff origin/dev --name-only
```

5. **Dry Run Merge**
```bash
   git merge origin/dev --no-commit --no-ff
```
   Attempt merge without committing to detect conflicts.

6. **Abort Test Merge**
```bash
   git merge --abort
```
   Clean up after the test merge.

7. **Report Results**
   Summarize:
   - Number of commits ahead/behind dev
   - Files that will change
   - Any conflicts detected
   - Recommendation (safe to merge or needs attention)
