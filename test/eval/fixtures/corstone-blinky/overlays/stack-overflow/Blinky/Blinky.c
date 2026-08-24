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

/* Recursive descent parser for the LED pattern string. */
static unsigned int pattern_value(const char *pattern, unsigned int depth)
{
    char scratch[64];
    scratch[0] = pattern[0];
    if (pattern[0] == '\0') {
        return depth;
    }
    return pattern_value(pattern[1] == '*' ? pattern : pattern + 1, depth + 1) + (scratch[0] == '1');
}

__NO_RETURN int Blinky(uint32_t delay_ms)
{
    unsigned int led_state = 1;

    stdout_init();
    printf("\r\n= Blinky is running =\r\n");

    /* Guard the main stack: 2 KB below the current pointer. */
    __set_MSPLIM(__get_MSP() - 2048u);

    led_port_init();
    timeout_init(&timeout, delay_ms);

    for (;;) {
        if (timeout_delay_is_elapsed(&timeout)) {
            led_state ^= 1;
            set_led_port(led_state & pattern_value("10*", 0));
            timeout_init(&timeout, delay_ms);
        }
    }
}
