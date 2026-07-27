# Results tables

Source: `results/eval_final.csv` (720 episodes over 12 network x demand cells).
Values are the mean across seeds ± the half-width of a 95% Student-t confidence interval (ddof=1). **Bold** marks the best delay per vehicle in each cell.

## arterial6 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **191.9 ± 1.5** | **5869 ± 14** | 10 |
| fixed | 218.9 ± 1.4 | 4864 ± 13 | 10 |
| webster | 228.8 ± 5.6 | 5737 ± 25 | 10 |
| max_pressure | 323.5 ± 3.9 | 3998 ± 34 | 10 |

## arterial6 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **67.6 ± 1.6** | **4064 ± 48** | 10 |
| max_pressure | 68.4 ± 4.6 | 4049 ± 41 | 10 |
| fixed | 81.0 ± 3.3 | 4028 ± 49 | 10 |
| webster | 83.4 ± 4.2 | 4038 ± 56 | 10 |

## arterial6 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **170.0 ± 1.5** | **5656 ± 16** | 10 |
| fixed | 209.3 ± 1.3 | 4777 ± 12 | 10 |
| webster | 228.1 ± 9.4 | 5588 ± 40 | 10 |
| max_pressure | 266.7 ± 3.1 | 4266 ± 30 | 10 |

## grid2x2 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **268.8 ± 2.9** | **4619 ± 13** | 10 |
| actuated | 280.6 ± 4.6 | 4748 ± 21 | 10 |
| fixed | 295.5 ± 2.7 | 4005 ± 6 | 10 |
| max_pressure | 306.2 ± 4.0 | 4245 ± 14 | 10 |

## grid2x2 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **54.7 ± 0.9** | **2315 ± 22** | 10 |
| fixed | 59.2 ± 0.7 | 2310 ± 21 | 10 |
| webster | 61.9 ± 0.6 | 2316 ± 20 | 10 |
| actuated | 65.5 ± 0.8 | 2304 ± 31 | 10 |
| dqn-queue (s1) | 70.5 ± 1.1 | 2304 ± 33 | 10 |
| ippo-queue (s1) | 73.0 ± 0.7 | 2312 ± 21 | 10 |
| dqn-queue (s0) | 74.3 ± 1.3 | 2307 ± 25 | 10 |
| ippo-queue (s0) | 89.2 ± 1.3 | 2287 ± 24 | 10 |
| gat-queue (s1) | 110.3 ± 2.0 | 2281 ± 32 | 10 |
| gat-queue (s0) | 155.6 ± 3.1 | 2237 ± 30 | 10 |

## grid2x2 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **189.3 ± 7.2** | **3884 ± 40** | 10 |
| webster | 207.3 ± 8.3 | 3876 ± 43 | 10 |
| ippo-queue (s0) | 227.9 ± 9.7 | 3798 ± 31 | 10 |
| max_pressure | 235.4 ± 8.2 | 3852 ± 35 | 10 |
| fixed | 247.4 ± 10.7 | 3827 ± 25 | 10 |
| gat-queue (s1) | 257.1 ± 12.6 | 3816 ± 26 | 10 |
| ippo-queue (s1) | 261.6 ± 12.1 | 3812 ± 17 | 10 |
| dqn-queue (s0) | 266.6 ± 11.2 | 3613 ± 44 | 10 |
| dqn-queue (s1) | 283.2 ± 15.8 | 3204 ± 139 | 10 |
| gat-queue (s0) | 299.6 ± 7.0 | 3811 ± 27 | 10 |

## grid4x4 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **382.9 ± 3.8** | **8711 ± 20** | 10 |
| actuated | 386.4 ± 4.8 | 9121 ± 19 | 10 |
| fixed | 396.0 ± 5.0 | 7605 ± 22 | 10 |
| max_pressure | 515.7 ± 4.7 | 7805 ± 17 | 10 |

## grid4x4 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **105.7 ± 1.0** | **4542 ± 56** | 10 |
| fixed | 113.4 ± 0.8 | 4558 ± 64 | 10 |
| webster | 118.9 ± 0.6 | 4551 ± 65 | 10 |
| actuated | 126.8 ± 2.8 | 4497 ± 75 | 10 |

## grid4x4 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **293.7 ± 8.3** | **7580 ± 62** | 10 |
| webster | 313.7 ± 7.1 | 7518 ± 21 | 10 |
| fixed | 342.5 ± 9.3 | 7352 ± 27 | 10 |
| max_pressure | 378.2 ± 10.5 | 7361 ± 34 | 10 |

## single / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **185.8 ± 1.4** | **2461 ± 10** | 10 |
| webster | 192.5 ± 1.0 | 2388 ± 8 | 10 |
| max_pressure | 201.8 ± 2.2 | 2270 ± 15 | 10 |
| fixed | 228.8 ± 1.3 | 2063 ± 7 | 10 |

## single / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **29.1 ± 0.8** | **1175 ± 22** | 10 |
| webster | 31.2 ± 1.1 | 1175 ± 22 | 10 |
| fixed | 32.4 ± 0.4 | 1174 ± 22 | 10 |
| dqn-queue (s0) | 33.2 ± 0.7 | 1171 ± 22 | 10 |
| actuated | 33.5 ± 0.8 | 1174 ± 23 | 10 |
| dqn-queue (s1) | 35.1 ± 0.7 | 1173 ± 22 | 10 |
| dqn-pressure (s1) | 45.1 ± 1.3 | 1169 ± 24 | 10 |
| dqn-pressure (s0) | 45.5 ± 1.1 | 1167 ± 24 | 10 |
| ippo-queue (s1) | 127.4 ± 3.3 | 1129 ± 22 | 10 |
| ippo-queue (s0) | 127.4 ± 3.3 | 1129 ± 22 | 10 |

## single / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **111.7 ± 6.8** | **1954 ± 26** | 10 |
| dqn-pressure (s0) | 112.5 ± 7.2 | 1956 ± 27 | 10 |
| dqn-queue (s0) | 126.2 ± 3.0 | 1953 ± 30 | 10 |
| dqn-pressure (s1) | 127.0 ± 2.7 | 1925 ± 6 | 10 |
| dqn-queue (s1) | 131.8 ± 3.9 | 1936 ± 13 | 10 |
| webster | 143.5 ± 7.8 | 1953 ± 30 | 10 |
| max_pressure | 145.7 ± 11.3 | 1944 ± 42 | 10 |
| fixed | 173.2 ± 12.9 | 1936 ± 30 | 10 |
| ippo-queue (s1) | 187.7 ± 5.3 | 1734 ± 34 | 10 |
| ippo-queue (s0) | 301.1 ± 7.7 | 1094 ± 32 | 10 |

## Overall

Mean rank across cells (1 = best; tied policies share the average rank).

| policy | mean rank by delay | mean rank by throughput | cells |
| --- | ---: | ---: | ---: |
| actuated | 2.00 | 1.92 | 12 |
| webster | 2.67 | 2.08 | 12 |
| max_pressure | 3.25 | 3.00 | 12 |
| fixed | 3.33 | 3.75 | 12 |
| dqn-pressure (s0) | 5.00 | 4.50 | 2 |
| dqn-pressure (s1) | 5.50 | 7.50 | 2 |
| dqn-queue (s0) | 5.50 | 6.00 | 4 |
| dqn-queue (s1) | 6.25 | 7.25 | 4 |
| gat-queue (s1) | 7.50 | 7.00 | 2 |
| ippo-queue (s0) | 7.75 | 9.00 | 4 |
| ippo-queue (s1) | 7.75 | 6.75 | 4 |
| gat-queue (s0) | 10.00 | 8.50 | 2 |
