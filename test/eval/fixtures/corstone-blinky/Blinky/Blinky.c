/*
 * Copyright (c) 2017-2023 ARM Limited
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

#include "Blinky.h"
#include "led_port.h"
#include "timeout.h"
#include <cmsis_compiler.h>
#include <stdio.h>

static struct timeout_t timeout = {false, NULL};

__NO_RETURN static void led_blink(void);
__NO_RETURN static void led_runner(unsigned int led_port_bit_length);

/**
 * \brief Run LED light on available LEDs by switching 1 LED on
 *        one after one in one direction, then backwards and
 *        start again.
 *
 * \param[in] led_port_bit_length Bit length of the LED port.
 */
static void led_runner(unsigned int led_port_bit_length)
{
    const unsigned int led_port_value_max = 1 << (led_port_bit_length - 1);
    const unsigned int led_port_value_min = 1;
    unsigned int led_port_value = led_port_value_min;
    unsigned int direction = 0;
    for (;;) {
        if (timeout_delay_is_elapsed(&timeout)) {
            set_led_port(led_port_value);
            if (direction) {
                if (led_port_value > led_port_value_min) {
                    led_port_value = led_port_value >> 1;
                } else {
                    direction = 0;
                    led_port_value = led_port_value << 1;
                }
            } else {
                if (led_port_value < led_port_value_max) {
                    led_port_value = led_port_value << 1;
                } else {
                    direction = 1;
                    led_port_value = led_port_value >> 1;
                }
            }
        }
    }
}


/**
 * \brief Blink one LED.
 */
static void led_blink(void)
{
    unsigned int led_state = 1;

    for (;;) {
        if (timeout_delay_is_elapsed(&timeout)) {
            led_state ^= 1;
            set_led_port(led_state);
        }
    }

}

__NO_RETURN int Blinky(uint32_t delay_ms)
{
    const unsigned int led_port_bit_length = get_led_port_bit_length();

    stdout_init();
    printf("\r\n= Blinky is running =\r\n");
    printf("LED timer interval is set to 1s\r\n");

    led_port_init();

    /* Initialize timeout structure */
    timeout_init(&timeout, delay_ms);

    if (led_port_bit_length > 1) {
        led_runner(led_port_bit_length);
    } else {
        led_blink();
    }
}
