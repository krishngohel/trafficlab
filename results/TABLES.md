# Results tables

Source: `results/eval_baselines.csv` (480 episodes over 12 network x demand cells).
Values are the mean across seeds ± the half-width of a 95% Student-t confidence interval (ddof=1). **Bold** marks the best delay per vehicle in each cell.

## arterial6 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **fixed** | **264.1 ± 2.7** | **3973 ± 36** | 10 |
| webster | 309.8 ± 5.4 | 3366 ± 60 | 10 |
| actuated | 390.7 ± 7.7 | 2767 ± 58 | 10 |
| max_pressure | 2993.0 ± 79.2 | 65 ± 12 | 10 |

## arterial6 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **191.0 ± 5.3** | **3522 ± 29** | 10 |
| fixed | 207.7 ± 6.3 | 3402 ± 49 | 10 |
| actuated | 355.1 ± 6.2 | 2322 ± 38 | 10 |
| max_pressure | 2361.5 ± 128.4 | 153 ± 27 | 10 |

## arterial6 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **fixed** | **247.8 ± 6.3** | **3859 ± 55** | 10 |
| webster | 250.3 ± 5.5 | 3736 ± 58 | 10 |
| actuated | 367.2 ± 6.2 | 2580 ± 30 | 10 |
| max_pressure | 2617.4 ± 131.3 | 116 ± 24 | 10 |

## grid2x2 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **269.0 ± 2.6** | **4618 ± 9** | 10 |
| actuated | 281.1 ± 4.3 | 4740 ± 14 | 10 |
| fixed | 301.1 ± 4.7 | 3999 ± 17 | 10 |
| max_pressure | 308.4 ± 3.3 | 4246 ± 20 | 10 |

## grid2x2 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **55.3 ± 0.8** | **2321 ± 24** | 10 |
| fixed | 59.7 ± 0.5 | 2310 ± 21 | 10 |
| webster | 61.8 ± 0.7 | 2308 ± 20 | 10 |
| actuated | 64.6 ± 1.0 | 2301 ± 22 | 10 |

## grid2x2 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **188.7 ± 4.5** | **3887 ± 39** | 10 |
| webster | 212.0 ± 9.3 | 3875 ± 31 | 10 |
| fixed | 239.4 ± 9.9 | 3801 ± 42 | 10 |
| max_pressure | 242.4 ± 7.7 | 3853 ± 19 | 10 |

## grid4x4 / heavy

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **webster** | **380.1 ± 1.7** | **8720 ± 15** | 10 |
| actuated | 390.0 ± 5.1 | 9105 ± 22 | 10 |
| fixed | 396.7 ± 3.3 | 7605 ± 25 | 10 |
| max_pressure | 515.6 ± 5.4 | 7776 ± 28 | 10 |

## grid4x4 / light

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **max_pressure** | **105.4 ± 1.4** | **4552 ± 58** | 10 |
| fixed | 113.2 ± 1.1 | 4558 ± 63 | 10 |
| webster | 120.4 ± 1.5 | 4551 ± 70 | 10 |
| actuated | 126.7 ± 2.5 | 4522 ± 54 | 10 |

## grid4x4 / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **295.0 ± 8.0** | **7564 ± 67** | 10 |
| webster | 318.0 ± 9.0 | 7561 ± 49 | 10 |
| fixed | 341.9 ± 5.5 | 7342 ± 30 | 10 |
| max_pressure | 389.4 ± 6.8 | 7368 ± 24 | 10 |

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
| **max_pressure** | **29.1 ± 0.7** | **1175 ± 22** | 10 |
| webster | 31.2 ± 1.1 | 1175 ± 22 | 10 |
| fixed | 32.4 ± 0.4 | 1174 ± 22 | 10 |
| actuated | 33.5 ± 0.8 | 1174 ± 23 | 10 |

## single / rush

| policy | delay/veh (s) | throughput (veh) | seeds |
| --- | ---: | ---: | ---: |
| **actuated** | **111.7 ± 6.8** | **1954 ± 26** | 10 |
| webster | 143.5 ± 7.8 | 1953 ± 30 | 10 |
| max_pressure | 145.7 ± 11.3 | 1944 ± 42 | 10 |
| fixed | 173.2 ± 12.9 | 1936 ± 30 | 10 |

## Overall

Mean rank across cells (1 = best; tied policies share the average rank).

| policy | mean rank by delay | mean rank by throughput | cells |
| --- | ---: | ---: | ---: |
| webster | 1.92 | 2.08 | 12 |
| actuated | 2.42 | 2.17 | 12 |
| fixed | 2.58 | 2.92 | 12 |
| max_pressure | 3.08 | 2.83 | 12 |
