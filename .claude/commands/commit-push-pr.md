---
name: commit-push-pr
description: Create a commit message, commit changes, push, and create a PR
---

# Commit, Push, and Create PR

Follow these steps:

## Step 1: Check for Task Context

Get the current branch name and check for a task file:
```bash
BRANCH=$(git branch --show-current)
```

If branch matches `GRD-XXX-*` pattern, read `.claude/tasks/GRD-XXX.md` to get:
- Original description (intent)
- Acceptance criteria (planned outcomes)

## Step 2: Review Changes

```bash
git status
git diff
```
Show what files changed and summarize the actual implementation.

## Step 3: Create Commit Message

Based on the changes, write a commit message:
- Use present tense ("Add feature" not "Added feature")
- First line: Brief summary (50 chars max)
- Blank line
- Detailed explanation if needed
- Include "Resolves GRD-XXX" if applicable
- Do NOT include any Co-Authored-By lines

## Step 4: Commit and Push

```bash
git add .
git commit -m "<your-generated-message>"
git push origin <current-branch>
```

## Step 5: Create Pull Request

PR title format: `GRD-XXX: Brief description`

PR body structure:
```markdown
## Summary
Brief description of what was implemented.

## Intent vs Reality

### Original Task (from Jira)
<Copy the description from the task file>

### What Was Actually Done
<Summary of actual implementation>

### Acceptance Criteria Status
- [x] Criteria 1 - completed
- [x] Criteria 2 - completed
- [ ] Criteria 3 - not done (reason)

## Changes Made
- List of key changes
- Files modified

## Testing Done
- How it was tested
```

Create the PR:
```bash
gh pr create --title "GRD-XXX: <description>" --body "<PR-body>" --base main
```

## Step 6: Cleanup Task File

After PR is created successfully, delete the task context file:
```bash
rm .claude/tasks/GRD-XXX.md
git add .claude/tasks/
git commit -m "Remove task file for GRD-XXX after PR created"
git push
```

Report the PR URL to the user.

Wait for my approval before executing git commands.