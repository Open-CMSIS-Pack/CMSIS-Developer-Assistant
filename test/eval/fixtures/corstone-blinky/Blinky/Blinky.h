/*
 * Copyright (c) 2018-2023 ARM Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef __BLINKY_H__
#define __BLINKY_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/**
 * \brief Gets number of available LEDs from the device,
 *        then blinks them after each other with a configured
 *        time interval.
 *
  * \param[in] delay_ms  Time interval for the LED blinking
 */
extern int Blinky(uint32_t delay_ms);

extern int stdout_init (void);

#ifdef __cplusplus
}
#endif
#endif /* __BLINKY_H__ */
