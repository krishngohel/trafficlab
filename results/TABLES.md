# Results tables

Source: `results/eval_final.csv` (530 episodes over 12 network x demand cells).
Values are the mean across seeds ± the half-width of a 95% Student-t confidence interval (ddof=1). **Bold** marks the best delay per vehicle in each cell.

## arterial6 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **191.7 ± 1.7** | **5865 ± 9** | 10 |
| fixed | 218.2 ± 0.8 | 4858 ± 12 | 10 |
| webster | 235.8 ± 6.8 | 5704 ± 29 | 10 |
| max_pressure | 324.8 ± 3.1 | 3984 ± 23 | 10 |

## arterial6 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **67.6 ± 2.4** | **4064 ± 56** | 10 |
| actuated | 67.9 ± 1.6 | 4073 ± 57 | 10 |
| fixed | 80.7 ± 2.9 | 4048 ± 57 | 10 |
| webster | 83.6 ± 4.2 | 4040 ± 63 | 10 |

## arterial6 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **169.8 ± 2.2** | **5652 ± 26** | 10 |
| fixed | 209.3 ± 1.6 | 4781 ± 13 | 10 |
| webster | 225.0 ± 6.9 | 5608 ± 33 | 10 |
| max_pressure | 267.5 ± 2.0 | 4250 ± 22 | 10 |

## grid2x2 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **267.8 ± 2.6** | **4614 ± 15** | 10 |
| actuated | 279.8 ± 3.8 | 4747 ± 5 | 10 |
| fixed | 297.4 ± 3.6 | 4002 ± 11 | 10 |
| max_pressure | 309.4 ± 3.4 | 4233 ± 25 | 10 |

## grid2x2 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **54.6 ± 0.7** | **2312 ± 21** | 10 |
| fixed | 59.5 ± 0.8 | 2323 ± 28 | 10 |
| webster | 61.6 ± 1.2 | 2318 ± 24 | 10 |
| actuated | 65.5 ± 1.2 | 2304 ± 32 | 10 |

## grid2x2 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **191.4 ± 8.3** | **3900 ± 49** | 10 |
| webster | 207.9 ± 6.4 | 3855 ± 35 | 10 |
| ippo-queue s0 | 244.1 ± 9.8 | 3771 ± 27 | 10 |
| max_pressure | 244.4 ± 6.9 | 3846 ± 37 | 10 |
| fixed | 247.4 ± 9.4 | 3821 ± 28 | 10 |
| gat-queue s1 | 269.0 ± 6.8 | 3821 ± 27 | 10 |
| dqn-queue s0 | 274.9 ± 11.9 | 3577 ± 88 | 10 |

## grid4x4 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **382.5 ± 3.3** | **8711 ± 26** | 10 |
| actuated | 389.6 ± 8.6 | 9103 ± 45 | 10 |
| fixed | 395.8 ± 3.9 | 7610 ± 24 | 10 |
| max_pressure | 515.7 ± 6.5 | 7762 ± 31 | 10 |

## grid4x4 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **105.5 ± 1.3** | **4566 ± 56** | 10 |
| fixed | 113.6 ± 0.8 | 4550 ± 46 | 10 |
| webster | 119.8 ± 1.3 | 4536 ± 62 | 10 |
| actuated | 126.8 ± 2.1 | 4542 ± 70 | 10 |

## grid4x4 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **294.3 ± 9.4** | **7582 ± 35** | 10 |
| webster | 322.3 ± 5.9 | 7552 ± 34 | 10 |
| fixed | 346.5 ± 6.1 | 7357 ± 23 | 10 |
| max_pressure | 382.0 ± 11.4 | 7336 ± 40 | 10 |

## single / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **185.3 ± 1.3** | **2466 ± 8** | 10 |
| webster | 192.9 ± 0.9 | 2383 ± 7 | 10 |
| max_pressure | 202.5 ± 2.2 | 2262 ± 18 | 10 |
| fixed | 228.4 ± 1.5 | 2066 ± 6 | 10 |

## single / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **29.0 ± 0.7** | **1175 ± 22** | 10 |
| webster | 31.2 ± 1.1 | 1174 ± 22 | 10 |
| fixed | 32.4 ± 0.4 | 1174 ± 22 | 10 |
| actuated | 33.5 ± 0.8 | 1174 ± 23 | 10 |

## single / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **111.1 ± 7.6** | **1941 ± 32** | 10 |
| dqn-pressure s0 | 118.5 ± 4.3 | 1922 ± 46 | 10 |
| dqn-queue s0 | 126.2 ± 6.1 | 1927 ± 28 | 10 |
| webster | 143.0 ± 6.5 | 1934 ± 28 | 10 |
| max_pressure | 147.9 ± 8.3 | 1974 ± 27 | 10 |
| fixed | 171.2 ± 10.8 | 1928 ± 26 | 10 |

## Overall

Mean rank across cells (1 = best; tied policies share the average rank).

| policy | mean rank by delay | mean rank by throughput | cells |
| --- | ---: | ---: | ---: |
| actuated | 2.00 | 1.67 | 12 |
| dqn-pressure s0 | 2.00 | 6.00 | 1 |
| webster | 2.50 | 2.42 | 12 |
| ippo-queue s0 | 3.00 | 6.00 | 1 |
| max_pressure | 3.00 | 2.67 | 12 |
| fixed | 3.17 | 3.33 | 12 |
| dqn-queue s0 | 5.00 | 6.00 | 2 |
| gat-queue s1 | 6.00 | 4.00 | 1 |
