# School Outbound Cache-Warming Trajectory

Commit: d18bc86 deployed ~2026-04-17 23:00 UTC
Target: coursesMissingCache=0, X-Cache-Layer=d1, <2s for all schools

| Probe | Timestamp (UTC) | Butler | Ivy Tech | Notre Dame | coursesWithCache | coursesMissingCache | Notes |
|-------|-----------------|--------|----------|------------|-----------------|--------------------|----|
| 1 | ~2026-04-18 01:00 | 97s miss | 90s miss | 96s miss | 131 | 1945 | T+~2h, matches baseline tick 1 |
| 2026-04-17 23:28 | 90.4s miss | 96.0s miss | 90.0s miss | 131 (6%) | 1945 | warming
| 2026-04-17 23:32 | 89.2s miss | 96.8s miss | 89.0s miss | 131 (6%) | 1945 | warming
| 2026-04-18 01:37 | ERR | ERR | ERR | 131 (6%) | 1945 | warming
| 2026-04-18 05:07 | 13.4s miss | 10.7s miss | 3.4s unknown | ? (0%) | ? | nearly warm
| 2026-04-18 07:34 | 2.6s miss | 2.7s miss | 1.5s miss | 0 (0%) | 9 | nearly warm
| 2026-04-18 10:17 | 1.5s miss | 2.5s miss | 3.2s miss | 0 (0%) | 9 | nearly warm
| 2026-04-18 12:17 | 2.5s miss | 2.7s miss | 1.7s miss | 0 (0%) | 9 | nearly warm
| 2026-04-18 14:17 | 2.4s miss | 3.1s miss | 1.7s miss | 0 (0%) | 9 | nearly warm
| 2026-04-18 16:17 | 2.3s miss | 3.4s miss | 1.6s miss | 0 (0%) | 9 | nearly warm
| 2026-04-18 18:58 | 2.4s miss | 4.0s miss | 2.1s miss | 0 (0%) | 9 | nearly warm
| 2026-04-18 20:58 | 0.5s d1 | 2.9s miss | 1.4s miss | 0 (0%) | 0 | nearly warm
| 2026-04-18 22:58 | 0.6s d1 | 0.2s d1 | 0.1s d1 | 0 (0%) | 0 | nearly warm
| 2026-04-19 00:58 | 0.5s d1 | 0.1s d1 | 0.2s d1 | 0 (0%) | 0 | nearly warm
| 2026-04-19 02:58 | 0.6s d1 | 0.1s d1 | 0.1s d1 | 0 (0%) | 0 | nearly warm
| 2026-04-19 05:03 | 0.2s d1 | 0.2s d1 | 0.1s d1 | 0 (0%) | 0 | nearly warm
| 2026-04-19 07:24 | 0.6s d1 | 0.1s d1 | 0.1s d1 | 0 (0%) | 0 | nearly warm
