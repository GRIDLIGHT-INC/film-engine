---
name: list-risks
description: View all tagged risks in the codebase, select which to fix, and remove tags after fixing
---

# List Risks

View all HIGH-RISK and MINOR-RISK tags in the codebase, choose which to fix, and clean up after.

## Step 1: Discover All Risk Tags

Search all source files for risk markers:

```bash
grep -rn "HIGH-RISK-UNREVIEWED\|MINOR-RISK-UNREVIEWED\|HIGH-RISK-REVIEWED\|MINOR-RISK-REVIEWED" --include="*.rs" --include="*.py" --include="*.js" --include="*.ts" --include="*.tsx" --include="*.go" --include="*.java" --include="*.tf" .
```

If no tags found, report "No risk tags in the codebase" and exit.

## Step 2: Classify and Present Dashboard

For each tagged function, read the surrounding code to determine:
- Function name
- File and line number
- Risk level (HIGH or MINOR)
- Status (UNREVIEWED or REVIEWED)
- Category (SQL Injection, Auth, Input Handling, Crypto, etc.)

Present:

```
## Risk Dashboard

### HIGH Risk (must fix)
| # | Function             | File:Line            | Category         | Status     |
|---|----------------------|----------------------|------------------|------------|
| 1 | extract_table_data   | db_connectors.rs:98  | SQL Injection    | UNREVIEWED |
| 2 | store_relationship   | neo4j.rs:709         | Cypher Injection | UNREVIEWED |

### MINOR Risk (should fix)
| # | Function             | File:Line            | Category         | Status     |
|---|----------------------|----------------------|------------------|------------|
| 3 | neon_query           | handlers.rs:4868     | Input Handling   | UNREVIEWED |
| 4 | train                | handlers.rs:3055     | Input Handling   | UNREVIEWED |

**Summary:**
- HIGH unreviewed: X
- MINOR unreviewed: Y
- Total tags: Z
```

## Step 3: Prompt User for Action

Use AskUserQuestion:
- **Question:** "What would you like to do?"
- **Header:** "Action"
- **Options:**
  1. **Fix all HIGH risks** — Fix all HIGH-tagged vulnerabilities and remove their tags
  2. **Fix all risks (HIGH + MINOR)** — Fix everything and remove all tags
  3. **Pick specific functions** — Choose which functions to fix
  4. **Just viewing** — No changes, just wanted the dashboard

### If "Pick specific functions"

Use AskUserQuestion with multiSelect:
- **Question:** "Which functions should be fixed? (select all that apply)"
- **Header:** "Functions"
- **Options:** List up to 4 tagged functions by name, user can type additional
- **multiSelect:** true

## Step 4: Apply Fixes (if user chose to fix)

For each selected function, read the full function body and apply the appropriate fix:

### SQL Injection
- Sanitize dynamic table/column names: strip non-alphanumeric/underscore chars, wrap in double quotes
- Use parameterized queries (`$1`, `$2`) for dynamic values
- Validate LIMIT/OFFSET as integers

### Cypher Injection
- Sanitize dynamic relationship types: strip non-alphanumeric/underscore, uppercase
- Validate against known types where possible

### Command Injection
- Use argument arrays instead of shell expansion
- Validate/sanitize user input before passing to commands

### Auth Weakness
- Add constant-time comparison where needed
- Ensure all endpoints have auth checks
- Sanitize error responses

### Input Handling
- Add validation for required fields
- Validate content types, sizes, formats
- Sanitize before passing to downstream systems

### General Rules
- Keep fixes minimal — don't refactor beyond what's needed
- Add `// SEC: <description>` comments explaining each security fix
- Preserve existing behavior for valid inputs

## Step 5: Verify Fixes

After applying all fixes:

```bash
# Rust
cargo check 2>&1
cargo clippy -- -D warnings 2>&1
cargo test 2>&1

# JS/TS (if applicable)
npx tsc --noEmit 2>/dev/null
npm run lint -- --quiet 2>/dev/null

# Python (if applicable)
ruff check . 2>/dev/null
```

All checks must pass. Fix any issues that arise.

## Step 6: Remove Tags for Fixed Functions

For each function that was successfully fixed and verified:
- Delete the risk marker line entirely (no blank line left behind)
- Keep the `// SEC:` comments that were added during fixes

Verify removal:
```bash
grep -rn "RISK-UNREVIEWED" --include="*.rs" --include="*.py" --include="*.js" --include="*.ts" .
```

Report any tags that could NOT be removed (couldn't fully fix the function).

## Step 7: Report

```
## Fix Report

### Fixed
| # | Function           | File               | Issue            | Fix Applied        |
|---|--------------------|---------------------|------------------|--------------------|
| 1 | extract_table_data | db_connectors.rs    | SQL Injection    | Sanitized names    |
| 2 | store_relationship | neo4j.rs            | Cypher Injection | Sanitized types    |

### Still Tagged (couldn't fix or user skipped)
| # | Risk  | Function   | File:Line         | Reason             |
|---|-------|------------|-------------------|--------------------|
| 1 | MINOR | neon_query | handlers.rs:4868  | User skipped       |

### Summary
- Fixed: X functions
- Tags removed: Y
- Tags remaining: Z
- All checks passing: ✅ / ❌
```

---

## Notes

- Risk tags are placed by `/code-review`
- This command is for revisiting and fixing risks you skipped earlier
- The `/commit-push` command checks for remaining risk tags in its pre-commit gate
- After fixing, consider running `/code-review` again to confirm a clean bill of health
