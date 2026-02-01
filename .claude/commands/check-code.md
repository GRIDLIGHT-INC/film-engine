---
name: check-code
description: Check for linting issues, improvements, and bugs
---

# Check Code Quality

Run linting, formatting, and code quality checks across the codebase.

## Backend (Rust)

### Format Check

```bash
cd backend
cargo fmt --check
```

### Apply Formatting

```bash
cd backend
cargo fmt
```

### Lint with Clippy

```bash
cd backend
SQLX_OFFLINE=true cargo clippy -- -D warnings
```

### Clippy with More Suggestions

```bash
cd backend
SQLX_OFFLINE=true cargo clippy -- -W clippy::pedantic
```

## Frontend (TypeScript/React)

### ESLint Check

```bash
cd frontend
npm run lint
```

### Fix Auto-fixable Issues

```bash
cd frontend
npm run lint -- --fix
```

### Type Check

```bash
cd frontend
npx tsc --noEmit
```

## Full Code Check

Run all checks:

```bash
# Backend
cd backend
cargo fmt --check
SQLX_OFFLINE=true cargo clippy -- -D warnings

# Frontend
cd frontend
npm run lint
npx tsc --noEmit
```

## Common Issues

### Unused Imports
```bash
# Rust - Clippy will catch these
cargo clippy -- -W unused-imports

# TypeScript - ESLint catches these
npm run lint
```

### Security Audit

```bash
# Rust dependencies
cd backend
cargo audit

# npm dependencies
cd frontend
npm audit
```
