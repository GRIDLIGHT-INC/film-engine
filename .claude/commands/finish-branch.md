---
name: finish-branch
description: Checkout to dev and delete the current working branch
---

# Finish Branch

Clean up after completing work on a feature branch by checking out to dev and deleting the working branch.

## Step 1: Check Current State

```bash
git branch --show-current
git status
```

- Store the current branch name (this is the branch to delete)
- If already on `dev` or `main`, inform the user there's no working branch to clean up and stop
- If there are uncommitted changes, warn the user and ask if they want to:
  1. Stash changes before proceeding
  2. Discard changes (git checkout -- .)
  3. Cancel the operation

## Step 2: Checkout to Dev

```bash
git checkout dev
git pull origin dev
```

Update dev to ensure it's current with remote.

## Step 3: Delete the Working Branch

Delete the local branch that was checked out from:

```bash
git branch -d <previous-branch-name>
```

If the branch has unmerged changes, warn the user and ask if they want to:
1. Force delete with `git branch -D <branch>` (lose unmerged changes)
2. Cancel and keep the branch

## Step 4: Optionally Delete Remote Branch

Ask the user if they also want to delete the remote branch:

```bash
git push origin --delete <previous-branch-name>
```

Only offer this if the remote branch exists:
```bash
git ls-remote --heads origin <previous-branch-name>
```

## Step 5: Confirm Cleanup

Show final status:

```bash
git branch --show-current
git branch -a | grep -i "<previous-branch-pattern>" || echo "Branch fully cleaned up"
```

Report:
- Current branch (should be dev)
- Confirmation that the working branch was deleted
- Whether remote branch was also deleted (if applicable)
