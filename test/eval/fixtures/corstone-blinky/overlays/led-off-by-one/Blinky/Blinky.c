/*
 * Copyright (c) 2024 Arm Limited. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Evaluation overlay of the BSP Blinky example: one bug is planted for an AI
 * agent to find with the CMSIS Developer Assistant. Do not add comments that
 * give it away in the source the agent reads.
 */

#include "Blinky.h"
#include "led_port.h"
#include "timeout.h"
#include <cmsis_compiler.h>
#include <stdio.h>

static struct timeout_t timeout = {false, NULL};

__NO_RETURN static void led_runner(unsigned int led_port_bit_length);

static void led_runner(unsigned int led_port_bit_length)
{
    const unsigned int led_port_value_max = 1 << led_port_bit_length;
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
            timeout_init(&timeout, 100);
        }
    }
}

__NO_RETURN int Blinky(uint32_t delay_ms)
{
    const unsigned int led_port_bit_length = get_led_port_bit_length();

    stdout_init();
    printf("\r\n= Blinky is running =\r\n");

    led_port_init();
    timeout_init(&timeout, delay_ms);

    led_runner(led_port_bit_length);
}
