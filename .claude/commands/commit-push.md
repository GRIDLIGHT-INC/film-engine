---
name: commit-push-pr
description: Create a commit message, commit changes, push, and create a PR
---

# Commit, Push, and Create PR

Follow these steps:

1. **Review Changes**
```bash
   git status
   git diff
```
   Show me what files changed and a summary of the changes.

2. **Create Commit Message**
   Based on the changes, write a commit message following our format:
   - Use present tense ("Add feature" not "Added feature")
   - First line: Brief summary (50 chars max)
   - Blank line
   - Detailed explanation if needed
   - Include "Resolves #<issue-number>" if applicable
   - Do NOT include any Co-Authored-By lines

3. **Commit Changes**
```bash
   git add .
   git commit -m "<your-generated-message>"
```

4. **Push to Remote**
```bash
   git push origin <current-branch>
```

Wait for my approval before executing git commands.