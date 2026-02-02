---
name: security-review
description: Run security analysis on changed or specified files
---

# Security Review

Perform a comprehensive security review of the codebase or specific files.

## Steps

1. **Identify Scope**
   Determine what to review:
   - If files are specified as arguments, review those files
   - Otherwise, review files changed in the current branch vs dev:
   ```bash
   git diff --name-only origin/dev...HEAD
   ```

2. **Check for Secrets and Credentials**
   Search for potential secrets, API keys, passwords, tokens:
   - Hardcoded passwords or API keys
   - AWS/GCP/Azure credentials
   - Private keys or certificates
   - Connection strings with credentials
   - JWT secrets

3. **Check for OWASP Top 10 Vulnerabilities**
   Review code for:
   - **Injection**: SQL injection, command injection, code injection
   - **Broken Authentication**: Weak password handling, session issues
   - **Sensitive Data Exposure**: Unencrypted sensitive data, logging PII
   - **XML External Entities (XXE)**: Unsafe XML parsing
   - **Broken Access Control**: Missing authorization checks
   - **Security Misconfiguration**: Debug modes, default credentials
   - **XSS**: Unsanitized user input in output
   - **Insecure Deserialization**: Unsafe deserialization of untrusted data
   - **Using Components with Known Vulnerabilities**: Outdated dependencies
   - **Insufficient Logging**: Missing audit trails for security events

4. **Language-Specific Checks**

   **Rust:**
   - Unsafe blocks without justification
   - Unchecked `.unwrap()` on user input
   - Path traversal vulnerabilities
   - TOCTOU race conditions

   **JavaScript/TypeScript:**
   - `eval()` or `Function()` usage
   - `dangerouslySetInnerHTML` without sanitization
   - Prototype pollution risks
   - Regex DoS (ReDoS) patterns

   **Python:**
   - `eval()`, `exec()`, `pickle.loads()` on untrusted data
   - SQL string concatenation
   - `subprocess` with `shell=True`
   - Insecure temp file creation

   **Shell Scripts:**
   - Unquoted variables
   - Command injection via user input
   - Insecure use of `eval`
   - World-writable files

5. **Report Findings**
   Provide a summary with:
   - **Critical**: Issues that must be fixed before deployment
   - **High**: Significant security risks
   - **Medium**: Potential vulnerabilities worth addressing
   - **Low**: Minor issues or best practice suggestions
   - **Info**: Security observations and recommendations

   For each finding, include:
   - File and line number
   - Description of the issue
   - Recommended fix
