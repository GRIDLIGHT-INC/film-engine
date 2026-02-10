---
name: diagnose
description: Run system diagnostics for GridLight
---

# Diagnose

Run comprehensive system diagnostics for GridLight.

## Steps

1. **System Information**
   ```bash
   echo "=== System Info ==="
   uname -a
   echo ""
   echo "=== Memory ==="
   free -h 2>/dev/null || vm_stat 2>/dev/null || echo "Memory info unavailable"
   echo ""
   echo "=== Disk ==="
   df -h . 2>/dev/null || echo "Disk info unavailable"
   ```

2. **Docker Status**
   ```bash
   echo "=== Docker Status ==="
   docker --version
   docker compose version
   docker ps -a --filter "name=gridlight" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
   ```

3. **Service Health**
   ```bash
   echo "=== Service Health ==="
   curl -s http://localhost:8080/healthz || echo "Gateway: Not responding"
   curl -s http://localhost:8080/debug/status | jq . 2>/dev/null || echo "Debug status unavailable"
   ```

4. **Port Conflicts**
   ```bash
   echo "=== Port Usage ==="
   lsof -i :8080 2>/dev/null | head -5 || netstat -an | grep 8080 || echo "Port 8080 check unavailable"
   lsof -i :6333 2>/dev/null | head -5 || echo "Port 6333 check unavailable"
   ```

5. **Log Analysis**
   ```bash
   echo "=== Recent Errors ==="
   docker logs gridlight-gateway --tail 50 2>&1 | grep -iE "(error|panic|fatal)" | tail -10 || echo "No recent errors"
   ```

6. **License Status**
   ```bash
   echo "=== License ==="
   GATEWAY_TOKEN=$(grep "^GATEWAY_TOKEN=" .env 2>/dev/null | cut -d'=' -f2 || echo "dev-token")
   curl -s -H "Authorization: Bearer $GATEWAY_TOKEN" http://localhost:8080/license/status | jq . 2>/dev/null || echo "License status unavailable"
   ```

7. **Report Summary**
   Provide a summary of:
   - Overall system health
   - Any issues detected
   - Recommended actions
