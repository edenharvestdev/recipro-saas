# ROLLBACK RUNBOOK — S11/S12 RELEASES

This runbook outlines the recovery and rollback procedures in case of critical failures (P0/P1) on the production database or application server.

---

## 1. Application Server Rollback

If a critical code bug or performance regression occurs after deploying the S11/S12 code:
1. Revert to the last stable production commit SHA (`e4c1b7f` or previous stable release commit):
   ```bash
   git checkout <PREV_STABLE_SHA>
   git push origin main --force
   ```
2. Trigger deployment on Railway to build the previous code bundle.
3. Verify server health check status.

---

## 2. Database Recovery Strategies

### 2.1 Controlled Reversal Movements (Preferred)
In case of a stock deduction or conversion error, **do not restore the entire database** if there are new operational customer sales. Use manual corrections with audit trails:
1. To reverse a stock movement, record an offsetting adjustment movement in `stock_movements`.
2. Do not modify stocks directly without an audit reference.

### 2.2 Point-in-Time Recovery (PITR) (Last Resort)
Only use database restore if severe data corruption or tenant leakage is detected, and only when there is minimal live user activity:
1. Identify the exact Timestamp of the PITR backup created before the deployment.
2. In the **Railway Console**, select the **Postgres** service.
3. Use the restore tool to recover the database state to the recorded timestamp.
4. Notify POS clients to re-synchronize local offline databases to prevent data loss.
