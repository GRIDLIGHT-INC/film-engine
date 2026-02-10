---
name: run-tests
description: Run test suites for GridLight
---

# Run Tests

Run comprehensive test suites for GridLight development.

## Steps

1. **Check Test Environment**
   ```bash
   git status --porcelain
   docker ps --format "table {{.Names}}\t{{.Status}}" | grep gridlight || echo "No GridLight services running"
   ```
   Verify the environment is ready for testing.

2. **Run All Tests**
   Execute the main test suite:
   ```bash
   scripts/run_all_tests.sh
   ```

3. **Health Check Tests**
   Test service connectivity:
   ```bash
   curl -sSf http://localhost:8080/healthz && echo "Gateway: OK" || echo "Gateway: FAILED"
   curl -sSf http://localhost:8001/v1/models && echo "Model: OK" || echo "Model: FAILED"
   curl -sSf http://localhost:6333/collections && echo "Qdrant: OK" || echo "Qdrant: FAILED"
   ```

4. **Grid Tests** (if applicable)
   If grid mode is configured:
   ```bash
   if [ -f .env.grid ]; then
       echo "Testing Grid Architecture..."
       curl -s http://localhost:8080/workers/status
   fi
   ```

5. **Load Distribution Tests**
   ```bash
   if [ -f scripts/test-load-distribution.sh ]; then
       chmod +x scripts/test-load-distribution.sh && scripts/test-load-distribution.sh
   fi
   ```

6. **Report Results**
   Summarize:
   - Number of tests passed/failed
   - Any services that are down
   - Recommendations for fixing failures
